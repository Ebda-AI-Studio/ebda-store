import type { JobDef } from '../../jobs/types';
import { storeDirectory } from '@ebda/database';
import { withStoreDb } from '../../jobs/store-db';
import { storeFilter } from '../../jobs/store-scope';
import logger from '../../logger';
import { inngest } from '../client';
import { notifyMerchantOfApplications } from '../../wholesale-merchant-notify';

/**
 * 48h nudge (B2B review I5). Runs once a day. An application is nudged on the first run after it turns 48 hours old, and
 * on no other run, because each run only looks at applications whose age at run time is in [48h, 72h): with a 24h cadence
 * every application falls into exactly one such window, so no "nudged" flag (and no migration) is needed. The merchant gets
 * ONE message per store per day carrying the total pending count.
 */
export const NUDGE_WINDOW_MIN_HOURS = 48;
export const NUDGE_WINDOW_MAX_HOURS = 72;

export function nudgeWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - NUDGE_WINDOW_MAX_HOURS * 3_600_000),
    to: new Date(now.getTime() - NUDGE_WINDOW_MIN_HOURS * 3_600_000),
  };
}

/** Per-store work, exported for the test: returns the pending count that was nudged (0 = nothing to say). */
export async function nudgeStore(storeId: string, now: Date = new Date()): Promise<number> {
  const { from, to } = nudgeWindow(now);
  // PORTED (Ruling CF-JOBS-1): the counts follow the store's backend (its Durable Object or Postgres) through storeDb.
  const { crossing, pending } = await withStoreDb(storeId, async db => ({
    crossing: await db.wholesaleApplication.count({
      where: { storeId, status: 'pending', createdAt: { gt: from, lte: to } },
    }),
    pending: await db.wholesaleApplication.count({ where: { storeId, status: 'pending' } }),
  }));
  if (crossing === 0) return 0;
  await notifyMerchantOfApplications(storeId, 'nudge', { pendingCount: pending });
  return pending;
}

export const wholesalePendingNudgeCron: JobDef = inngest.createFunction(
  {
    id: 'wholesale-pending-nudge-cron',
    name: 'Wholesale applications - 48h merchant nudge',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 7 * * *' }],
  },
  async ({ event, step }) => {
    const stores = await step.run('list-stores', () =>
      storeDirectory(storeFilter(event)).then(list => list.map(s => ({ id: s.id })))
    );
    let nudged = 0;
    for (const store of stores) {
      const n = await step.run(`nudge-${store.id}`, () => nudgeStore(store.id));
      if (n > 0) nudged++;
    }
    logger.info({ stores: stores.length, nudged }, 'wholesale-pending-nudge: done');
    return { stores: stores.length, nudged };
  }
);
