import type { JobDef } from '../../jobs/types';
import { prisma, runInStoreScope } from '@ebda/database';
import logger from '../../logger';
import { inngest } from '../client';
import { createDraftForItem, finishCreateDrafts } from '../../../services/catalog-import.service';

/**
 * Create DRAFT products from the merchant's accepted catalogue items, one item per durable step.
 * Idempotent (a replay finds nothing left to do) and drafts-only: this function never publishes.
 * No model call here; the follow-on AI fill (search words, SEO, translation) comes from the normal
 * `product.upserted` hook, under its own bulk quota.
 */
export const catalogImportCreateDrafts: JobDef = inngest.createFunction(
  {
    id: 'catalog-import-create-drafts',
    name: 'Catalogue import: create draft products from accepted items',
    retries: 2,
    concurrency: { key: 'event.data.storeId', limit: 1 },
    triggers: [{ event: 'catalog-import/create-drafts' }],
    onFailure: async ({ event }) => {
      const d = event.data?.event?.data as { jobId?: string; storeId?: string } | undefined;
      if (!d?.jobId || !d.storeId) return;
      // Back to review so the job is never stuck "creating"; created drafts stay.
      await runInStoreScope(d.storeId, () =>
        prisma.catalogImportJob.updateMany({
          where: { id: d.jobId!, storeId: d.storeId!, status: 'creating' },
          data: { status: 'review', errorCode: 'DRAFTS_FAILED' },
        })
      ).catch(() => undefined);
    },
  },
  async ({ event, step }) => {
    const { jobId, storeId, itemIds } = (event.data ?? {}) as {
      jobId?: string;
      storeId?: string;
      itemIds?: string[];
    };
    if (!jobId || !storeId) {
      logger.warn('catalog-import/create-drafts fired without ids');
      return { skipped: 'missing-ids' };
    }
    const ids = await step.run('list', () =>
      runInStoreScope(storeId, async () =>
        (
          await prisma.catalogImportItem.findMany({
            where: {
              jobId,
              storeId,
              status: 'accepted',
              productId: null,
              ...(itemIds ? { id: { in: itemIds } } : {}),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true },
            take: 500,
          })
        ).map(i => i.id)
      )
    );
    const tally = { created: 0, failed: 0, skipped: 0 };
    for (const id of ids) {
      const r = await step.run(`create-${id}`, () =>
        runInStoreScope(storeId, () => createDraftForItem(storeId, id))
      );
      tally[r === 'created' ? 'created' : r === 'failed' ? 'failed' : 'skipped']++;
    }
    await step.run('finish', () =>
      runInStoreScope(storeId, () => finishCreateDrafts(storeId, jobId))
    );
    return tally;
  }
);
