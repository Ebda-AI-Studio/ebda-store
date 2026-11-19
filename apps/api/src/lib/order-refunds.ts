/**
 * Refunded piastres per order, for code that pages Prisma-shaped rows (rollups, recovered-cart revenue) instead of running
 * the SQL fragment in lib/revenue-sql.ts. Same rule as `orderRefundedMinorSql`: GREATEST(sum of the order's COMPLETED non-exchange
 * returns' refund_amount, sum of its payments.refunded_amount) - one refund is recorded on both, so they are never added.
 * Works on Postgres and on a StoreDO store (`db` is `storeDb(storeId)`).
 */
import type { storeDb } from './repo-factory';

export async function refundedMinorByOrder(
  db: Awaited<ReturnType<typeof storeDb>>,
  orderIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  // chunked: a store's order book can be thousands of ids (the customers page scans up to its cap)
  for (let i = 0; i < orderIds.length; i += 500) {
    const ids = orderIds.slice(i, i + 500);
    const [retRows, payRows] = await Promise.all([
      db.return.groupBy({
        by: ['orderId'],
        where: { orderId: { in: ids }, status: 'completed', type: { not: 'exchange' } },
        _sum: { refundAmount: true },
      }),
      db.payment.groupBy({
        by: ['orderId'],
        where: { orderId: { in: ids } },
        _sum: { refundedAmount: true },
      }),
    ]);
    for (const r of retRows) out.set(r.orderId, r._sum?.refundAmount ?? 0);
    for (const p of payRows)
      out.set(p.orderId, Math.max(out.get(p.orderId) ?? 0, p._sum?.refundedAmount ?? 0));
  }
  return out;
}
