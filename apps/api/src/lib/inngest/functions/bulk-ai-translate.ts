import type { InngestFunction } from 'inngest';
import { prisma } from '@force/database';
import { AIService } from '../../../services/ai.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Catalogue-wide translation sweep. Walks every product + category
 * + the store row itself, applies the smart-skip rule (only translate
 * when EXACTLY one side of an EN/AR pair is filled), and writes back
 * the missing translation.
 *
 * Concurrency capped at 1 per store so a merchant can't run two
 * sweeps that race on the same field. Per-step retries are off
 * because a partial run is recoverable (re-running just translates
 * what's still missing — the smart-skip handles idempotency).
 */
const ERROR_CAP = 50;

interface BulkError {
  entityKind: 'product' | 'category' | 'store';
  entityId: string;
  entityName: string;
  field: string;
  error: string;
}

export const bulkAiTranslate: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-translate',
    name: 'Bulk: translate missing EN/AR across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 0,
    triggers: [{ event: 'bulk-ai/translate-requested' }],
  },
  async ({ event, step }) => {
    const { jobId, storeId, direction } = event.data;
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/translate-requested fired without ids');
      return;
    }

    const errors: BulkError[] = [];
    let filled = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;

    // Direction `to_ar` = fill empty AR from EN; `to_en` = fill empty EN from AR.
    const fillTo: 'ar' | 'en' = direction === 'to_en' ? 'en' : 'ar';

    function shouldFill(en: string | null | undefined, ar: string | null | undefined): boolean {
      const enFilled = !!en?.trim();
      const arFilled = !!ar?.trim();
      if (enFilled === arFilled) return false; // both filled or both empty
      return fillTo === 'ar' ? enFilled && !arFilled : arFilled && !enFilled;
    }

    function sourceText(en: string | null | undefined, ar: string | null | undefined): string {
      return fillTo === 'ar' ? (en ?? '') : (ar ?? '');
    }

    async function recordError(err: BulkError) {
      if (errors.length < ERROR_CAP) errors.push(err);
      failed++;
    }

    // Mark running and count rows to estimate total work
    await step.run('mark-running', async () => {
      const [productCount, categoryCount] = await Promise.all([
        prisma.product.count({ where: { storeId, deletedAt: null } }),
        prisma.category.count({ where: { storeId } }),
      ]);
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: 'running',
          startedAt: new Date(),
          // Each entity has 2 fields (name + description); upper bound only.
          total: (productCount + categoryCount) * 2 + 2,
        },
      });
    });

    // Process products in pages of 25 to bound memory and Gemini RPS
    const PAGE = 25;
    let cursor: string | null = null;
    while (true) {
      const products: Array<{
        id: string;
        name: string;
        nameAr: string | null;
        description: string | null;
        descriptionAr: string | null;
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
        },
      });
      if (products.length === 0) break;

      for (const p of products) {
        const updates: Record<string, string> = {};

        if (shouldFill(p.name, p.nameAr)) {
          try {
            const r = await AIService.translate({
              storeId,
              text: sourceText(p.name, p.nameAr),
              from: fillTo === 'ar' ? 'en' : 'ar',
              to: fillTo,
              kind: 'product-name',
            });
            updates[fillTo === 'ar' ? 'nameAr' : 'name'] = r.translation;
            filled++;
          } catch (err) {
            await recordError({
              entityKind: 'product',
              entityId: p.id,
              entityName: p.name,
              field: 'name',
              error: err instanceof Error ? err.message : 'unknown',
            });
          }
        } else {
          skipped++;
        }
        processed++;

        if (shouldFill(p.description, p.descriptionAr)) {
          try {
            const r = await AIService.translate({
              storeId,
              text: sourceText(p.description, p.descriptionAr),
              from: fillTo === 'ar' ? 'en' : 'ar',
              to: fillTo,
              kind: 'product-description',
            });
            updates[fillTo === 'ar' ? 'descriptionAr' : 'description'] = r.translation;
            filled++;
          } catch (err) {
            await recordError({
              entityKind: 'product',
              entityId: p.id,
              entityName: p.name,
              field: 'description',
              error: err instanceof Error ? err.message : 'unknown',
            });
          }
        } else {
          skipped++;
        }
        processed++;

        if (Object.keys(updates).length > 0) {
          try {
            await prisma.product.update({ where: { id: p.id }, data: updates });
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
      }

      cursor = products[products.length - 1].id;

      // Persist progress at the end of each page
      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: { processed, filled, skipped, failed, errors: errors as object },
      });

      if (products.length < PAGE) break;
    }

    // Categories
    const cats = await prisma.category.findMany({
      where: { storeId },
      select: { id: true, name: true, nameAr: true, description: true, descriptionAr: true },
    });
    for (const c of cats) {
      const updates: Record<string, string> = {};
      if (shouldFill(c.name, c.nameAr)) {
        try {
          const r = await AIService.translate({
            storeId,
            text: sourceText(c.name, c.nameAr),
            from: fillTo === 'ar' ? 'en' : 'ar',
            to: fillTo,
            kind: 'category-name',
          });
          updates[fillTo === 'ar' ? 'nameAr' : 'name'] = r.translation;
          filled++;
        } catch (err) {
          await recordError({
            entityKind: 'category',
            entityId: c.id,
            entityName: c.name,
            field: 'name',
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      } else skipped++;
      processed++;

      if (shouldFill(c.description, c.descriptionAr)) {
        try {
          const r = await AIService.translate({
            storeId,
            text: sourceText(c.description, c.descriptionAr),
            from: fillTo === 'ar' ? 'en' : 'ar',
            to: fillTo,
            kind: 'category-description',
          });
          updates[fillTo === 'ar' ? 'descriptionAr' : 'description'] = r.translation;
          filled++;
        } catch (err) {
          await recordError({
            entityKind: 'category',
            entityId: c.id,
            entityName: c.name,
            field: 'description',
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      } else skipped++;
      processed++;

      if (Object.keys(updates).length > 0) {
        try {
          await prisma.category.update({ where: { id: c.id }, data: updates });
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
    }

    // Store row (name + description)
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, nameAr: true, description: true, descriptionAr: true },
    });
    if (store) {
      const updates: Record<string, string> = {};
      if (shouldFill(store.name, store.nameAr)) {
        try {
          const r = await AIService.translate({
            storeId,
            text: sourceText(store.name, store.nameAr),
            from: fillTo === 'ar' ? 'en' : 'ar',
            to: fillTo,
            kind: 'store-name',
          });
          updates[fillTo === 'ar' ? 'nameAr' : 'name'] = r.translation;
          filled++;
        } catch (err) {
          await recordError({
            entityKind: 'store',
            entityId: storeId,
            entityName: store.name,
            field: 'name',
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      } else skipped++;
      processed++;

      if (shouldFill(store.description, store.descriptionAr)) {
        try {
          const r = await AIService.translate({
            storeId,
            text: sourceText(store.description, store.descriptionAr),
            from: fillTo === 'ar' ? 'en' : 'ar',
            to: fillTo,
            kind: 'store-description',
          });
          updates[fillTo === 'ar' ? 'descriptionAr' : 'description'] = r.translation;
          filled++;
        } catch (err) {
          await recordError({
            entityKind: 'store',
            entityId: storeId,
            entityName: store.name,
            field: 'description',
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      } else skipped++;
      processed++;

      if (Object.keys(updates).length > 0) {
        try {
          await prisma.store.update({ where: { id: storeId }, data: updates });
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
      'bulk-ai-translate complete'
    );
  }
);
