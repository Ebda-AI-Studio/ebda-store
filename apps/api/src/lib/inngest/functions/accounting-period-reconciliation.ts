import type { InngestFunction } from 'inngest';
import { withStore, storeDirectory } from '@ebda/database';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';

import { REGION } from '@ebda/shared';
/**
 * Cross-check: SUM(Order.total where paymentStatus='paid' AND createdAt in last 24h)
 * MUST equal SUM(JournalLine.credit where account.code IN ('4000','4010','2100')
 * AND postedAt in same window) per store. If they diverge, the GL has missed
 * a post — fire P0 alert.
 *
 * Runs at 01:30 Cairo (`TZ=` cron), after daily-close.
 */
export const accountingPeriodReconciliation: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-period-reconciliation',
    name: 'Accounting period reconciliation',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: `TZ=${REGION.timezone} 30 1 * * *` }],
  },
  async ({ step }) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const stores = await step.run('list-stores', () =>
      // `stores` is under RLS: a cron lists stores through the directory definer.
      storeDirectory(s => s.accountingEnabled).then(list =>
        list.map(s => ({ id: s.id, slug: s.slug, name: s.name }))
      )
    );

    let drifts = 0;
    for (const store of stores) {
      const ops = await step.run(`ops-${store.id}`, () =>
        // Cross-tenant cron — Inngest workers run without any HTTP context
        // so no tenant GUC is set. With FORCE ROW LEVEL SECURITY in place
        // (migration 20260530000000_force_rls_enforcement) the orders policy
        // runs for every connection, including `ebda_app`. Wrapping with
        // withStore scopes the read to this store (no ambient GUC to rely on),
        // while the explicit storeId + paymentStatus WHERE clause preserves
        // application-level scoping as defense-in-depth.
        withStore(store.id, async tx => {
          const result = await tx.order.aggregate({
            // Exclude cancelled/refunded orders: their revenue was intentionally
            // REVERSED in the GL (net-zero credits), so counting their total on
            // the ops side produces phantom drift. A paid-then-cancelled order
            // stays paymentStatus='paid' (only a provider refund flips that),
            // so without this filter every paid-order cancellation fires a
            // false P0 GL-drift alert.
            where: {
              storeId: store.id,
              paymentStatus: 'paid',
              status: { notIn: ['cancelled', 'refunded'] },
              createdAt: { gte: since },
            },
            _sum: { total: true },
          });
          return result;
        })
      );

      const gl = await step.run(`gl-${store.id}`, async () => {
        // Cross-tenant cron — no tenant context; RLS would filter these
        // accounting reads to 0 rows. withStore sets the GUC inside
        // a transaction so the raw SQL sees actual posted journal lines.
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
