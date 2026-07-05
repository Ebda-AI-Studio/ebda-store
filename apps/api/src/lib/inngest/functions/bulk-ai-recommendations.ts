import type { InngestFunction } from 'inngest';
import { Prisma, prisma, withMoneyTx } from '@force/database';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { parseAiJson } from '../../ai/parse-ai-json';
import { rethrowAsAppError } from '../../ai/gemini-errors';
import { recordUsage } from '../../../services/ai.service';
import { AppError } from '../../../middleware/error-handler';

const AI_UNAVAILABLE_MESSAGE = 'AI request failed — please try again shortly.';

/**
 * Catalogue-wide AI product recommendations sweep.
 *
 * For every active product in the store, asks Gemini to pick the top
 * RECS_PER_PRODUCT complementary products from the catalogue (cross-sell,
 * not substitutes). Writes results to the `ai_recommendation` table which
 * the recommendation service queries as the second priority after manual
 * cross-sells and before FBT co-occurrence data.
 *
 * Priority in recommendation.service.ts:
 *   manual cross-sells > AI recommendations > FBT
 *
 * Re-sweep semantics:
 *   - Default: smart-skip products that already have AI recs in
 *     `ai_recommendation`. Only newly-added products without recs get a
 *     Gemini call. Preserves prior recs + saves quota.
 *   - `force: true` in the event payload: bypass smart-skip and process
 *     every product. Each per-product transaction deletes the prior
 *     recs then inserts the freshly-generated ones, so re-running with
 *     force fully replaces stale picks.
 *   - Cooperative cancellation: the per-product loop polls
 *     `bulk_ai_jobs.status` every 5 items and exits cleanly if a
 *     merchant clicks Cancel.
 *
 * Mirrors the pattern of bulk-ai-seo / bulk-ai-translate / bulk-ai-aeo:
 *   - concurrency key on storeId (one sweep per store at a time)
 *   - retries: 2 (per feedback-bulk-ai-transient-retry: ≥2 mandatory)
 *   - throttle at AI_BULK_THROTTLE_MS (default 2500ms — ~24 RPM)
 *   - quota check before each call via assertAiQuota
 *   - error cap at 50 so no single run bloats the BulkAiJob row
 *   - quota errors re-thrown cleanly (not silenced)
 */

const ERROR_CAP = 50;
const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
// How many complementary products to keep per source product.
const RECS_PER_PRODUCT = 5;
// Upper bound on the candidate list we pass to Gemini per call. Keeping
// this below ~60 items produces more focused context and faster responses.
const CANDIDATE_SLICE = 50;

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getGenAI(): GoogleGenerativeAI {
  if (!config.googleAiKey) {
    throw new Error('AI_NOT_CONFIGURED: GOOGLE_GENERATIVE_AI_KEY missing');
  }
  return new GoogleGenerativeAI(config.googleAiKey);
}

// How many of the strongest co-purchase pairs to load per product as a
// frequently-bought-together signal for the prompt. Keeping this small
// keeps the prompt focused — these are HARD signals (real orders), so
// even 3-5 is enough to anchor Gemini toward genuine complements.
const FBT_PAIRS_PER_PRODUCT = 6;
// Only count co-purchases observed in the last N days so the signal
// reflects the store's CURRENT catalogue behaviour, not stale history.
const FBT_WINDOW_DAYS = 180;

/**
 * Compute the strongest frequently-bought-together (FBT) pairs for the
 * store from real order history. Self-joins `order_items` within the same
 * order so each row is a co-occurrence of two DISTINCT products in one
 * order, counts how many orders contain each unordered pair, and returns
 * a map keyed by source productId → ranked list of co-bought productIds.
 *
 * This is genuine co-purchase signal (what customers ACTUALLY buy
 * together), distinct from catalogue similarity. We feed the top
 * FBT_PAIRS_PER_PRODUCT per product into the Gemini prompt so the model
 * prioritises real complements over merely-similar products.
 *
 * Scoped to the store + non-cancelled/refunded orders + the FBT window.
 * Returns an empty map for stores with no qualifying order history — the
 * sweep then falls back to catalogue-only reasoning (prior behaviour).
 */
