import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@ebda/database';
import { recommendationService } from '../../../services/recommendation.service';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Purge recommendation graph rows that point AT a soft-deleted product and
 * invalidate the caches of every product that referenced it.
 *
 * Triggered by the `product.deleted` event emitted from
 * product.service.ts after a successful soft-delete. Runs alongside
 * productMetaSyncDeleteFn on the same event.
 *
 * Tables cleaned:
 *   - AiRecommendation: rows where targetProductId === deleted product
 *   - FrequentlyBoughtTogether: rows where either productId1 or productId2 === deleted product
 *   - ProductRelation: rows where targetProductId === deleted product
 *
 * After deletion, the cache of each source product that previously referenced
 * the deleted product is invalidated so stale recommendation lists are not served.
 */
export const aiAutofillCleanup: InngestFunction.Any = inngest.createFunction(
  {
    id: 'ai-autofill-cleanup',
    name: 'AI-first: clean up recommendations on product delete',
    retries: 2,
    triggers: [{ event: 'product.deleted' as any }],
  },
  async ({ event }) => {
    const { storeId, productId } = event.data as { storeId: string; productId: string };

    if (!storeId || !productId) {
      logger.warn({ event: event.data }, '[ai-autofill-cleanup] missing storeId or productId');
      return;
    }

    await runInTenantContext(storeId, async () => {
      // Collect the source products whose recommendation caches need busting
      // BEFORE we delete the rows (we need the sourceProductId values).
      const referrers = await prisma.aiRecommendation.findMany({
        where: { storeId, targetProductId: productId },
        select: { sourceProductId: true },
      });

      // Purge the recommendation tables in a single transaction. The product is
      // SOFT-deleted (its row stays), so FK cascade never fires — we must remove
      // both directions explicitly: rows pointing AT it (so it's never
      // recommended) and rows it generated (so they don't orphan in the table /
      // inflate the overview count).
      await prisma.$transaction([
        prisma.aiRecommendation.deleteMany({
          where: {
            storeId,
            OR: [{ targetProductId: productId }, { sourceProductId: productId }],
          },
        }),
        prisma.frequentlyBoughtTogether.deleteMany({
          where: {
            storeId,
            OR: [{ productId1: productId }, { productId2: productId }],
          },
        }),
        prisma.productRelation.deleteMany({
          where: {
            storeId,
            OR: [{ targetProductId: productId }, { sourceProductId: productId }],
          },
        }),
      ]);

      // Invalidate the recommendation cache for each affected source product.
      // Errors are swallowed per-item so one bad Redis call doesn't block the rest.
      const uniqueSourceIds = [...new Set(referrers.map(r => r.sourceProductId))];
      await Promise.all(
        uniqueSourceIds.map(id =>
          recommendationService.invalidateProductCache(storeId, id).catch(err => {
            logger.warn(
              { err, storeId, productId: id },
              '[ai-autofill-cleanup] cache invalidation failed'
            );
          })
        )
      );

      logger.info(
        { storeId, productId, referrers: referrers.length },
        '[ai-autofill-cleanup] cleanup done'
      );
    }); // end runInTenantContext
  }
);
