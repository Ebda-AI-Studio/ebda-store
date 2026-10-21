import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requirePermission } from '../middleware/rbac';
import { PACKING_SLIP_MAX_ORDERS, PackingSlipService } from '../services/packing-slip.service';

/**
 * Packing slips, mounted under `/stores/:storeId/orders` (before the order
 * router). Staff with `orders:read` only; the store is ALWAYS the URL's (after
 * `requireStoreAccess`), so a bulk print can never pull another store's
 * orders; the body is strict and the id list is capped.
 */
const router = Router({ mergeParams: true });

const guard = [
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requirePermission('orders:read'),
] as const;

const options = {
  size: z.enum(['a4', 'label']).default('a4'),
  locale: z.enum(['ar', 'en']).optional(),
};

function send(res: Response, html: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(html);
}

/** GET /stores/:storeId/orders/:orderId/packing-slip?size=a4|label&locale=ar|en */
router.get(
  '/:orderId/packing-slip',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = z.string().uuid().parse(req.params.orderId);
      const q = z.object(options).strict().parse(req.query);
      send(res, (await PackingSlipService.generateDetailed(req.params.storeId, [orderId], q)).html);
    } catch (error) {
      next(error);
    }
  }
);

/** POST /stores/:storeId/orders/packing-slips  { orderIds: uuid[1..100], size?, locale? } */
router.post('/packing-slips', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderIds, ...q } = z
      .object({
        orderIds: z.array(z.string().uuid()).min(1).max(PACKING_SLIP_MAX_ORDERS),
        ...options,
      })
      .strict()
      .parse(req.body);
    const { html, skippedIds } = await PackingSlipService.generateDetailed(
      req.params.storeId,
      orderIds,
      q
    );
    // Ids that printed nothing (not in this store / deleted): the viewer says "N orders skipped".
    if (skippedIds.length > 0) {
      res.setHeader('X-Packing-Slips-Skipped', skippedIds.join(','));
      res.setHeader('Access-Control-Expose-Headers', 'X-Packing-Slips-Skipped');
    }
    send(res, html);
  } catch (error) {
    next(error);
  }
});

export default router;
