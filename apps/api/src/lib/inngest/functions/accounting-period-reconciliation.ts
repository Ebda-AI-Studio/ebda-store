import type { JobDef } from '../../jobs/types';
import { withStore, storeDirectory } from '@ebda/database';
import { storeFilter } from '../../jobs/store-scope';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';
import { storeMoney } from '../../repo-factory';
import { netRevenue } from '../../../services/revenue.service';

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
      // PORTED (Ruling CF-JOBS-4): the operational total and the GL credits both follow the store's backend.
      // REVENUE-DEF-1: the operational side is the ONE revenue definition, paid-only, gross of partial refunds (the GL credits
      // below are gross of a partial adjustment). Before this it excluded only status cancelled/refunded, so a delivered order
      // whose payment was refunded sat on BOTH sides and a sale journal that never reversed raised no drift (STORE-QA-7).
      const ops = await step.run(`ops-${store.id}`, () =>
        netRevenue(store.id, { from: since, paidOnly: true, gross: true })
      );

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

      const opsTotal = Number(ops.revenue);
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
