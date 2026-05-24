import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { AIService } from '../../../services/ai.service';
import { isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { callWithRetry } from '../ai-retry';
import { inngest } from '../client';

/**
 * Catalogue-wide SEO sweep. Fills missing SEO meta on the store row,
 * every category, and every product. Skips entities that already
 * have all four meta fields filled (we never overwrite existing
 * SEO on a bulk run — merchants can do per-entity overwrite from
 * the entity's own form if they want a regenerate).
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

export const bulkAiSeo: InngestFunction.Any = inngest.createFunction(
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

    const errors: BulkError[] = [];
    let filled = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;
    let quotaReached = false;

    async function recordError(err: BulkError) {
      if (errors.length < ERROR_CAP) errors.push(err);
      failed++;
    }

    try {
      const store = await prisma.store.findUnique({
        where: { id: storeId },
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

      // Total = store row + every category + every product.
      await step.run('mark-running', async () => {
        const [productCount, categoryCount] = await Promise.all([
          prisma.product.count({ where: { storeId, deletedAt: null } }),
          prisma.category.count({ where: { storeId, deletedAt: null } }),
        ]);
        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: {
            status: 'running',
            startedAt: new Date(),
            total: productCount + categoryCount + 1,
          },
        });
      });

      if (!store) {
        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            errorMessage: 'Store not found',
            completedAt: new Date(),
          },
        });
        return;
      }

      // Store-level SEO
      if (force || needsSeo(store)) {
        try {
          const r = await callWithRetry(
            () =>
              AIService.suggestSeo({
                storeId,
                kind: 'store',
                storeName: store.name,
                storeNameAr: store.nameAr,
                entityName: store.name,
                entityNameAr: store.nameAr,
                entityDescription: store.description,
                entityDescriptionAr: store.descriptionAr,
              }),
            `seo:store:${storeId}`
          );
          await prisma.store.update({
            where: { id: storeId },
            data: {
              metaTitle: store.metaTitle?.trim() || r.suggestion.title,
              metaTitleAr: store.metaTitleAr?.trim() || r.suggestion.titleAr,
              metaDescription: store.metaDescription?.trim() || r.suggestion.description,
              metaDescriptionAr: store.metaDescriptionAr?.trim() || r.suggestion.descriptionAr,
            },
          });
          filled++;
          await sleep(THROTTLE_MS);
        } catch (err) {
          if (isAiQuotaCapError(err)) throw err;
          await recordError({
            entityKind: 'store',
            entityId: storeId,
            entityName: store.name,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      } else {
        skipped++;
      }
      processed++;

      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: { processed, filled, skipped, failed },
      });

      // Categories
      const cats = await prisma.category.findMany({
        where: { storeId, deletedAt: null },
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
      for (const c of cats) {
        if (!force && !needsSeo(c)) {
          skipped++;
        } else {
          try {
            const r = await callWithRetry(
              () =>
                AIService.suggestSeo({
                  storeId,
                  kind: 'category',
                  storeName: store.name,
                  storeNameAr: store.nameAr,
                  entityName: c.name,
                  entityNameAr: c.nameAr,
                  entityDescription: c.description,
                  entityDescriptionAr: c.descriptionAr,
                }),
              `seo:category:${c.id}`
            );
            await prisma.category.update({
              where: { id: c.id },
              data: {
                metaTitle: c.metaTitle?.trim() || r.suggestion.title,
                metaTitleAr: c.metaTitleAr?.trim() || r.suggestion.titleAr,
                metaDescription: c.metaDescription?.trim() || r.suggestion.description,
                metaDescriptionAr: c.metaDescriptionAr?.trim() || r.suggestion.descriptionAr,
              },
            });
            filled++;
            await sleep(THROTTLE_MS);
          } catch (err) {
            if (isAiQuotaCapError(err)) throw err;
            await recordError({
              entityKind: 'category',
              entityId: c.id,
              entityName: c.name,
              error: err instanceof Error ? err.message : 'unknown',
            });
          }
        }
        processed++;
      }

      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: { processed, filled, skipped, failed, errors: errors as object },
      });

      // Products — page through to bound memory
      const PAGE = 25;
      let cursor: string | null = null;
      while (true) {
        const products: Array<{
          id: string;
          name: string;
          nameAr: string | null;
          description: string | null;
          descriptionAr: string | null;
          metaTitle: string | null;
          metaTitleAr: string | null;
          metaDescription: string | null;
          metaDescriptionAr: string | null;
          categories: Array<{ category: { name: string } }>;
        }> = await prisma.product.findMany({
          where: { storeId, deletedAt: null },
          orderBy: { id: 'asc' },
          take: PAGE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
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
        if (products.length === 0) break;

        for (const p of products) {
          // Cooperative cancellation — check every 5 products.
          if (processed % 5 === 0 && processed > 0) {
            const currentJob = await prisma.bulkAiJob.findUnique({
              where: { id: jobId },
              select: { status: true },
            });
            if (currentJob?.status === 'cancelled') {
              logger.info(
                { jobId, storeId, processed, filled, skipped, failed },
                'bulk-ai-seo: cancelled by merchant'
              );
              break;
            }
          }

          if (!force && !needsSeo(p)) {
            skipped++;
          } else {
            try {
              const r = await callWithRetry(
                () =>
                  AIService.suggestSeo({
                    storeId,
                    kind: 'product',
                    storeName: store.name,
                    storeNameAr: store.nameAr,
                    entityName: p.name,
                    entityNameAr: p.nameAr,
                    entityDescription: p.description,
                    entityDescriptionAr: p.descriptionAr,
                    categoryNames: p.categories.map(pc => pc.category.name),
                  }),
                `seo:product:${p.id}`
              );
              await prisma.product.update({
                where: { id: p.id },
                data: {
                  metaTitle: p.metaTitle?.trim() || r.suggestion.title,
                  metaTitleAr: p.metaTitleAr?.trim() || r.suggestion.titleAr,
                  metaDescription: p.metaDescription?.trim() || r.suggestion.description,
                  metaDescriptionAr: p.metaDescriptionAr?.trim() || r.suggestion.descriptionAr,
                },
              });
              filled++;
              // Throttle to stay under the free-tier 15 RPM. Only sleep
              // after a real call — skipped entities pass through fast.
              await sleep(THROTTLE_MS);
            } catch (err) {
              if (isAiQuotaCapError(err)) throw err;
              await recordError({
                entityKind: 'product',
                entityId: p.id,
                entityName: p.name,
                error: err instanceof Error ? err.message : 'unknown',
              });
            }
          }
          processed++;
        }

        cursor = products[products.length - 1].id;

        await prisma.bulkAiJob.update({
          where: { id: jobId },
          data: { processed, filled, skipped, failed, errors: errors as object },
        });

        if (products.length < PAGE) break;
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

    // Only mark completed if the merchant didn't cancel.
    const finalRow = await prisma.bulkAiJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    await prisma.bulkAiJob.update({
      where: { id: jobId },
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

    logger.info(
      { jobId, storeId, filled, skipped, failed, errorCount: errors.length, quotaReached, force },
      'bulk-ai-seo complete'
    );
  }
);
