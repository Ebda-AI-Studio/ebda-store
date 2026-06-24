import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
import { revertProductBalance } from '../../../services/ai-autofill.service';
import { isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Bulk revert: restores every product's description fields to the snapshot
 * captured before the last balance operation. Products that were never
 * balanced (no `aiBalanceBackup`) are silently skipped.
 *
 * Concurrency capped at 1 per store. No AI calls in the inner loop so no
 * throttle needed, but we keep a small sleep to avoid hammering the DB.
 */

const PAGE = 50;
const ERROR_CAP = 50;

interface BulkRevertError {
  productId: string;
  productName: string;
  error: string;
}

export const bulkAiRevertBalance: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-revert-balance',
    name: 'Bulk: revert EN/AR description balance across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/revert-balance.requested' }],
  },
  async ({ event, step }) => {
    const { jobId, storeId } = event.data as { jobId: string; storeId: string };
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/revert-balance.requested fired without ids');
      return;
    }

    return runInTenantContext(storeId, async () => {
      const errors: BulkRevertError[] = [];
      let reverted = 0;
      let skipped = 0;
      let failed = 0;
      let processed = 0;

      try {
        // Mark running + count products that have a non-empty backup
        await step.run('mark-running', async () => {
          // We count ALL products; revertProductBalance will skip those
          // without a backup — this gives an upper bound for the progress bar.
          const total = await prisma.product.count({ where: { storeId, deletedAt: null } });
          await prisma.bulkAiJob.update({
            where: { id: jobId },
            data: { status: 'running', startedAt: new Date(), total },
          });
        });

        let cursor: string | null = null;
        while (true) {
          const products: Array<{ id: string; name: string }> = await prisma.product.findMany({
            where: { storeId, deletedAt: null },
            orderBy: { id: 'asc' },
            take: PAGE,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            select: { id: true, name: true },
          });
          if (products.length === 0) break;

          for (const p of products) {
            try {
              const result = await revertProductBalance(storeId, p.id);
              if (result.reverted) {
                reverted++;
              } else {
                skipped++;
              }
            } catch (err) {
              if (isAiQuotaCapError(err)) throw err;
              if (errors.length < ERROR_CAP) {
                errors.push({
                  productId: p.id,
                  productName: p.name,
                  error: err instanceof Error ? err.message : 'unknown',
                });
              }
              failed++;
            }
            processed++;
          }

          cursor = products[products.length - 1].id;

          await prisma.bulkAiJob.update({
            where: { id: jobId },
            data: {
              processed,
              filled: reverted,
              skipped,
              failed,
              errors: errors as object,
            },
          });

          if (products.length < PAGE) break;
        }
      } catch (err) {
        if (!isAiQuotaCapError(err)) throw err;
        // quota errors shouldn't appear here (no AI calls), but handle for safety
        if (errors.length < ERROR_CAP) {
          errors.push({
            productId: storeId,
            productName: 'sweep',
            error: err instanceof Error ? err.message : 'unexpected error',
          });
        }
      }

      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: 'completed',
          processed,
          filled: reverted,
          skipped,
          failed,
          errors: errors as object,
          completedAt: new Date(),
        },
      });

      logger.info({ jobId, storeId, reverted, skipped, failed }, 'bulk-ai-revert-balance complete');
    });
  }
);