async function computeCoPurchasePairs(
  storeId: string
): Promise<Map<string, Array<{ productId: string; coOrders: number }>>> {
  const since = new Date(Date.now() - FBT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // a.product_id < b.product_id makes each unordered pair appear once;
  // we expand to both directions in JS below so either product can be the
  // source. COUNT(DISTINCT o.id) so multiple lines of the same product in
  // one order don't inflate the pair count.
  const rows = await prisma.$queryRaw<Array<{ a_id: string; b_id: string; co_orders: bigint }>>(
    Prisma.sql`
      SELECT a.product_id AS a_id,
             b.product_id AS b_id,
             COUNT(DISTINCT o.id) AS co_orders
      FROM order_items a
      JOIN order_items b
        ON a.order_id = b.order_id
       AND a.product_id < b.product_id
      JOIN orders o ON o.id = a.order_id
      WHERE o.store_id = ${storeId}
        AND o.created_at >= ${since}
        AND o.status NOT IN ('cancelled', 'refunded')
      GROUP BY a.product_id, b.product_id
      HAVING COUNT(DISTINCT o.id) >= 1
      ORDER BY co_orders DESC
      LIMIT 2000
    `
  );

  const map = new Map<string, Array<{ productId: string; coOrders: number }>>();
  const push = (src: string, tgt: string, n: number) => {
    const list = map.get(src) ?? [];
    list.push({ productId: tgt, coOrders: n });
    map.set(src, list);
  };
  for (const r of rows) {
    const n = Number(r.co_orders);
    // Expand to both directions so each product sees its co-bought set.
    push(r.a_id, r.b_id, n);
    push(r.b_id, r.a_id, n);
  }
  // Keep only the strongest pairs per product (already globally sorted, so
  // re-sort each bucket then trim).
  for (const [src, list] of map) {
    list.sort((x, y) => y.coOrders - x.coOrders);
    map.set(src, list.slice(0, FBT_PAIRS_PER_PRODUCT));
  }
  return map;
}

interface LlmRec {
  productId: string;
  score?: number;
  reason?: string;
}

export const bulkAiRecommendations: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-recommendations',
    name: 'Bulk: generate AI product recommendations across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/recommendations-requested' }],
  },
  async ({ event, step }) => {
    const {
      jobId,
      storeId,
      force = false,
    } = event.data as {
      jobId: string;
      storeId: string;
      force?: boolean;
    };

    if (!jobId || !storeId) {
      logger.warn('bulk-ai/recommendations-requested fired without ids');
      return;
    }

    return async () => {
      // Flip the job to 'running' as the very first step BEFORE any heavy
      // load. Two reasons: (a) the queue-depth watcher can distinguish
      // "Inngest never delivered the event" (status stays 'queued' for
      // >30min → alert) from "delivered but stuck on Gemini" (status
      // 'running' >30min → different alert path); (b) the UI shows
      // immediate feedback so the merchant doesn't think nothing's
      // happening while products + categories load. Wrapped in step.run
      // so Inngest persists the transition independently from subsequent
      // failures — a Gemini error doesn't roll back this update.
      await step.run('mark-running', () =>
        prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { status: 'running', startedAt: new Date() },
        })
      );

      const errors: Array<{
        entityKind: string;
        entityId: string;
        entityName: string;
        error: string;
      }> = [];
      let filled = 0;
      let skipped = 0;
      let failed = 0;
      let quotaReached = false;

      try {
        // Load all active products up-front. The full list is used to:
        //   a)() set BulkAiJob.total so the progress bar is accurate
        //   b) build the candidate index we pass to Gemini
        const products = await prisma.product.findMany({
          where: { storeId, status: 'active', deletedAt: null },
          select: {
            id: true,
            name: true,
            description: true,
            // Use the ProductCategory join table to get category names.
            // A product may belong to multiple categories; we use the first
            // for the catalog index summary passed to Gemini.
            categories: {
              include: { category: { select: { name: true } } },
              take: 1,
            },
          },
        });

        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { total: products.length },
        });

        if (products.length < 2) {
          // Nothing useful to recommend from a 0- or 1-product catalogue.
          await prisma.bulkAiJob.update({
            where: { id: jobId },
            data: {
              status: 'completed',
              completedAt: new Date(),
              processed: products.length,
              filled: 0,
              skipped: products.length,
              failed: 0,
            },
          });
          logger.info({ jobId, storeId }, 'bulk-ai-recommendations: catalog too small, skipped');
          return;
        }

        // Pre-build a compact catalog index. Passed as JSON context so Gemini
        // can pick valid IDs. We cap at CANDIDATE_SLICE per call to keep
        // prompt sizes reasonable and reduce hallucinated IDs.
        const catalogIndex = products.map(p => ({
          id: p.id,
          name: p.name,
          // A product may sit in multiple categories; take the first for the
          // summary label we pass to Gemini.
          category: p.categories[0]?.category.name ?? null,
        }));

        // Smart-skip — pre-fetch the set of product IDs that already have AI
        // recommendations in this store. Re-running the sweep should be
        // incremental: products with existing recs are left alone (saves
        // Gemini quota + preserves prior recs verbatim). Products without
        // any recs get processed. A merchant who wants to fully regenerate
        // can clear ai_recommendation rows for the store and re-run.
        const existingRecRows = await prisma.aiRecommendation.findMany({
          where: { storeId },
          select: { sourceProductId: true },
          distinct: ['sourceProductId'],
        });
        const productsWithRecs = new Set(existingRecRows.map(r => r.sourceProductId));

        // Frequently-bought-together signal from real order history. Passed
        // into each product's prompt so Gemini prioritises genuine
        // complements (products actually bought together) over merely-similar
        // catalogue items. Empty map for stores with no order history → the
        // prompt falls back to catalogue-only reasoning.
        const nameById = new Map(catalogIndex.map(c => [c.id, c.name] as const));
        let coPurchase: Map<string, Array<{ productId: string; coOrders: number }>>;
        try {
          coPurchase = await computeCoPurchasePairs(storeId);
        } catch (err) {
          // FBT is an enhancement, not a hard dependency — never fail the
          // sweep because the co-purchase query had a problem.
          logger.warn(
            { jobId, storeId, err: err instanceof Error ? err.message : String(err) },
            'bulk-ai-recommendations: co-purchase signal unavailable, falling back to catalogue-only'
          );
          coPurchase = new Map();
        }

        logger.info(
          {
            jobId,
            storeId,
            totalProducts: products.length,
            alreadyHaveRecs: productsWithRecs.size,
            toProcess: products.length - productsWithRecs.size,
            productsWithCoPurchaseSignal: coPurchase.size,
          },
          'bulk-ai-recommendations: pre-sweep state'
        );

        const genAI = getGenAI();
        const model = genAI.getGenerativeModel({
          model: MODEL,
          generationConfig: { responseMimeType: 'application/json' },
        });

        let processed = 0;

        for (const product of products) {
          // Cooperative cancellation — check every 5 items whether the
          // merchant clicked Cancel. If so, break out cleanly.
          if (processed % 5 === 0 && processed > 0) {
            const currentJob = await prisma.bulkAiJob.findUnique({
              where: { id: jobId },
              select: { status: true },
            });
            if (currentJob?.status === 'cancelled') {
              logger.info(
                { jobId, storeId, processed, filled, skipped, failed },
                'bulk-ai-recommendations: cancelled by merchant'
              );
              break;
            }
          }

          // Skip products that already have AI recs from a prior sweep.
          // When force=true, bypass the skip so every product gets fresh recs.
          // Counts toward `skipped` in the job summary, NOT `failed`, so
          // re-runs report cleanly: e.g. "230 skipped, 1 filled" when the
          // merchant fixes the one product that failed last time.
          if (!force && productsWithRecs.has(product.id)) {
            skipped++;
            processed++;
            if (processed % 25 === 0 || processed === products.length) {
              await prisma.bulkAiJob.update({
                where: { id: jobId },
                data: { processed, filled, skipped, failed, errors: errors as object },
              });
            }
            continue;
          }

          try {
            await assertAiQuota();

            const desc = (product.description ?? '').slice(0, 300);
            const candidates = catalogIndex
              .filter(c => c.id !== product.id)
              .slice(0, CANDIDATE_SLICE);

            const productCategory = product.categories[0]?.category.name ?? null;

            // Frequently-bought-together signal — the products customers have
            // ACTUALLY ordered alongside this one, ranked by co-order count.
            // This is the strongest available complement signal; the prompt
            // instructs Gemini to prioritise it.
            const fbt = (coPurchase.get(product.id) ?? [])
              .filter(p => nameById.has(p.productId))
              .map(p => ({
                productId: p.productId,
                name: nameById.get(p.productId)!,
                coOrders: p.coOrders,
              }));
            const fbtBlock =
              fbt.length > 0
                ? `\nFrequently bought together (REAL co-purchase data — customers ordered these in the SAME order as the source product; higher coOrders = stronger signal). Prioritise these when they fit as complements:\n${JSON.stringify(
                    fbt
                  )}\n`
                : '';

            const prompt = `You recommend complementary products for an e-commerce store. Pick the ${RECS_PER_PRODUCT} catalog products that are most likely to be bought TOGETHER with the source product (genuine cross-sells / bundles / accessories — NOT substitutes or near-duplicates).

Ranking priority:
1. Products in the "Frequently bought together" list below — these are real co-purchases and should rank highest when they make sense as complements.
2. Genuine complements that pair with the source product's use (accessories, consumables, items completing a set/recipe/outfit).
3. Avoid substitutes (another item that REPLACES the source) and avoid near-identical products.

Output ONLY a JSON array, no prose.

Source product:
  id: ${product.id}
  name: ${product.name}
  category: ${productCategory ?? '—'}
  description: ${desc || '—'}
${fbtBlock}
Candidate catalog (pick IDs only from this list):
${JSON.stringify(candidates)}

Output schema: [{"productId":"<id from candidate list>","score":0.0,"reason":"<one sentence — mention if it's frequently bought together>"}]

Return exactly ${Math.min(
              RECS_PER_PRODUCT,
              candidates.length
            )} items sorted by descending score (strongest complement first).`;

            const result = await callWithRetry(
              () => model.generateContent(prompt),
              `recommendations:${product.id}`
            ).catch((err: unknown) => rethrowAsAppError(err, 'AI recommendations sweep failed'));
            const usage = result.response.usageMetadata;
            await recordUsage(
              storeId,
              'recommendations',
              usage?.promptTokenCount ?? 0,
              usage?.candidatesTokenCount ?? 0,
              false
            );
            const raw = result.response.text();
            let parsed: LlmRec[];

            try {
              // parseAiJson applies the outermost-JSON-span slice (strips any
              // leading/trailing prose Gemini adds) + control-char sanitising
              // before JSON.parse. See feedback-gemini-json-response-extra-text.
              parsed = parseAiJson<LlmRec[]>(raw);
            } catch {
              throw new Error('LLM returned unparseable JSON');
            }

            if (!Array.isArray(parsed)) {
              throw new Error('LLM response is not a JSON array');
            }

            // Validate picks — Gemini occasionally hallucinates IDs that
            // don't exist in the catalog. Filter those out silently.
            const validIdSet = new Set(catalogIndex.map(c => c.id));
            const validRecs = parsed
              .filter(
                (r): r is LlmRec =>
                  r !== null &&
                  typeof r === 'object' &&
                  typeof r.productId === 'string' &&
                  validIdSet.has(r.productId) &&
                  r.productId !== product.id
              )
              .slice(0, RECS_PER_PRODUCT);

            if (validRecs.length === 0) {
              // No valid picks — count as skipped (not an error).
              skipped++;
            } else {
              // Fully replace prior AI recs for this source product so
              // re-sweeping the catalogue produces a clean result.
              await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
                await tx.aiRecommendation.deleteMany({
                  where: { storeId, sourceProductId: product.id },
                });
                await tx.aiRecommendation.createMany({
                  data: validRecs.map(r => ({
                    storeId,
                    sourceProductId: product.id,
                    targetProductId: r.productId,
                    score: typeof r.score === 'number' ? Math.max(0, Math.min(1, r.score)) : 0.5,
                    reason: typeof r.reason === 'string' ? r.reason.slice(0, 500) : null,
                  })),
                  skipDuplicates: true,
                });
              });
              filled++;
            }
          } catch (err) {
            if (isAiQuotaCapError(err)) {
              // Quota errors propagate up so the Inngest retry mechanism
              // can surface them cleanly; do not silently swallow them.
              logger.warn(
                { storeId, jobId },
                'bulk-ai-recommendations: quota cap hit, aborting sweep'
              );
              throw err;
            }
            const msg = err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE;
            if (errors.length < ERROR_CAP) {
              errors.push({
                entityKind: 'product',
                entityId: product.id,
                entityName: product.name,
                error: msg,
              });
            }
            failed++;
          }

          processed++;

          // Throttle to stay under the free-tier ~30 RPM. Only sleep after a
          // real model call — the quota-gate early-return above never reaches
          // this line, so the sleep is always paired with a Gemini call.
          await sleep(THROTTLE_MS);

          // Persist incremental progress so the admin polling UI sees live
          // updates rather than a single jump at completion.
          if (processed % 10 === 0 || processed === products.length) {
            await prisma.bulkAiJob.update({
              where: { id: jobId },
              data: { processed, filled, skipped, failed, errors: errors as object },
            });
          }
        }
      } catch (err) {
        if (!isAiQuotaCapError(err)) throw err;
        quotaReached = true;
        if (errors.length < ERROR_CAP) {
          errors.push({
            entityKind: 'store',
            entityId: storeId,
            entityName: 'sweep',
            error: err instanceof AppError ? err.message : 'AI quota cap reached',
          });
        }
      }

      // Only mark completed if the merchant didn't cancel — otherwise the
      // status row already says 'cancelled' from the cancel endpoint.
      const finalRow = await prisma.bulkAiJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: finalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
          completedAt: new Date(),
          errors: errors as object,
        },
      });

      logger.info({ jobId, storeId, quotaReached, force }, 'bulk-ai-recommendations complete');
    }; // end runInTenantContext
  }
);
