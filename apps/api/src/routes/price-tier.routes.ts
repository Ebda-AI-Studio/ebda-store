/**
 * Merchant price tiers: /stores/:storeId/products/:productId/price-tiers (B2B Task 4).
 * authenticate -> authorize(store_admin, super_admin) -> requireStoreAccess -> [requireFeature('b2b.wholesale') on writes].
 * Reads stay open on a downgraded store (the merchant must see and clean up what is configured; the resolver ignores tiers
 * while the feature is off). Zod `.strict()` at the edge: an unknown key, including any `price`-shaped one, is a 400.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { tenantContext } from '../middleware/tenant-context';
import { PriceTierService } from '../services/price-tier.service';

const router = Router();
router.param('storeId', tenantContext);

const MINOR_MAX = 2_147_483_647;
const createSchema = z
  .object({
    variantId: z.string().uuid().nullish(),
    groupId: z.string().uuid().nullish(),
    minQty: z.number().int().min(2).max(1_000_000),
    priceMinor: z.number().int().min(0).max(MINOR_MAX),
  })
  .strict();
const updateSchema = z
  .object({
    minQty: z.number().int().min(2).max(1_000_000).optional(),
    priceMinor: z.number().int().min(0).max(MINOR_MAX).optional(),
  })
  .strict()
  .refine(v => v.minQty !== undefined || v.priceMinor !== undefined, {
    message: 'Nothing to update',
  });

const base = '/:storeId/products/:productId/price-tiers';
const guard = [authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess];

router.get(base, ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tiers = await PriceTierService.list(req.params.storeId, req.params.productId);
    res.json({ success: true, data: { tiers } });
  } catch (e) {
    next(e);
  }
});

router.post(
  base,
  ...guard,
  requireFeature('b2b.wholesale'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = createSchema.parse(req.body);
      const out = await PriceTierService.create(req.params.storeId, req.params.productId, input);
      res.status(201).json({ success: true, data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.put(
  `${base}/:tierId`,
  ...guard,
  requireFeature('b2b.wholesale'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = updateSchema.parse(req.body);
      const out = await PriceTierService.update(
        req.params.storeId,
        req.params.productId,
        req.params.tierId,
        input
      );
      res.json({ success: true, data: out });
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  `${base}/:tierId`,
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await PriceTierService.remove(req.params.storeId, req.params.productId, req.params.tierId);
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  }
);

export default router;
