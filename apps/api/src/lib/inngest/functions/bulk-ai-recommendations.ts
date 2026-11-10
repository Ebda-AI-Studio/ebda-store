import type { JobDef } from '../../jobs/types';
import { storeRepo, storeWriter, type StoreReads } from '../../repo-factory';
import { lazyStoreDb, lazyStoreWriter } from '../../jobs/store-db';
import { Prisma, prisma, runInStoreScope } from '@ebda/database';
import { GeminiFailoverClient } from '../../ai/gemini-keys';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { parseAiJson } from '../../ai/parse-ai-json';
import { rethrowAsAppError } from '../../ai/gemini-errors';
import { recordUsage } from '../../../services/ai.service';
import { AppError } from '../../../middleware/error-handler';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { invalidateStoreProductCaches } from '../../public-cache';

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
 *   - Cooperative cancellation: checked at batch boundaries.
 *
 * PR2 — crash-resumable batching. The candidate product list (id + name +
 * category) is loaded ONCE inside `step.run('load-items', ...)`, split into
 * `BULK_AI_BATCH_SIZE`-sized batches, each processed inside its own
 * `step.run(\`batch-${i}\`, ...)`. A crash mid-sweep resumes at the first
 * unfinished batch. Each product re-reads whether it already has AI recs
 * fresh at batch-processing time (idempotency re-check) — the catalogue
 * index + FBT co-purchase map are rebuilt fresh per batch too (cheap reads,
 * always current).
 *
 * Mirrors the pattern of bulk-ai-seo / bulk-ai-translate / bulk-ai-aeo:
 *   - concurrency key on storeId (one sweep per store at a time)
 *   - retries: 2 (per feedback-bulk-ai-transient-retry: ≥2 mandatory)
 *   - throttle at AI_BULK_THROTTLE_MS (default 2500ms — ~24 RPM)
 *   - quota check before each call via assertAiQuota
 *   - error cap at 50 so no single run bloats the BulkAiJob row
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

