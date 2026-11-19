import { Router, type Request, type Response } from 'express';
import { orderAddressParts } from '@ebda/shared';
import logger from '../lib/logger';
import { verifyOrderStatusLinkToken } from '../lib/order-status-link-token';
import { orderStatusLimiter } from '../middleware/order-status-limiter';
import { storeRepo } from '../lib/repo-factory';
import { resolvePublicStoreId } from '../utils/store-helpers';

/**
 * `GET /public/order-status/:token` - the guest-safe, read-only order summary behind the COD message's button
 * (Ruling WA-COD-V2-2). Needs a valid signed token for THIS request's store; any failure (bad, tampered,
 * expired, another store's token, order gone) is the same plain 404. The answer is minimal: order number,
 * status, items, total, and the delivery AREA only. Never phone, email, street or notes. Never cached, never
 * indexed, never sends a referrer. The guest view token is NOT accepted here or in any URL (SEC-15).
 */
// pq-allow(unused-export): test seam (injects a real limiter), imported by tests/unit/order-status-link.test.ts
export function orderStatusPublicRouter(limiter = orderStatusLimiter()): Router {
  const router = Router();
  router.get('/:token', limiter, async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const notFound = (): void =>
      void res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    try {
      const claim = verifyOrderStatusLinkToken(req.params.token);
      if (!claim) return void notFound();
      const requestStore = await resolvePublicStoreId(req);
      if (!requestStore || requestStore !== claim.storeId) return void notFound();
      const repo = await storeRepo(claim.storeId);
      const order = await repo.db.order.findFirst({
        where: { id: claim.orderId, storeId: claim.storeId, deletedAt: null },
        select: {
          orderNumber: true,
          status: true,
          paymentStatus: true,
          total: true,
          currency: true,
          createdAt: true,
          locale: true,
          shippingAddress: true,
          items: {
            select: { productName: true, variantName: true, variantNameAr: true, quantity: true },
          },
        },
      });
      if (!order) return void notFound();
      const ar = String(order.locale ?? 'ar').startsWith('ar');
      const area = orderAddressParts(
        (order.shippingAddress ?? {}) as Record<string, unknown>,
        ar ? 'ar' : 'en'
      ).locality;
      res.json({
        success: true,
        data: {
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
          total: order.total,
          currency: order.currency,
          createdAt: order.createdAt,
          locale: ar ? 'ar' : 'en',
          area: area ?? null,
          items: order.items.map(i => ({
            name: i.productName,
            variant: (ar ? i.variantNameAr : null) ?? i.variantName ?? null,
            quantity: i.quantity,
          })),
        },
      });
    } catch (err) {
      // Ids only: never the token, the address or the buyer.
      logger.error(
        { err: err instanceof Error ? err.message : 'unknown' },
        '[order-status] lookup failed'
      );
      res
        .status(500)
        .json({ success: false, error: { code: 'INTERNAL', message: 'Something went wrong' } });
    }
  });
  return router;
}

export default orderStatusPublicRouter();
