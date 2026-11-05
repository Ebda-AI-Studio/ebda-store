import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { abandonedCartService } from '../services/abandoned-cart.service';
import {
  CART_EMAIL_MIN_DELAY_MINUTES,
  CART_EMAIL_MAX_DELAY_MINUTES,
} from '../services/cart-recovery-email.service';
import { config } from '../config';
import { tenantContext } from '../middleware/tenant-context';
import { GUEST_CHECKOUT_LOOKBACK_DAYS, storeTakesGuestOrders } from '../lib/guest-checkout';

const router = Router();

// Mounted ONLY at the bare '/stores' prefix in routes/index.ts (#1993: it
// used to be dual-mounted at '/public' too, which republished every admin
// route below under a prefix csrfProtection skips and
// restrictPlatformOnlyOrigins does not cover). Express does NOT populate
// req.params.storeId at the bare mount level —
// every route below declares its own '/:storeId/...' path. router.param
// runs AFTER Express resolves :storeId for the matched route, so RLS
// tenant context is set correctly here regardless of which mount reached
// it. See F2, docs/plans/2026-07-02-rls-cutover.md.
router.param('storeId', tenantContext);

// ==========================================
// Validation Schemas
// ==========================================

const upsertConfigSchema = z.object({
  step1Enabled: z.boolean().optional(),
  step1DelayMinutes: z.number().int().min(1).optional(),
  step2Enabled: z.boolean().optional(),
  step2DelayMinutes: z.number().int().min(1).optional(),
  step3Enabled: z.boolean().optional(),
  step3DelayMinutes: z.number().int().min(1).optional(),
  autoCouponEnabled: z.boolean().optional(),
  couponDiscountPercent: z.number().min(0).max(100).optional(),
  couponMaxDiscount: z.number().int().min(0).nullable().optional(),
  couponExpiryHours: z.number().int().min(1).optional(),
  emailEnabled: z.boolean().optional(),
  emailDelayMinutes: z
    .number()
    .int()
    .min(CART_EMAIL_MIN_DELAY_MINUTES)
    .max(CART_EMAIL_MAX_DELAY_MINUTES)
    .optional(),
});

// ==========================================
// Admin Routes
// ==========================================

// GET /stores/:storeId/abandoned-carts/stats
router.get(
  '/:storeId/abandoned-carts/stats',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('abandoned_cart'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const [stats, guestCheckout] = await Promise.all([
        abandonedCartService.getStats(storeId),
        // Guest carts are never recorded (no contact to recover them by), so
        // on a store that takes guest orders these counts are not tracked —
        // the page says so instead of showing 0.
        storeTakesGuestOrders(
          storeId,
          new Date(Date.now() - GUEST_CHECKOUT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
        ),
      ]);

      res.json({
        success: true,
        data: { stats, guestCheckout },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/abandoned-carts/config
router.get(
  '/:storeId/abandoned-carts/config',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('abandoned_cart'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const config = await abandonedCartService.getConfig(storeId);

      res.json({
        success: true,
        data: { config },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/abandoned-carts/config
router.put(
  '/:storeId/abandoned-carts/config',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('abandoned_cart'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = upsertConfigSchema.parse(req.body);

      const updatedConfig = await abandonedCartService.upsertConfig(storeId, data);

      res.json({
        success: true,
        data: { config: updatedConfig },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/abandoned-carts
router.get(
  '/:storeId/abandoned-carts',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('abandoned_cart'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, status } = req.query;

      const result = await abandonedCartService.listAbandoned(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        status: status as string | undefined,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/abandoned-carts/:id
router.get(
  '/:storeId/abandoned-carts/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('abandoned_cart'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const abandonedCart = await abandonedCartService.getAbandoned(storeId, id);

      if (!abandonedCart || abandonedCart.storeId !== storeId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Abandoned cart not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: { abandonedCart },
      });
    } catch (error) {
      next(error);
    }
  }
);

// The public `GET /stores/public/:storeId/cart/recover/:abandonedCartId`
// endpoint was removed (owner decision 2026-10-01, issue 2035): nothing called
// it, and reminder emails no longer carry a recovery link.

export default router;