function getGenAI(): GeminiFailoverClient {
  if (!config.googleAiKey) {
    throw new Error('AI_NOT_CONFIGURED: GOOGLE_GENERATIVE_AI_KEY missing');
  }
  return new GeminiFailoverClient();
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
 * The products that already have AI recommendations (the smart-skip set). The `distinct` is done here, in JS, after the read:
 * the DO read client (prisma-lite) refuses `distinct` ("prisma-lite: distinct is not supported"), which failed every sweep on
 * the Worker (Ruling NZ-D23).
 */
export async function sourceProductIdsWithRecs(
  db: Pick<StoreReads, 'aiRecommendation'>,
  storeId: string
): Promise<Set<string>> {
  const rows = await db.aiRecommendation.findMany({
    where: { storeId },
    select: { sourceProductId: true },
  });
  return new Set(rows.map(r => r.sourceProductId));
}

async function coPurchaseRowsPg(
  storeId: string,
  since: Date
): Promise<Array<{ a_id: string; b_id: string; co_orders: bigint }>> {
  return prisma.$queryRaw<Array<{ a_id: string; b_id: string; co_orders: bigint }>>(
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
}

/**
 * The same pairs for a store on its Durable Object (Ruling CF-JOBS-4): the read client has no raw SQL, so the qualifying
 * orders are read with their lines (bounded to the newest FBT_DO_MAX_ORDERS orders) and paired here. Same filter as the SQL: this store, inside
 * the window, status not cancelled/refunded; top 2000 pairs by distinct co-orders.
 */
const FBT_DO_MAX_ORDERS = 5000;
export async function coPurchaseRowsOnDo(
  db: StoreReads,
  storeId: string,
  since: Date
): Promise<Array<{ a_id: string; b_id: string; co_orders: number }>> {
  const orders = await db.order.findMany({
    where: { storeId, createdAt: { gte: since }, status: { notIn: ['cancelled', 'refunded'] } },
    select: { id: true, items: { select: { productId: true } } },
    orderBy: { createdAt: 'desc' },
    take: FBT_DO_MAX_ORDERS,
  });
  const byOrder = new Map<string, Set<string>>(
    orders.map(o => [o.id, new Set(o.items.map(i => i.productId))])
  );
  const pairs = new Map<string, number>();
  for (const set of byOrder.values()) {
    const ids = [...set].sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const k = `${ids[i]}\u0000${ids[j]}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
  }
  return [...pairs.entries()]
    .map(([k, n]) => {
      const [a_id, b_id] = k.split('\u0000');
      return { a_id, b_id, co_orders: n };
    })
    .sort((x, y) => y.co_orders - x.co_orders)
    .slice(0, 2000);
}

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

  const repo = await storeRepo(storeId);
  const rows: Array<{ a_id: string; b_id: string; co_orders: bigint | number }> =
    repo.backend === 'do'
      ? await coPurchaseRowsOnDo(repo.db, storeId, since)
      : await coPurchaseRowsPg(storeId, since);

  const map = new Map<string, Array<{ productId: string; coOrders: number }>>();
  const push = (src: string, tgt: string, n: number) => {
    const list = map.get(src) ?? [];
    list.push({ productId: tgt, coOrders: n });
    map.set(src, list);
  };
  for (const r of rows) {
    const n = Number(r.co_orders);
    push(r.a_id, r.b_id, n);
    push(r.b_id, r.a_id, n);
  }
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

interface RecError {
  entityKind: string;
  entityId: string;
  entityName: string;
  error: string;
}

interface RecBatchResult {
  processed: number;
  filled: number;
  skipped: number;
  failed: number;
  errors: RecError[];
  quotaReached: boolean;
  cancelled: boolean;
}

// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type for object literals mixing a plain string[] with
// a richer array-of-objects sibling (the annotation widens the contextual
// type fed into `createFunction`'s generics, and Jsonify then collapses the
// string[] to `unknown[]`). Assigning to the annotated export on a separate
// line avoids feeding the annotation back into inference.
const bulkAiRecommendationsFn = inngest.createFunction(
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

    return runInStoreScope(storeId, async () => {
      // the store's backend (Ruling CF-JOBS-4): Postgres (`prisma`) or its Durable Object

      const sdb = lazyStoreDb(storeId);

      const sw = lazyStoreWriter(storeId);
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
        sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { status: 'running', startedAt: new Date(), force },
        })
      );

      // Stable snapshot of the candidate catalogue index — used both to
      // build batches and as the Gemini candidate list. Loaded ONCE so
      // batch boundaries never shift across retries.
      const catalogIndex = await step.run('load-items', async () => {
        const products = await sdb.product.findMany({
          where: { storeId, status: 'active', deletedAt: null },
          select: {
            id: true,
            name: true,
            categories: { include: { category: { select: { name: true } } }, take: 1 },
          },
        });

        await sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { total: products.length },
        });

        return products.map(p => ({
          id: p.id,
          name: p.name,
          category: p.categories[0]?.category.name ?? null,
        }));
      });

      if (catalogIndex.length < 2) {
        // Nothing useful to recommend from a 0- or 1-product catalogue.

        // One bust per sweep. This file defines more than one function; busting only
        // at the last completion left a sibling sweep writing content and
        // invalidating nothing.
        await step.run('bust-product-caches', () => invalidateStoreProductCaches(storeId));
        await step.run('finalize-small', async () => {
          await sw.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: {
              status: 'completed',
              completedAt: new Date(),
              processed: catalogIndex.length,
              filled: 0,
              skipped: catalogIndex.length,
              failed: 0,
            },
          });
        });
        logger.info({ jobId, storeId }, 'bulk-ai-recommendations: catalog too small, skipped');
        return;
      }

      const nameById = new Map(catalogIndex.map(c => [c.id, c.name] as const));
      const batches = chunk(
        catalogIndex.map(c => c.id),
        BULK_AI_BATCH_SIZE
      );

      const errors: RecError[] = [];
      let processed = 0;
      let filled = 0;
      let skipped = 0;
      let failed = 0;
      let quotaReached = false;

      for (let i = 0; i < batches.length; i++) {
        const batchIds = batches[i];

        const result: RecBatchResult = await step.run(`batch-${i}`, async () => {
          const currentJob = await sdb.bulkAiJob.findUnique({
            where: { id: jobId, storeId },
            select: { status: true },
          });
          if (currentJob?.status === 'cancelled') {
            return {
              processed: 0,
              filled: 0,
              skipped: 0,
              failed: 0,
              errors: [],
              quotaReached: false,
              cancelled: true,
            };
          }

          const genAI = getGenAI();
          const model = genAI.getGenerativeModel({
            model: MODEL,
            generationConfig: { responseMimeType: 'application/json' },
          });

          // Smart-skip set + FBT signal rebuilt fresh per batch — cheap
          // reads, and always reflect what earlier batches just wrote.
          const productsWithRecs = await sourceProductIdsWithRecs(sdb, storeId);

          let coPurchase: Map<string, Array<{ productId: string; coOrders: number }>>;
          try {
            coPurchase = await computeCoPurchasePairs(storeId);
          } catch (err) {
            logger.warn(
              { jobId, storeId, err: err instanceof Error ? err.message : String(err) },
              'bulk-ai-recommendations: co-purchase signal unavailable, falling back to catalogue-only'
            );
            coPurchase = new Map();
          }

          let bProcessed = 0;
          let bFilled = 0;
          let bSkipped = 0;
          let bFailed = 0;
          let bQuotaReached = false;
          const bErrors: RecError[] = [];

          for (const productId of batchIds) {
            const name = nameById.get(productId);
            if (!name) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            // Fresh re-fetch — the idempotency re-check.
            const product = await sdb.product.findUnique({
              where: { id: productId, storeId },
              select: { id: true, name: true, description: true },
            });
            if (!product) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            if (!force && productsWithRecs.has(productId)) {
              bSkipped++;
              bProcessed++;
              continue;
            }

            try {
              await assertAiQuota({ storeId, bulk: true });

              const desc = (product.description ?? '').slice(0, 300);
              const candidates = catalogIndex
                .filter(c => c.id !== productId)
                .slice(0, CANDIDATE_SLICE);
              const productCategory = catalogIndex.find(c => c.id === productId)?.category ?? null;

              const fbt = (coPurchase.get(productId) ?? [])
                .filter(p => nameById.has(p.productId))
                .map(p => ({
                  productId: p.productId,
                  name: nameById.get(p.productId)!,
                  coOrders: p.coOrders,
                }));
              const fbtBlock =
                fbt.length > 0
                  ? `\nFrequently bought together (REAL co-purchase data — customers ordered these in the SAME order as the source product; higher coOrders = stronger signal). Prioritise these when they fit as complements:\n${JSON.stringify(fbt)}\n`
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

Return exactly ${Math.min(RECS_PER_PRODUCT, candidates.length)} items sorted by descending score (strongest complement first).`;

              const genResult = await callWithRetry(
                () => model.generateContent(prompt),
                `recommendations:${product.id}`
              ).catch((err: unknown) => rethrowAsAppError(err, 'AI recommendations sweep failed'));
              const usage = genResult.response.usageMetadata;
              await recordUsage(
                storeId,
                'recommendations',
                usage?.promptTokenCount ?? 0,
                usage?.candidatesTokenCount ?? 0,
                false
              );
              const raw = genResult.response.text();
              let parsed: LlmRec[];

              try {
                parsed = parseAiJson<LlmRec[]>(raw);
              } catch {
                throw new Error('LLM returned unparseable JSON');
              }

              if (!Array.isArray(parsed)) {
                throw new Error('LLM response is not a JSON array');
              }

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
                bSkipped++;
              } else {
                // replace this product's rows as ONE atomic batch (Postgres: the writer is `prisma`, the batch one
                // transaction; DO: one `mutate` RPC). A re-delivery replaces the same rows again, so it is idempotent.
                const rw = await storeWriter(storeId);
                await rw.$transaction([
                  rw.aiRecommendation.deleteMany({
                    where: { storeId, sourceProductId: product.id },
                  }),
                  rw.aiRecommendation.createMany({
                    data: validRecs.map(r => ({
                      storeId,
                      sourceProductId: product.id,
                      targetProductId: r.productId,
                      score: typeof r.score === 'number' ? Math.max(0, Math.min(1, r.score)) : 0.5,
                      reason: typeof r.reason === 'string' ? r.reason.slice(0, 500) : null,
                    })),
                    skipDuplicates: true,
                  }),
                ]);
                bFilled++;
              }
            } catch (err) {
              if (isAiQuotaCapError(err)) {
                logger.warn(
                  { storeId, jobId },
                  'bulk-ai-recommendations: quota cap hit, aborting sweep'
                );
                bQuotaReached = true;
                break;
              }
              const msg = err instanceof AppError ? err.message : AI_UNAVAILABLE_MESSAGE;
              if (bErrors.length < ERROR_CAP)
                bErrors.push({
                  entityKind: 'product',
                  entityId: product.id,
                  entityName: product.name,
                  error: msg,
                });
              bFailed++;
            }

            bProcessed++;
            await sleep(THROTTLE_MS);
          }

          return {
            processed: bProcessed,
            filled: bFilled,
            skipped: bSkipped,
            failed: bFailed,
            errors: bErrors,
            quotaReached: bQuotaReached,
            cancelled: false,
          };
        });

        processed += result.processed;
        filled += result.filled;
        skipped += result.skipped;
        failed += result.failed;
        for (const e of result.errors) {
          if (errors.length < ERROR_CAP) errors.push(e);
        }

        await step.run(`progress-${i}`, () =>
          sw.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { processed, filled, skipped, failed, errors: errors as object },
          })
        );

        if (result.cancelled) {
          logger.info(
            { jobId, storeId, processed, filled, skipped, failed },
            'bulk-ai-recommendations: cancelled by merchant'
          );
          break;
        }
        if (result.quotaReached) {
          quotaReached = true;
          if (errors.length < ERROR_CAP)
            errors.push({
              entityKind: 'store',
              entityId: storeId,
              entityName: 'sweep',
              error: 'AI quota cap reached',
            });
          break;
        }
      }

      // Only mark completed if the merchant didn't cancel — otherwise the
      // status row already says 'cancelled' from the cancel endpoint.

      // A bulk AI sweep rewrites product-facing content (titles, descriptions,
      // SEO, translations, tags, categories, image alt, FAQs) with raw Prisma
      // writes that carry no cache awareness, so the storefront kept serving
      // the pre-sweep copy until the TTL expired. Bust ONCE at the end, never
      // per item — same discipline as bulk-import (a per-row sweep would be an
      // invalidation storm). This also purges the storefront's Next data cache
      // via the tag the public fetches carry.
      await step.run('bust-product-caches', () => invalidateStoreProductCaches(storeId));
      await step.run('finalize', async () => {
        const finalRow = await sdb.bulkAiJob.findUnique({
          where: { id: jobId, storeId },
          select: { status: true },
        });

        await sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: {
            status: finalRow?.status === 'cancelled' ? 'cancelled' : 'completed',
            processed,
            filled,
            skipped,
            failed,
            errors: errors as object,
            completedAt: new Date(),
          },
        });
      });

      logger.info(
        { jobId, storeId, filled, skipped, failed, quotaReached, force },
        'bulk-ai-recommendations complete'
      );
    }); // end runInStoreScope. FIXED (2026-07): this used to be
    // `return async () => {...};` with NO invocation — a genuine bug that
    // meant the entire sweep body above never ran (Inngest received an
    // uninvoked function reference as the handler's resolved value). The
    // `(...)()` IIFE at the end actually executes it, matching every other
    // bulk-ai-* function in this directory.
  }
);
export const bulkAiRecommendations: JobDef = bulkAiRecommendationsFn;
