import type { JobDef } from '../../jobs/types';
import { storeWriter } from '../../../lib/repo-factory';
import { lazyStoreDb, lazyStoreWriter } from '../../jobs/store-db';
import { prisma, runInStoreScope } from '@ebda/database';
import { AIService } from '../../../services/ai.service';
import { isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';
import { BULK_AI_BATCH_SIZE, chunk } from '../batch-utils';
import { invalidateStoreProductCaches } from '../../public-cache';
import { requestStoreReindex } from '../../search/reindex';
import { storeUpdate } from '../../repo-factory';
import {
  replaceTextWithBackup,
  type ReplaceCtx,
} from '../../../services/catalogue-replace-backup.service';

/**
 * Catalogue-wide translation sweep. Walks every product + category
 * + the store row itself, applies the smart-skip rule (only translate
 * when EXACTLY one side of an EN/AR pair is filled), and writes back
 * the missing translation.
 *
 * Concurrency capped at 1 per store so a merchant can't run two
 * sweeps that race on the same field.
 *
 * PR2 — crash-resumable batching. The store + every category + every
 * product are loaded ONCE inside `step.run('load-items', ...)` as a single
 * stable work-item list (`{kind, id}`), then split into
 * `BULK_AI_BATCH_SIZE`-sized batches, each processed inside its own
 * `step.run(\`batch-${i}\`, ...)`. A crash mid-sweep resumes at the first
 * unfinished batch. Each entity's name/description pair is re-read fresh at
 * batch-processing time (not the load-items snapshot) so a retried batch
 * never re-translates a field a prior attempt already filled — this is
 * exactly the existing `shouldFill` smart-skip, just re-evaluated per batch
 * instead of once per whole sweep.
 */
const ERROR_CAP = 50;

// Throttle bulk AI calls so the per-minute quota never fires mid-
// sweep. `gemini-flash-lite-latest` allows ~30 RPM free — we pace
// at one every 2.5s (~24 RPM) which leaves comfortable headroom for
// the model picking up small bursts. Override via env to slow down
// further (cheaper plans) or speed up (paid quota).
const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface BulkError {
  entityKind: 'product' | 'category' | 'store';
  entityId: string;
  entityName: string;
  field: string;
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

// NOTE: inferred WITHOUT the `JobDef` contextual type on this
// `const` — annotating that directly here breaks TS's inference of
// `step.run`'s return type when the returned object mixes a plain string[]
// with a richer array-of-objects sibling (the annotation widens the
// contextual type fed into `createFunction`'s generics, and Jsonify then
// collapses the string[] to `unknown[]`). Assigning to the annotated export
// on a separate line avoids feeding the annotation back into inference.
const bulkAiTranslateFn = inngest.createFunction(
  {
    id: 'bulk-ai-translate',
    name: 'Bulk: translate missing EN/AR across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/translate-requested' }],
  },
  async ({ event, step }) => {
    const { jobId, storeId, direction } = event.data;
    // NEVER-OVERWRITE-1 (Ruling RF-833-2): this sweep never replaces merchant-written content, whatever a caller sends. The
    // `force` flag on the event or the job row is ignored; only empty fields are filled.
    const force = false as boolean;
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/translate-requested fired without ids');
      return;
    }

    // Direction `to_ar` = fill empty AR from EN; `to_en` = fill empty EN from AR.
    const fillTo: 'ar' | 'en' = direction === 'to_en' ? 'en' : 'ar';

    // 'fill' = exactly one side is filled (translate into the empty one); 'replace' = both are filled and the run is a
    // replace run (the target side is regenerated from the source side, its old value backed up first).
    function planFor(
      en: string | null | undefined,
      ar: string | null | undefined
    ): 'fill' | 'replace' | null {
      const enFilled = !!en?.trim();
      const arFilled = !!ar?.trim();
      if (enFilled !== arFilled) return (fillTo === 'ar' ? enFilled : arFilled) ? 'fill' : null;
      return enFilled && force ? 'replace' : null;
    }
    const shouldFill = (en: string | null | undefined, ar: string | null | undefined) =>
      planFor(en, ar) !== null;

    function sourceText(en: string | null | undefined, ar: string | null | undefined): string {
      return fillTo === 'ar' ? (en ?? '') : (ar ?? '');
    }

    return runInStoreScope(storeId, async () => {
      // the store's backend (Ruling CF-JOBS-4): Postgres (`prisma`) or its Durable Object

      const sdb = lazyStoreDb(storeId);

      const sw = lazyStoreWriter(storeId);
      await step.run('mark-running', () =>
        sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { status: 'running', startedAt: new Date() },
        })
      );

      const items: WorkItem[] = await step.run('load-items', async () => {
        const products = await sdb.product.findMany({
          where: { storeId, deletedAt: null },
          select: { id: true },
        });
        const cats = await sdb.category.findMany({
          where: { storeId },
          select: { id: true },
        });
        const store = await lazyStoreDb(storeId).store.findUnique({
          where: { id: storeId },
          select: { id: true },
        });

        const work: WorkItem[] = [
          ...products.map(p => ({ kind: 'product' as const, id: p.id })),
          ...cats.map(c => ({ kind: 'category' as const, id: c.id })),
          ...(store ? [{ kind: 'store' as const, id: storeId }] : []),
        ];

        // Each entity has 2 fields (name + description); upper bound only.
        await sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: { total: work.length * 2 },
        });

        return work;
      });

      const batches = chunk(items, BULK_AI_BATCH_SIZE);

      const errors: BulkError[] = [];
      let processed = 0;
      let filled = 0;
      let skipped = 0;
      let failed = 0;
      let quotaReached = false;

      for (let i = 0; i < batches.length; i++) {
        const batchItems = batches[i];

        const result: BatchResult = await step.run(`batch-${i}`, async () => {
          const currentJob = await sdb.bulkAiJob.findUnique({
            where: { id: jobId, storeId },
            select: { status: true, userId: true },
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
          let bProductsWritten = 0;
          const bErrors: BulkError[] = [];

          async function recordError(err: BulkError) {
            if (bErrors.length < ERROR_CAP) bErrors.push(err);
            bFailed++;
          }

          // Fill into an empty field, or replace a filled one: a replace goes through the backup service (backup + write, atomic).
          const rctx: ReplaceCtx = {
            storeId,
            userId: currentJob?.userId ?? null,
            jobId,
            tool: fillTo === 'ar' ? 'translate_ar' : 'translate_en',
          };
          async function put(
            kind: 'product' | 'category',
            id: string,
            field: string,
            previous: string | null | undefined,
            next: string,
            updates: Record<string, string>
          ) {
            if (!previous?.trim()) {
              updates[field] = next;
              return;
            }
            const out = await replaceTextWithBackup(rctx, {
              entityKind: kind,
              entityId: id,
              field,
              previous,
              next,
            });
            if (out === 'replaced') bProductsWritten += kind === 'product' ? 1 : 0;
            else {
              bFilled--;
              bSkipped++;
            }
          }

          entityLoop: for (const item of batchItems) {
            // Fresh per-item read — the idempotency re-check (shouldFill is
            // re-evaluated against current DB state, not the load-items
            // snapshot).
            if (item.kind === 'product') {
              const p = await sdb.product.findUnique({
                where: { id: item.id, storeId },
                select: {
                  id: true,
                  name: true,
                  nameAr: true,
                  description: true,
                  descriptionAr: true,
                },
              });
              if (!p) {
                bProcessed += 2;
                bSkipped += 2;
                continue;
              }
              const updates: Record<string, string> = {};

              if (shouldFill(p.name, p.nameAr)) {
                try {
                  const r = await callWithRetry(
                    () =>
                      AIService.translate({
                        storeId,
                        text: sourceText(p.name, p.nameAr),
                        from: fillTo === 'ar' ? 'en' : 'ar',
                        to: fillTo,
                        kind: 'product-name',
                      }),
                    `translate:product:${p.id}:name`
                  );
                  await put(
                    'product',
                    p.id,
                    fillTo === 'ar' ? 'nameAr' : 'name',
                    fillTo === 'ar' ? p.nameAr : p.name,
                    r.translation,
                    updates
                  );
                  bFilled++;
                  await sleep(THROTTLE_MS);
                } catch (err) {
                  if (isAiQuotaCapError(err)) {
                    bQuotaReached = true;
                    break entityLoop;
                  }
                  await recordError({
                    entityKind: 'product',
                    entityId: p.id,
                    entityName: p.name,
                    field: 'name',
                    error: err instanceof Error ? err.message : 'unknown',
                  });
                }
              } else {
                bSkipped++;
              }
              bProcessed++;

              if (shouldFill(p.description, p.descriptionAr)) {
                try {
                  const r = await callWithRetry(
                    () =>
                      AIService.translate({
                        storeId,
                        text: sourceText(p.description, p.descriptionAr),
                        from: fillTo === 'ar' ? 'en' : 'ar',
                        to: fillTo,
                        kind: 'product-description',
                      }),
                    `translate:product:${p.id}:description`
                  );
                  await put(
                    'product',
                    p.id,
                    fillTo === 'ar' ? 'descriptionAr' : 'description',
                    fillTo === 'ar' ? p.descriptionAr : p.description,
                    r.translation,
                    updates
                  );
                  bFilled++;
                  await sleep(THROTTLE_MS);
                } catch (err) {
                  if (isAiQuotaCapError(err)) {
                    bQuotaReached = true;
                    break entityLoop;
                  }
                  await recordError({
                    entityKind: 'product',
                    entityId: p.id,
                    entityName: p.name,
                    field: 'description',
                    error: err instanceof Error ? err.message : 'unknown',
                  });
                }
              } else {
                bSkipped++;
              }
              bProcessed++;

              if (Object.keys(updates).length > 0) {
                try {
                  await (
                    await storeWriter(storeId)
                  ).product.update({ where: { id: p.id, storeId }, data: updates });
                  bProductsWritten++;
                } catch (err) {
                  await recordError({
                    entityKind: 'product',
                    entityId: p.id,
                    entityName: p.name,
                    field: 'persist',
                    error: err instanceof Error ? err.message : 'persist failed',
                  });
                }
              }
              continue;
            }

            if (item.kind === 'category') {
              const c = await sdb.category.findUnique({
                where: { id: item.id, storeId },
                select: {
                  id: true,
                  name: true,
                  nameAr: true,
                  description: true,
                  descriptionAr: true,
                },
              });
              if (!c) {
                bProcessed += 2;
                bSkipped += 2;
                continue;
              }
              const updates: Record<string, string> = {};

              if (shouldFill(c.name, c.nameAr)) {
                try {
                  const r = await callWithRetry(
                    () =>
                      AIService.translate({
                        storeId,
                        text: sourceText(c.name, c.nameAr),
                        from: fillTo === 'ar' ? 'en' : 'ar',
                        to: fillTo,
                        kind: 'category-name',
                      }),
                    `translate:category:${c.id}:name`
                  );
                  await put(
                    'category',
                    c.id,
                    fillTo === 'ar' ? 'nameAr' : 'name',
                    fillTo === 'ar' ? c.nameAr : c.name,
                    r.translation,
                    updates
                  );
                  bFilled++;
                  await sleep(THROTTLE_MS);
                } catch (err) {
                  if (isAiQuotaCapError(err)) {
                    bQuotaReached = true;
                    break entityLoop;
                  }
                  await recordError({
                    entityKind: 'category',
                    entityId: c.id,
                    entityName: c.name,
                    field: 'name',
                    error: err instanceof Error ? err.message : 'unknown',
                  });
                }
              } else bSkipped++;
              bProcessed++;

              if (shouldFill(c.description, c.descriptionAr)) {
                try {
                  const r = await callWithRetry(
                    () =>
                      AIService.translate({
                        storeId,
                        text: sourceText(c.description, c.descriptionAr),
                        from: fillTo === 'ar' ? 'en' : 'ar',
                        to: fillTo,
                        kind: 'category-description',
                      }),
                    `translate:category:${c.id}:description`
                  );
                  await put(
                    'category',
                    c.id,
                    fillTo === 'ar' ? 'descriptionAr' : 'description',
                    fillTo === 'ar' ? c.descriptionAr : c.description,
                    r.translation,
                    updates
                  );
                  bFilled++;
                  await sleep(THROTTLE_MS);
                } catch (err) {
                  if (isAiQuotaCapError(err)) {
                    bQuotaReached = true;
                    break entityLoop;
                  }
                  await recordError({
                    entityKind: 'category',
                    entityId: c.id,
                    entityName: c.name,
                    field: 'description',
                    error: err instanceof Error ? err.message : 'unknown',
                  });
                }
              } else bSkipped++;
              bProcessed++;

              if (Object.keys(updates).length > 0) {
                try {
                  await (
                    await storeWriter(storeId)
                  ).category.update({ where: { id: c.id, storeId }, data: updates });
                } catch (err) {
                  await recordError({
                    entityKind: 'category',
                    entityId: c.id,
                    entityName: c.name,
                    field: 'persist',
                    error: err instanceof Error ? err.message : 'persist failed',
                  });
                }
              }
              continue;
            }

            // item.kind === 'store'
            const store = await lazyStoreDb(item.id).store.findUnique({
              where: { id: item.id },
              select: { name: true, nameAr: true, description: true, descriptionAr: true },
            });
            if (!store) {
              bProcessed += 2;
              bSkipped += 2;
              continue;
            }
            const updates: Record<string, string> = {};

            if (planFor(store.name, store.nameAr) === 'fill') {
              try {
                const r = await callWithRetry(
                  () =>
                    AIService.translate({
                      storeId,
                      text: sourceText(store.name, store.nameAr),
                      from: fillTo === 'ar' ? 'en' : 'ar',
                      to: fillTo,
                      kind: 'store-name',
                    }),
                  `translate:store:${storeId}:name`
                );
                updates[fillTo === 'ar' ? 'nameAr' : 'name'] = r.translation;
                bFilled++;
                await sleep(THROTTLE_MS);
              } catch (err) {
                if (isAiQuotaCapError(err)) {
                  bQuotaReached = true;
                  break entityLoop;
                }
                await recordError({
                  entityKind: 'store',
                  entityId: storeId,
                  entityName: store.name,
                  field: 'name',
                  error: err instanceof Error ? err.message : 'unknown',
                });
              }
            } else bSkipped++;
            bProcessed++;

            if (planFor(store.description, store.descriptionAr) === 'fill') {
              try {
                const r = await callWithRetry(
                  () =>
                    AIService.translate({
                      storeId,
                      text: sourceText(store.description, store.descriptionAr),
                      from: fillTo === 'ar' ? 'en' : 'ar',
                      to: fillTo,
                      kind: 'store-description',
                    }),
                  `translate:store:${storeId}:description`
                );
                updates[fillTo === 'ar' ? 'descriptionAr' : 'description'] = r.translation;
                bFilled++;
                await sleep(THROTTLE_MS);
              } catch (err) {
                if (isAiQuotaCapError(err)) {
                  bQuotaReached = true;
                  break entityLoop;
                }
                await recordError({
                  entityKind: 'store',
                  entityId: storeId,
                  entityName: store.name,
                  field: 'description',
                  error: err instanceof Error ? err.message : 'unknown',
                });
              }
            } else bSkipped++;
            bProcessed++;

            if (Object.keys(updates).length > 0) {
              try {
                await storeUpdate(prisma, { where: { id: storeId }, data: updates });
              } catch (err) {
                await recordError({
                  entityKind: 'store',
                  entityId: storeId,
                  entityName: store.name,
                  field: 'persist',
                  error: err instanceof Error ? err.message : 'persist failed',
                });
              }
            }
          }

          // Translated names/descriptions feed the search embedding (Task 11). This function runs
          // under runInStoreScope (no request), so the event is sent inline, after the writes above.
          if (bProductsWritten > 0) await requestStoreReindex(storeId, 'bulk-ai-translate');

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
            'bulk-ai-translate: cancelled by merchant'
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
              field: 'sweep-aborted',
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

      await step.run('finalize', async () => {
        await sw.bulkAiJob.update({
          where: { id: jobId, storeId },
          data: {
            status: 'completed',
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
        { jobId, storeId, filled, skipped, failed, errorCount: errors.length, quotaReached },
        'bulk-ai-translate complete'
      );
    }); // end runInStoreScope
  }
);
export const bulkAiTranslate: JobDef = bulkAiTranslateFn;
