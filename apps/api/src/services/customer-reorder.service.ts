import { storeDb } from '../lib/repo-factory';
import { prisma } from '@ebda/database';

/** Orders looked at, and products returned, by "order again" (Ruling B4-8). */
export const REORDER_ORDERS = 3;
export const REORDER_MAX = 12;

/**
 * "Order again" (Phase B4, Lamma; Ruling B4-8): the DISTINCT products from the customer's last
 * three paid or delivered orders, newest order first (inside one order: the biggest line first,
 * then by name, so the answer is deterministic), at most 12, that are still on sale
 * (published, not deleted).
 *
 * CACHE CLASS (Ruling B4-8, rule 3): the id list is per customer and is NEVER cached: the route
 * answers `private, no-store`, and every query below carries `storeId` and `customerId`. It
 * returns ids only. The storefront resolves current name, price and availability through the same
 * tagged public product read every listing uses (BOUNDED-stale, invalidated by
 * `invalidateStoreProductCaches` on every product write), keeps only what `canBuyNow`, and the
 * add action re-checks stock and price server-side at add-to-cart, so a stale row can mislead a
 * tap but never a charge.
 *
 * "Paid or delivered" = `paymentStatus: paid` or `status: delivered` (cash on delivery is paid
 * when it is delivered); cancelled and refunded orders never count.
 */
export class CustomerReorderService {
  static async productIds(
    storeId: string,
    customerId: string,
    limit: number = REORDER_MAX
  ): Promise<string[]> {
    const cap = Math.min(REORDER_MAX, Math.max(1, Math.floor(limit) || REORDER_MAX));
    const orders = await (
      await storeDb(storeId)
    ).order.findMany({
      where: {
        storeId,
        customerId,
        deletedAt: null,
        status: { notIn: ['cancelled', 'refunded'] },
        OR: [{ paymentStatus: 'paid' }, { status: 'delivered' }],
      },
      orderBy: { createdAt: 'desc' },
      take: REORDER_ORDERS,
      select: {
        items: {
          select: { productId: true },
          orderBy: [{ total: 'desc' }, { productName: 'asc' }, { id: 'asc' }],
        },
      },
    });
    const ordered: string[] = [];
    for (const order of orders)
      for (const item of order.items)
        if (!ordered.includes(item.productId)) ordered.push(item.productId);
    if (ordered.length === 0) return [];
    const live = await (
      await storeDb(storeId)
    ).product.findMany({
      where: { storeId, id: { in: ordered }, status: 'active', deletedAt: null },
      select: { id: true },
    });
    const liveIds = new Set(live.map(p => p.id));
    return ordered.filter(id => liveIds.has(id)).slice(0, cap);
  }
}
