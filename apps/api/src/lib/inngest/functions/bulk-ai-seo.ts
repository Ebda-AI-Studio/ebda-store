import type { JobDef } from '../../jobs/types';
import { storeWriter } from '../../../lib/repo-factory';
import { prisma, runInStoreScope } from '@ebda/database';
import { AIService } from '../../../services/ai.service';
import { isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { invalidateStoreProductCaches } from '../../public-cache';
import { bustStoreCachesById } from '../../../services/store.service';

/**
 * Catalogue-wide SEO sweep. Fills missing SEO meta on the store row,
 * every category, and every product. Skips entities that already
 * have all four meta fields filled (we never overwrite existing
 * SEO on a bulk run — merchants can do per-entity overwrite from
 * the entity's own form if they want a regenerate).
 *
 * PR2 — crash-resumable batching. The store + every category + every
 * product are loaded ONCE inside `step.run('load-items', ...)` as a single
 * stable work-item list (`{kind, id}`, set + order fixed across retries),
 * then split into `BULK_AI_BATCH_SIZE`-sized batches, each processed inside
 * its own `step.run(\`batch-${i}\`, ...)`. A crash mid-sweep resumes at the
 * first unfinished batch. Each item's current SEO fields are re-read fresh
 * at batch-processing time (not the load-items snapshot) so a retried batch
 * never re-spends a Gemini call on an entity already filled.
 */
const ERROR_CAP = 50;

// Throttle bulk AI calls so the per-minute quota never fires mid-
// sweep. `gemini-flash-lite-latest` allows ~30 RPM free — we pace
// at one every 2.5s (~24 RPM) which leaves headroom. Override via
// AI_BULK_THROTTLE_MS env to slow down or speed up.
const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface BulkError {
  entityKind: 'product' | 'category' | 'store';
  entityId: string;
  entityName: string;
  error: string;
}

interface BatchResult {
  processed: number;
  filled: number;
  skipped: number;
  failed: number;
  errors: BulkError[];
  quotaReached: boolean;
  cancelled: boolean;
}

type WorkItem = { kind: 'store' | 'category' | 'product'; id: string };

function needsSeo(entity: {
  metaTitle?: string | null;
  metaTitleAr?: string | null;
  metaDescription?: string | null;
  metaDescriptionAr?: string | null;
}): boolean {
  return (
    !entity.metaTitle?.trim() ||
    !entity.metaTitleAr?.trim() ||
    !entity.metaDescription?.trim() ||
    !entity.metaDescriptionAr?.trim()
  );
}

// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type when the returned object mixes a plain string[]
// with a richer array-of-objects sibling (the annotation widens the
// contextual type fed into `createFunction`'s generics, and Jsonify then
// collapses the string[] to `unknown[]`). Assigning to the annotated export
// on a separate line avoids feeding the annotation back into inference.
const bulkAiSeoFn = inngest.createFunction(
  {
    id: 'bulk-ai-seo',
    name: 'Bulk: generate missing SEO meta across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/seo-requested' }],
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
      logger.warn('bulk-ai/seo-requested fired without ids');
      return;
    }

    return runInStoreScope(storeId, async () => {
      await step.run('mark-running', () =>
        prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { status: 'running', startedAt: new Date(), force },
        })
      );

      const items: WorkItem[] = await step.run('load-items', async () => {
        const store = await prisma.store.findUnique({
          where: { id: storeId },
          select: { id: true },
        });
        if (!store) return [];

        const cats = await prisma.category.findMany({
          where: { storeId, deletedAt: null },
          select: { id: true },
        });
        const products = await prisma.product.findMany({
          where: { storeId, deletedAt: null },
          select: { id: true },
        });

        const work: WorkItem[] = [
          { kind: 'store', id: storeId },
          ...cats.map(c => ({ kind: 'category' as const, id: c.id })),
          ...products.map(p => ({ kind: 'product' as const, id: p.id })),
        ];

        await prisma.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { total: work.length },
        });

        return work;
      });

      const errors: BulkError[] = [];
      let processed = 0;
      let filled = 0;
      let skipped = 0;
      let failed = 0;
      let quotaReached = false;

      if (items.length === 0) {
        await step.run('mark-failed', async () => {
          await prisma.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { status: 'failed', errorMessage: 'Store not found', completedAt: new Date() },
          });
        });
        return;
      }

      const store = await step.run('load-store', () =>
        prisma.store.findUnique({
          where: { id: storeId },
          select: { name: true, nameAr: true },
        })
      );
      const storeName = store?.name ?? storeId;
      const storeNameAr = store?.nameAr ?? null;

      const batches = chunk(items, BULK_AI_BATCH_SIZE);

      for (let i = 0; i < batches.length; i++) {
        const batchItems = batches[i];

        const result: BatchResult = await step.run(`batch-${i}`, async () => {
          const currentJob = await prisma.bulkAiJob.findUnique({
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

          let bProcessed = 0;
          let bFilled = 0;
          let bSkipped = 0;
          let bFailed = 0;
          let bQuotaReached = false;
          const bErrors: BulkError[] = [];

          for (const item of batchItems) {
            // Fresh per-item read — the idempotency re-check. Whichever
            // entity kind, we re-derive its current SEO-completeness right
            // before deciding whether to call Gemini.
            if (item.kind === 'store') {
              const s = await prisma.store.findUnique({
                where: { id: item.id },
                select: {
                  name: true,
                  nameAr: true,
                  description: true,
                  descriptionAr: true,
                  metaTitle: true,
                  metaTitleAr: true,
                  metaDescription: true,
                  metaDescriptionAr: true,
                },
              });
              if (!s) {
                bSkipped++;
                bProcessed++;
                continue;
              }
              if (!force && !needsSeo(s)) {
                bSkipped++;
              } else {
                try {
                  const r = await callWithRetry(
                    () =>
                      AIService.suggestSeo({
                        storeId,
                        kind: 'store',
                        storeName: s.name,
                        storeNameAr: s.nameAr,
                        entityName: s.name,
                        entityNameAr: s.nameAr,
                        entityDescription: s.description,
                        entityDescriptionAr: s.descriptionAr,
                      }),
                    `seo:store:${storeId}`
                  );
                  await prisma.store.update({
                    where: { id: storeId },
                    data: {
                      metaTitle: s.metaTitle?.trim() || r.suggestion.title,
                      metaTitleAr: s.metaTitleAr?.trim() || r.suggestion.titleAr,
                      metaDescription: s.metaDescription?.trim() || r.suggestion.description,
                      metaDescriptionAr: s.metaDescriptionAr?.trim() || r.suggestion.descriptionAr,
                    },
                  });
                  bFilled++;
                  await sleep(THROTTLE_MS);
                } catch (err) {
                  if (isAiQuotaCapError(err)) {
                    bQuotaReached = true;
                    break;
                  }
                  bErrors.push({
                    entityKind: 'store',
                    entityId: storeId,
                    entityName: s.name,
                    error: err instanceof Error ? err.message : 'unknown',
                  });
                  bFailed++;
                }
              }
              bProcessed++;
              continue;
            }

            if (item.kind === 'category') {
              const c = await prisma.category.findUnique({
                where: { id: item.id, storeId },
                select: {
                  id: true,
                  name: true,
                  nameAr: true,
                  description: true,
                  descriptionAr: true,
                  metaTitle: true,
                  metaTitleAr: true,
                  metaDescription: true,
                  metaDescriptionAr: true,
                },
              });
              if (!c) {
                bSkipped++;
                bProcessed++;
                continue;
              }
              if (!force && !needsSeo(c)) {
                bSkipped++;
              } else {
                try {
                  const r = await callWithRetry(
                    () =>
                      AIService.suggestSeo({
                        storeId,
                        kind: 'category',
                        storeName,
                        storeNameAr,
                        entityName: c.name,
                        entityNameAr: c.nameAr,
                        entityDescription: c.description,
                        entityDescriptionAr: c.descriptionAr,
                      }),
                    `seo:category:${c.id}`
                  );
                  await (
                    await storeWriter(storeId)
                  ).category.update({
                    where: { id: c.id, storeId },
                    data: {
                      metaTitle: c.metaTitle?.trim() || r.suggestion.title,
                      metaTitleAr: c.metaTitleAr?.trim() || r.suggestion.titleAr,
                      metaDescription: c.metaDescription?.trim() || r.suggestion.description,
                      metaDescriptionAr: c.metaDescriptionAr?.trim() || r.suggestion.descriptionAr,
                    },
                  });
                  bFilled++;
                  await sleep(THROTTLE_MS);
                } catch (err) {
                  if (isAiQuotaCapError(err)) {
                    bQuotaReached = true;
                    break;
                  }
                  bErrors.push({
                    entityKind: 'category',
                    entityId: c.id,
                    entityName: c.name,
                    error: err instanceof Error ? err.message : 'unknown',
                  });
                  bFailed++;
                }
              }
              bProcessed++;
              continue;
            }

            // item.kind === 'product'
            const p = await prisma.product.findUnique({
              where: { id: item.id, storeId },
              select: {
                id: true,
                name: true,
                nameAr: true,
                description: true,
                descriptionAr: true,
                metaTitle: true,
                metaTitleAr: true,
                metaDescription: true,
                metaDescriptionAr: true,
                categories: { include: { category: { select: { name: true } } } },
              },
            });
            if (!p) {
              bSkipped++;
              bProcessed++;
              continue;
            }
            if (!force && !needsSeo(p)) {
              bSkipped++;
            } else {
              try {
                const r = await callWithRetry(
                  () =>
                    AIService.suggestSeo({
                      storeId,
                      kind: 'product',
                      storeName,
                      storeNameAr,
                      entityName: p.name,
                      entityNameAr: p.nameAr,
                      entityDescription: p.description,
                      entityDescriptionAr: p.descriptionAr,
                      categoryNames: p.categories.map(pc => pc.category.name),
                    }),
                  `seo:product:${p.id}`
                );
                await (
                  await storeWriter(storeId)
                ).product.update({
                  where: { id: p.id, storeId },
                  data: {
                    metaTitle: p.metaTitle?.trim() || r.suggestion.title,
                    metaTitleAr: p.metaTitleAr?.trim() || r.suggestion.titleAr,
                    metaDescription: p.metaDescription?.trim() || r.suggestion.description,
                    metaDescriptionAr: p.metaDescriptionAr?.trim() || r.suggestion.descriptionAr,
                  },
                });
                bFilled++;
                // Throttle to stay under the free-tier 15 RPM. Only sleep
                // after a real call — skipped entities pass through fast.
                await sleep(THROTTLE_MS);
              } catch (err) {
                if (isAiQuotaCapError(err)) {
                  bQuotaReached = true;
                  break;
                }
                bErrors.push({
                  entityKind: 'product',
                  entityId: p.id,
                  entityName: p.name,
                  error: err instanceof Error ? err.message : 'unknown',
                });
                bFailed++;
              }
            }
            bProcessed++;
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
          prisma.bulkAiJob.update({
            where: { id: jobId, storeId },
            data: { processed, filled, skipped, failed, errors: errors as object },
          })
        );

        if (result.cancelled) {
          logger.info(
            { jobId, storeId, processed, filled, skipped, failed },
            'bulk-ai-seo: cancelled by merchant'
          );
          break;
        }
        if (result.quotaReached) {
          quotaReached = true;
          if (errors.length < ERROR_CAP) {
            errors.push({
              entityKind: 'store',
              entityId: storeId,
              entityName: 'sweep',
              error: 'AI quota cap reached',
            });
          }
          break;
        }
      }

      // A bulk AI sweep rewrites product-facing content (titles, descriptions,
      // SEO, translations, tags, categories, image alt, FAQs) with raw Prisma
      // writes that carry no cache awareness, so the storefront kept serving
      // the pre-sweep copy until the TTL expired. Bust ONCE at the end, never
      // per item — same discipline as bulk-import (a per-row sweep would be an
      // invalidation storm). This also purges the storefront's Next data cache
      // via the tag the public fetches carry.
      await step.run('bust-product-caches', () => invalidateStoreProductCaches(storeId));
      // This sweep can also write STORE fields directly (metaTitle/
      // metaDescription for SEO; llmsTxt/aboutJson/storeFaq/storeHowto for
      // AEO/GEO) -- invalidateStoreProductCaches only busts the
      // product/category caches, never the store RECORD's own
      // public:store:<id> cache, so the storefront kept serving the
      // pre-sweep store data until that key's TTL expired.
      await step.run('bust-store-cache', () => bustStoreCachesById(storeId));
      await step.run('finalize', async () => {
        const finalRow = await prisma.bulkAiJob.findUnique({
          where: { id: jobId, storeId },
          select: { status: true },
        });

        await prisma.bulkAiJob.update({
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
        { jobId, storeId, filled, skipped, failed, errorCount: errors.length, quotaReached, force },
        'bulk-ai-seo complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiSeo: JobDef = bulkAiSeoFn;
