/**
 * Net revenue over the ONE revenue definition (apps/api/src/lib/revenue-sql.ts, finding STORE-QA-7): the order population
 * excludes cancelled / refunded / failed-payment / unconfirmed orders, and each order counts its total MINUS what was
 * refunded (partial or full). A Postgres store runs it as raw SQL, a StoreDO store as the `analyticsNetRevenue` op - same SQL.
 * Every "total revenue" figure that is not a bespoke grouped query (KPI, platform dashboards, rollups, usage snapshot,
 * reconciliation, insights) calls this, so a refund cannot be sales on one screen and gone on another.
 */
import { Prisma, withStore } from '@ebda/database';
import { storeMoney } from '../lib/repo-factory';
import { orderNetRevenueSql, revenueOrderPredicateSql } from '../lib/revenue-sql';

export interface NetRevenueOpts {
  from?: Date;
  to?: Date;
  /** Paid-only population (rollups, funnel, usage snapshot, reconciliation): adds payment_status = 'paid'. */
  paidOnly?: boolean;
  /** Whole-order totals, no partial-refund netting (the GL reconciliation compares against gross posted credits). */
  gross?: boolean;
}

export async function netRevenue(
  storeId: string,
  opts: NetRevenueOpts = {}
): Promise<{ revenue: number; orders: number }> {
  const money = await storeMoney(storeId);
  if (money)
    return money.analyticsNetRevenue({
      startMs: opts.from?.getTime(),
      endMs: opts.to?.getTime(),
      paidOnly: opts.paidOnly,
      gross: opts.gross,
    });
  const from = opts.from ?? new Date(0);
  const to = opts.to ?? new Date('9999-01-01T00:00:00Z');
  // The two fragments are module constants (no user input); Prisma.raw splices them, every value stays a bound parameter.
  const net = Prisma.raw(opts.gross ? 'o.total' : orderNetRevenueSql('o', 'pg'));
  const counts = Prisma.raw(revenueOrderPredicateSql('o', { paidOnly: opts.paidOnly }));
  // withStore: callable from a job step (no ambient tenant context) as well as from a request; `orders` is FORCE RLS.
  const rows = await withStore(
    storeId,
    tx => tx.$queryRaw<Array<{ revenue: bigint; orders: bigint }>>`
    SELECT COALESCE(SUM(${net}), 0)::bigint AS revenue, COUNT(*)::bigint AS orders
      FROM public.orders o
     WHERE o.store_id = ${storeId} AND o.deleted_at IS NULL
       AND o.created_at >= ${from} AND o.created_at <= ${to}
       AND ${counts}`
  );
  return { revenue: Number(rows[0]?.revenue ?? 0), orders: Number(rows[0]?.orders ?? 0) };
}
