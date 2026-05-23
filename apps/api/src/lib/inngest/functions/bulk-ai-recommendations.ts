import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../../../config';
import { assertAiQuota, isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { inngest } from '../client';

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
 * Each re-sweep fully replaces prior AI recs for the source product so
 * stale picks never accumulate. Smart-skip is intentionally NOT applied
 * here — re-sweeping the catalogue is the correct way to refresh recs
 * as the catalogue grows.
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

/**
 * Retry a single Gemini call on transient errors (503, 429-rate-limit,
 * network resets). Uses exponential backoff: 2s → 4s → 8s (+up to 500ms
 * jitter). Caps at 15s per wait. Max 3 attempts (1 initial + 2 retries).
 *
 * NOT applied to quota-cap errors (AI_QUOTA_DAILY_EXCEEDED /
 * AI_QUOTA_MONTHLY_EXCEEDED — those have a `.code` property and are
 * caught + re-thrown by isAiQuotaCapError before reaching this wrapper).
 * NOT applied to auth errors (401/403) or bad-input errors (400).
 *
 * Per-product retry, NOT per-sweep: completed products are never re-run,
 * and the ERROR_CAP / quota-gate whole-sweep bailout still applies.
 */
async function callWithRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status =
        (err as { status?: number; response?: { status?: number } })?.status ??
        (err as { response?: { status?: number } })?.response?.status;
      const msg = (err instanceof Error ? err.message : String(err)) ?? '';
      const transient =
        status === 503 ||
        (status === 429 && !isAiQuotaCapError(err)) ||
        /timeout|ECONNRESET|ETIMEDOUT/i.test(msg);

      if (!transient || attempt === maxAttempts) throw err;

      const delayMs = Math.min(2000 * 2 ** (attempt - 1), 15000) + Math.floor(Math.random() * 500);
      logger.warn(
        { label, attempt, maxAttempts, status, err: msg },
        '[bulk-ai] transient gemini failure, retrying'
      );
      await sleep(delayMs);
    }
  }
  // TypeScript: unreachable — loop always returns or throws
  throw new Error('callWithRetry: exhausted attempts');
}

function getGenAI(): GoogleGenerativeAI {
  if (!config.googleAiKey) {
    throw new Error('AI_NOT_CONFIGURED: GOOGLE_GENERATIVE_AI_KEY missing');
  }
  return new GoogleGenerativeAI(config.googleAiKey);
}

/**
 * Strip Markdown code fences that Gemini occasionally emits even when
 * responseMimeType is set to application/json. Defensive — most calls
 * are clean.
 */
function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
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
    const { jobId, storeId } = event.data as { jobId: string; storeId: string };

    if (!jobId || !storeId) {
      logger.warn('bulk-ai/recommendations-requested fired without ids');
      return;
    }

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
      //   a) set BulkAiJob.total so the progress bar is accurate
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

      const genAI = getGenAI();
      const model = genAI.getGenerativeModel({
        model: MODEL,
        generationConfig: { responseMimeType: 'application/json' },
      });

      let processed = 0;

      for (const product of products) {
        try {
          await assertAiQuota();

          const desc = (product.description ?? '').slice(0, 300);
          const candidates = catalogIndex
            .filter(c => c.id !== product.id)
            .slice(0, CANDIDATE_SLICE);

          const productCategory = product.categories[0]?.category.name ?? null;
          const prompt = `Given a source product, pick the ${RECS_PER_PRODUCT} catalog products that best complement it (cross-sells or bundles — not substitutes). Output ONLY a JSON array, no prose.

Source product:
  id: ${product.id}
  name: ${product.name}
  category: ${productCategory ?? '—'}
  description: ${desc || '—'}

Candidate catalog (pick IDs only from this list):
${JSON.stringify(candidates)}

Output schema: [{"productId":"<id from candidate list>","score":0.0,"reason":"<one sentence>"}]

Return exactly ${Math.min(RECS_PER_PRODUCT, candidates.length)} items sorted by descending score.`;

          const result = await callWithRetry(
            () => model.generateContent(prompt),
            `recommendations:${product.id}`
          );
          const raw = result.response.text();
          let parsed: LlmRec[];

          try {
            parsed = JSON.parse(stripFences(raw));
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
            await prisma.$transaction(async tx => {
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
          const msg = err instanceof Error ? err.message : String(err);
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
          error: err instanceof Error ? err.message : 'AI quota cap reached',
        });
      }
    }

    await prisma.bulkAiJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        errors: errors as object,
      },
    });

    logger.info(
      { jobId, storeId, filled, skipped, failed, errorCount: errors.length, quotaReached },
      'bulk-ai-recommendations complete'
    );
  }
);
