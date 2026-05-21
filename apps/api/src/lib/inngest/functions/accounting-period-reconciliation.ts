import type { InngestFunction } from 'inngest';
import { prisma, withRlsBypass } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';

/**
 * Cross-check: SUM(Order.total where paymentStatus='paid' AND createdAt in last 24h)
 * MUST equal SUM(JournalLine.credit where account.code IN ('4000','4010','2100')
 * AND postedAt in same window) per store. If they diverge, the GL has missed
 * a post — fire P0 alert.
 *
 * Runs at 22:30 UTC = 01:30 KW, after daily-close.
 */
export const accountingPeriodReconciliation: InngestFunction.Any = inngest.createFunction(
  {
    id: 'accounting-period-reconciliation',
    name: 'Accounting period reconciliation',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '30 22 * * *' }],
  },
  async ({ step }) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const stores = await step.run('list-stores', () =>
      prisma.store.findMany({
        where: { accountingEnabled: true, deletedAt: null },
        select: { id: true, slug: true, name: true },
      })
    );

    let drifts = 0;
    for (const store of stores) {
      const ops = await step.run(`ops-${store.id}`, () =>
        prisma.order.aggregate({
          where: { storeId: store.id, paymentStatus: 'paid', createdAt: { gte: since } },
          _sum: { total: true },
        })
      );

      const gl = await step.run(`gl-${store.id}`, async () => {
        // Cross-tenant cron — no tenant context; RLS would filter these
        // accounting reads to 0 rows. withRlsBypass sets the GUC inside
        // a transaction so the raw SQL sees actual posted journal lines.
        const rows = await withRlsBypass(
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
            body: `Store ${store.slug}: Orders.total=${opsTotal} fils, GL credits=${gl} fils, drift=${drift}`,
          })
        );
      }
    }

    logger.info({ stores: stores.length, drifts }, 'accounting-period-reconciliation completed');
    return { stores: stores.length, drifts };
  }
);
