import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { AIService } from '../../../services/ai.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Catalogue-wide SEO sweep. Fills missing SEO meta on the store row,
 * every category, and every product. Skips entities that already
 * have all four meta fields filled (we never overwrite existing
 * SEO on a bulk run — merchants can do per-entity overwrite from
 * the entity's own form if they want a regenerate).
 */
const ERROR_CAP = 50;

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
    retries: 0,
    triggers: [{ event: 'bulk-ai/seo-requested' }],
  },
  async ({ event, step }) => {
    const { jobId, storeId } = event.data;
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/seo-requested fired without ids');
      return;
    }

    const errors: BulkError[] = [];
    let filled = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;

    async function recordError(err: BulkError) {
      if (errors.length < ERROR_CAP) errors.push(err);
      failed++;
    }

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

    // Categories don't have SEO meta columns — they're skipped at the
    // schema layer. Total = store row + every product.
    await step.run('mark-running', async () => {
      const productCount = await prisma.product.count({
        where: { storeId, deletedAt: null },
      });
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: 'running',
          startedAt: new Date(),
          total: productCount + 1,
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
    if (needsSeo(store)) {
      try {
        const r = await AIService.suggestSeo({
          storeId,
          kind: 'store',
          storeName: store.name,
          storeNameAr: store.nameAr,
          entityName: store.name,
          entityNameAr: store.nameAr,
          entityDescription: store.description,
          entityDescriptionAr: store.descriptionAr,
        });
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
      } catch (err) {
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

    // Categories: schema doesn't expose SEO meta columns on Category
    // today. Skipped here; if those columns get added later, drop in
    // a category sweep block that mirrors the product loop below.

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
        if (!needsSeo(p)) {
          skipped++;
        } else {
          try {
            const r = await AIService.suggestSeo({
              storeId,
              kind: 'product',
              storeName: store.name,
              storeNameAr: store.nameAr,
              entityName: p.name,
              entityNameAr: p.nameAr,
              entityDescription: p.description,
              entityDescriptionAr: p.descriptionAr,
              categoryNames: p.categories.map(pc => pc.category.name),
            });
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
          } catch (err) {
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

    await prisma.bulkAiJob.update({
      where: { id: jobId },
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

    logger.info(
      { jobId, storeId, filled, skipped, failed, errorCount: errors.length },
      'bulk-ai-seo complete'
    );
  }
);
