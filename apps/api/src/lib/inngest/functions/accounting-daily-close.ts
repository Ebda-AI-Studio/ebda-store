import type { JobDef } from '../../jobs/types';
import { withStore, storeDirectory } from '@ebda/database';
import logger from '../../logger';
import { inngest } from '../client';
import { storeFilter } from '../../jobs/store-scope';
import { sendAlert } from '../../../services/alerts.service';
import { storeMoney } from '../../repo-factory';

import { REGION } from '@ebda/shared';
/**
 * Nightly trial-balance integrity scan. For every store with accounting
 * enabled, sum SUM(DR) and SUM(CR) across ALL posted journal lines. If they
 * diverge by any amount, fire a P0 Telegram alert — the GL has drifted.
 *
 * Runs at 01:00 Cairo (`TZ=` cron; Egypt observes DST).
 */
export const accountingDailyClose: JobDef = inngest.createFunction(
  {
    id: 'accounting-daily-close',
    name: 'Accounting daily close',
    retries: 2,
    concurrency: { limit: 1 }, // serialize across all stores
    triggers: [{ cron: `TZ=${REGION.timezone} 0 1 * * *` }], // 01:00 Cairo (DST-aware via TZ=)
  },
  async ({ event, step }) => {
    // FORCE RLS: cross-tenant cron — use withRlsBypass to enumerate stores.
    const stores = await step.run('list-stores-with-accounting', () =>
      // `stores` is under RLS: a cron lists stores through the directory definer.
      storeDirectory(storeFilter(event, s => s.accountingEnabled)).then(list =>
        list.map(s => ({ id: s.id, name: s.name, slug: s.slug }))
      )
    );

    let drifts = 0;
    for (const store of stores) {
      const result = await step.run(`drift-${store.id}`, async () => {
        // Cross-tenant cron — no tenant context on this connection.
        // RLS on journal_entries/journal_lines would filter every read
        // to 0 rows. Read each store in its own scope for accurate sums.
        // PORTED (Ruling CF-JOBS-3): a store on its Durable Object sums its own posted ledger there.
        const money = await storeMoney(store.id);
        if (money) {
          const t = await money.trialBalance();
          return { dr: t.debit, cr: t.credit, drift: t.debit - t.credit };
        }
        const sums = await withStore(
          store.id,
          tx => tx.$queryRaw<{ total_debit: bigint; total_credit: bigint }[]>`
            SELECT
              COALESCE(SUM(l.debit), 0)  AS total_debit,
              COALESCE(SUM(l.credit), 0) AS total_credit
            FROM public.journal_lines l
            JOIN public.journal_entries e ON e.id = l.entry_id
            WHERE e.store_id = ${store.id} AND e.status = 'posted'
          `
        );
        const dr = Number(sums[0].total_debit);
        const cr = Number(sums[0].total_credit);
        return { dr, cr, drift: dr - cr };
      });

      if (result.drift !== 0) {
        drifts += 1;
        await step.run(`alert-${store.id}`, () =>
          sendAlert({
            level: 'p0',
            scope: 'store',
            store: { id: store.id, name: store.name, slug: store.slug ?? undefined },
            source: 'cron.accounting-daily-close',
            title: `Trial balance drift — ${store.name}`,
            body: `Store ${store.slug}: DR=${result.dr} CR=${result.cr} (drift ${result.drift} piastres)`,
          })
        );
      }
    }

    logger.info({ stores: stores.length, drifts }, 'accounting-daily-close completed');
    return { stores: stores.length, drifts };
  }
);
