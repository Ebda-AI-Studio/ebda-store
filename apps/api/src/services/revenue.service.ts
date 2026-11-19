/**
 * Net revenue over the ONE revenue definition (apps/api/src/lib/revenue-sql.ts, finding STORE-QA-7): the order population
 * excludes cancelled / refunded / failed-payment / unconfirmed orders, and each order counts its total MINUS what was
 * refunded (partial or full). A Postgres store runs it as raw SQL, a StoreDO store as the `analyticsNetRevenue` op - same SQL.
 * Every "total revenue" figure that is not a bespoke grouped query (KPI, platform dashboards, rollups, usage snapshot,
 * reconciliation, insights) calls this, so a refund cannot be sales on one screen and gone on another.
 */
import { Prisma, withStore } from '@ebda/database';
import { storeMoney } from '../lib/repo-factory';
import { orderNetRevenueSql, refundJoinsSql, revenueOrderPredicateSql } from '../lib/revenue-sql';

interface NetRevenueOpts {
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
  const counts = Prisma.raw(revenueOrderPredicateSql('o', 'pg', { paidOnly: opts.paidOnly }));
  // withStore: callable from a job step (no ambient tenant context) as well as from a request; `orders` is FORCE RLS.
  const rows = await withStore(
    storeId,
    tx => tx.$queryRaw<Array<{ revenue: bigint; orders: bigint }>>`
    SELECT COALESCE(SUM(${net}), 0)::bigint AS revenue, COUNT(*)::bigint AS orders
      FROM public.orders o
      ${Prisma.raw(refundJoinsSql('o', 'pg'))}
     WHERE o.store_id = ${storeId} AND o.deleted_at IS NULL
       AND o.created_at >= ${from} AND o.created_at <= ${to}
       AND ${counts}`
  );
  return { revenue: Number(rows[0]?.revenue ?? 0), orders: Number(rows[0]?.orders ?? 0) };
}

/**
 * `netRevenue` for many [from, to) windows in ONE query (the funnel rollup's per-day totals), one row per window in order.
 * At most 400 windows. A StoreDO store runs the `analyticsNetRevenueDays` op; Postgres a single grouped query over the windows.
 */
export async function netRevenueWindows(
  storeId: string,
  windows: Array<{ from: Date; to: Date }>,
  opts: { paidOnly?: boolean } = {}
): Promise<Array<{ revenue: number; orders: number }>> {
  if (windows.length === 0) return [];
  if (windows.length > 400) throw new Error('netRevenueWindows: at most 400 windows');
  const money = await storeMoney(storeId);
  if (money)
    return money.analyticsNetRevenueDays({
      windows: windows.map(w => ({ fromMs: w.from.getTime(), toMs: w.to.getTime() })),
      paidOnly: opts.paidOnly,
    });
  // epoch-ms integers only (Number.isInteger), so the VALUES list is built from numbers, never from text
  const values = windows
    .map((w, i) => {
      const f = w.from.getTime();
      const t = w.to.getTime();
      if (!Number.isInteger(f) || !Number.isInteger(t))
        throw new Error('netRevenueWindows: bad window');
      return `(${i}, to_timestamp(${f} / 1000.0), to_timestamp(${t} / 1000.0))`;
    })
    .join(', ');
  const net = Prisma.raw(orderNetRevenueSql('o', 'pg'));
  const counts = Prisma.raw(revenueOrderPredicateSql('o', 'pg', { paidOnly: opts.paidOnly }));
  const rows = await withStore(
    storeId,
    tx =>
      tx.$queryRaw<Array<{ i: number; revenue: bigint; orders: bigint }>>`
    SELECT w.i AS i, COALESCE(SUM(${net}), 0)::bigint AS revenue, COUNT(*)::bigint AS orders
      FROM (VALUES ${Prisma.raw(values)}) AS w(i, f, t)
      JOIN public.orders o ON o.created_at >= w.f AND o.created_at < w.t
      ${Prisma.raw(refundJoinsSql('o', 'pg'))}
     WHERE o.store_id = ${storeId} AND o.deleted_at IS NULL AND ${counts}
     GROUP BY w.i`
  );
  const byI = new Map(rows.map(r => [Number(r.i), r]));
  return windows.map((_, i) => ({
    revenue: Number(byI.get(i)?.revenue ?? 0),
    orders: Number(byI.get(i)?.orders ?? 0),
  }));
}
