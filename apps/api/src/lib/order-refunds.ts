/**
 * Refunded piastres per order, for code that pages Prisma-shaped rows (rollups, recovered-cart revenue) instead of running
 * the SQL fragment in lib/revenue-sql.ts. Same rule as `orderRefundedMinorSql`: GREATEST(sum of the order's COMPLETED non-exchange
 * returns' refund_amount, sum of its payments.refunded_amount) - one refund is recorded on both, so they are never added.
 * Works on Postgres and on a StoreDO store (`db` is `storeDb(storeId)`).
 */
import type { storeDb } from './repo-factory';
import {
  latestPaymentIsOnline,
  NON_REVENUE_ORDER_STATUSES,
  NON_REVENUE_PAYMENT_STATUSES,
  netOrderRevenueMinor,
} from './revenue-sql';

type StoreDbClient = Awaited<ReturnType<typeof storeDb>>;

export async function refundedMinorByOrder(
  db: StoreDbClient,
  storeId: string,
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
        where: { storeId, orderId: { in: ids }, status: 'completed', type: { not: 'exchange' } },
        _sum: { refundAmount: true },
      }),
      db.payment.groupBy({
        by: ['orderId'],
        where: { orderId: { in: ids } }, // payments carry no store_id: the ids are already this store's orders
        _sum: { refundedAmount: true },
      }),
    ]);
    for (const r of retRows) out.set(r.orderId, r._sum?.refundAmount ?? 0);
    for (const p of payRows)
      out.set(p.orderId, Math.max(out.get(p.orderId) ?? 0, p._sum?.refundedAmount ?? 0));
  }
  return out;
}

/**
 * Top spenders by NET sales (REVENUE-DEF-1) through the store's own backend (`storeDb`: its Durable Object, or Postgres), never raw
 * SQL on `public.orders`: Postgres is not reachable from the Worker for a Durable Object store. Pages the revenue-population orders
 * by keyset, nets each of its refunds and sums per customer. Same row shape the old `order.groupBy` returned.
 */
export async function topCustomersNet(
  db: StoreDbClient,
  storeId: string,
  limit = 10,
  pageSize = 1000
): Promise<Array<{ customerId: string | null; _sum: { total: number }; _count: number }>> {
  const byCustomer = new Map<string | null, { total: number; count: number }>();
  let cursor: string | undefined;
  for (;;) {
    const page = await db.order.findMany({
      where: {
        storeId,
        deletedAt: null,
        status: { notIn: [...NON_REVENUE_ORDER_STATUSES] },
        paymentStatus: { notIn: [...NON_REVENUE_PAYMENT_STATUSES] },
      },
      select: {
        id: true,
        customerId: true,
        total: true,
        status: true,
        paymentStatus: true,
        payments: { select: { id: true, provider: true, createdAt: true } },
      },
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    const refunded = await refundedMinorByOrder(
      db,
      storeId,
      page.map(o => o.id)
    );
    for (const o of page) {
      const net = netOrderRevenueMinor({
        total: o.total,
        status: o.status,
        paymentStatus: o.paymentStatus,
        refundedMinor: refunded.get(o.id) ?? 0,
        hasOnlinePayment: latestPaymentIsOnline(o.payments ?? []),
      });
      // an unpaid abandoned checkout nets to 0 and is not an order of the customer's either
      if (o.paymentStatus === 'unpaid' && net === 0 && o.total > 0) continue;
      const cur = byCustomer.get(o.customerId ?? null) ?? { total: 0, count: 0 };
      cur.total += net;
      cur.count += 1;
      byCustomer.set(o.customerId ?? null, cur);
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1]!.id;
  }
  return [...byCustomer.entries()]
    .map(([customerId, v]) => ({ customerId, _sum: { total: v.total }, _count: v.count }))
    .sort((a, b) => b._sum.total - a._sum.total)
    .slice(0, limit);
}
