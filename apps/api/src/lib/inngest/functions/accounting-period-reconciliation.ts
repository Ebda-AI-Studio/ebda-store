import type { JobDef } from '../../jobs/types';
import { withStore, storeDirectory } from '@ebda/database';
import { storeFilter } from '../../jobs/store-scope';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';
import { storeMoney, storeDb } from '../../repo-factory';

import { REGION } from '@ebda/shared';
/**
 * Cross-check: SUM(Order.total where paymentStatus='paid' AND createdAt in last 24h)
 * MUST equal SUM(JournalLine.credit where account.code IN ('4000','4010','2100')
 * AND postedAt in same window) per store. If they diverge, the GL has missed
 * a post — fire P0 alert.
 *
 * Runs at 01:30 Cairo (`TZ=` cron), after daily-close.
 */
export const accountingPeriodReconciliation: JobDef = inngest.createFunction(
  {
    id: 'accounting-period-reconciliation',
    name: 'Accounting period reconciliation',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: `TZ=${REGION.timezone} 30 1 * * *` }],
  },
  async ({ event, step }) => {
    // One window for the whole run: `now` is fixed in a step so a replay uses the same cutoff for
    // the ops and GL sides (a per-replay cutoff made them disagree and raised false drift).
    const sinceIso = await step.run('window', () =>
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    );
    const since = new Date(sinceIso);

    const stores = await step.run('list-stores', () =>
      // `stores` is under RLS: a cron lists stores through the directory definer.
      storeDirectory(storeFilter(event, s => s.accountingEnabled)).then(list =>
        list.map(s => ({ id: s.id, slug: s.slug, name: s.name }))
      )
    );

    let drifts = 0;
    for (const store of stores) {
      // PORTED (Ruling CF-JOBS-3): the operational total and the GL credits both follow the store's backend.
      const ops = await step.run(`ops-${store.id}`, async () => {
        const where = {
          storeId: store.id,
          paymentStatus: 'paid' as const,
          status: { notIn: ['cancelled' as const, 'refunded' as const] },
          createdAt: { gte: since },
        };
        const money = await storeMoney(store.id);
        if (money)
          return (await storeDb(store.id)).order.aggregate({ where, _sum: { total: true } });
        return withStore(store.id, tx => tx.order.aggregate({ where, _sum: { total: true } }));
      });

      const gl = await step.run(`gl-${store.id}`, async () => {
        const money = await storeMoney(store.id);
        if (money) return (await money.periodGlCredits({ sinceMs: since.getTime() })).total;
        const rows = await withStore(
          store.id,
          tx => tx.$queryRaw<{ total: bigint }[]>`
            SELECT COALESCE(SUM(l.credit), 0) AS total
            FROM public.journal_lines l
            JOIN public.journal_entries e ON e.id = l.entry_id
            JOIN public.accounts a       ON a.id = l.account_id
            WHERE e.store_id = ${store.id}
              AND e.status = 'posted'
              AND e.posted_at >= ${since}
              AND a.code IN ('4000', '4010', '2100')
          `
        );
        return Number(rows[0].total);
      });

      const opsTotal = Number(ops._sum.total ?? 0);
      const drift = opsTotal - gl;
      if (Math.abs(drift) > 0) {
        drifts += 1;
        await step.run(`alert-${store.id}`, () =>
          sendAlert({
            level: 'p0',
            scope: 'store',
            store: { id: store.id, name: store.name, slug: store.slug ?? undefined },
            source: 'cron.accounting-period-reconciliation',
            title: `GL/operational drift — ${store.name}`,
            body: `Store ${store.slug}: Orders.total=${opsTotal} piastres, GL credits=${gl} piastres, drift=${drift}`,
          })
        );
      }
    }

    logger.info({ stores: stores.length, drifts }, 'accounting-period-reconciliation completed');
    return { stores: stores.length, drifts };
  }
);
