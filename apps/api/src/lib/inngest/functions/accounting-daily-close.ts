import type { InngestFunction } from 'inngest';
import { prisma, withRlsBypass } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';

/**
 * Nightly trial-balance integrity scan. For every store with accounting
 * enabled, sum SUM(DR) and SUM(CR) across ALL posted journal lines. If they
 * diverge by any amount, fire a P0 Telegram alert — the GL has drifted.
 *
 * Runs at 22:00 UTC = 01:00 KW (Kuwait is UTC+3).
 */
export const accountingDailyClose: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-daily-close',
    name: 'Accounting daily close',
    retries: 2,
    concurrency: { limit: 1 }, // serialize across all stores
    triggers: [{ cron: '0 22 * * *' }],
  },
  async ({ step }) => {
    const stores = await step.run('list-stores-with-accounting', () =>
      prisma.store.findMany({
        where: { accountingEnabled: true, deletedAt: null },
        select: { id: true, name: true, slug: true },
      })
    );

    let drifts = 0;
    for (const store of stores) {
      const result = await step.run(`drift-${store.id}`, async () => {
        // Cross-tenant cron — no tenant context on this connection.
        // RLS on journal_entries/journal_lines would filter every read
        // to 0 rows. Wrap in withRlsBypass for accurate sums.
        const sums = await withRlsBypass(
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
            body: `Store ${store.slug}: DR=${result.dr} CR=${result.cr} (drift ${result.drift} fils)`,
          })
        );
      }
    }

    logger.info({ stores: stores.length, drifts }, 'accounting-daily-close completed');
    return { stores: stores.length, drifts };
  }
);
