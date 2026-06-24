import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
import { balanceProductLanguages } from '../../../services/ai-autofill.service';
import { isAiQuotaCapError } from '../../ai-quota';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Bulk description-language balancer. Walks every active product for the
 * store, detects which language (EN/AR) has the richer description, and
 * translates it into the thinner language. Writes a revert snapshot before
 * touching each product so the merchant can always undo via the per-product
 * or bulk-revert routes.
 *
 * Concurrency capped at 1 per store (matching the translate bulk pattern).
 * 2.5s throttle between calls to stay within Gemini free-tier RPM.
 */

const THROTTLE_MS = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const PAGE = 25;
const ERROR_CAP = 50;

interface BulkBalanceError {
  productId: string;
  productName: string;
  error: string;
}

export const bulkAiBalanceDescriptions: InngestFunction.Any = inngest.createFunction(
  {
    id: 'bulk-ai-balance-descriptions',
    name: 'Bulk: balance EN/AR descriptions across catalogue',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    retries: 2,
    triggers: [{ event: 'bulk-ai/balance-descriptions.requested' }],
  },
  async ({ event, step }) => {
    const { jobId, storeId } = event.data as { jobId: string; storeId: string };
    if (!jobId || !storeId) {
      logger.warn('bulk-ai/balance-descriptions.requested fired without ids');
      return;
    }

    return runInTenantContext(storeId, async () => {
      const errors: BulkBalanceError[] = [];
      let balanced = 0;
      let skipped = 0;
      let failed = 0;
      let processed = 0;
      let quotaReached = false;

      try {
        // Mark running and set total
        await step.run('mark-running', async () => {
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
              const result = await balanceProductLanguages(storeId, p.id, { force: false });
              if (result.balanced) {
                balanced++;
                await sleep(THROTTLE_MS);
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
              filled: balanced,
              skipped,
              failed,
              errors: errors as object,
            },
          });

          if (products.length < PAGE) break;
        }
      } catch (err) {
        if (!isAiQuotaCapError(err)) throw err;
        quotaReached = true;
        if (errors.length < ERROR_CAP) {
          errors.push({
            productId: storeId,
            productName: 'sweep',
            error: err instanceof Error ? err.message : 'AI quota cap reached',
          });
        }
      }

      await prisma.bulkAiJob.update({
        where: { id: jobId },
        data: {
          status: 'completed',
          processed,
          filled: balanced,
          skipped,
          failed,
          errors: errors as object,
          completedAt: new Date(),
        },
      });

      logger.info(
        { jobId, storeId, balanced, skipped, failed, quotaReached },
        'bulk-ai-balance-descriptions complete'
      );
    });
  }
);
