import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { abandonedCartService } from '../services/abandoned-cart.service';
import { prisma } from '@force/database';
import { config } from '../config';
import { tenantContext } from '../middleware/tenant-context';

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
      const stats = await abandonedCartService.getStats(storeId);

      res.json({
        success: true,
        data: { stats },
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

      const abandonedCart = await prisma.abandonedCart.findUnique({
        where: { id },
        include: {
          customer: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          },
        },
      });

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

// ==========================================
// Public Route — Cart Recovery
// ==========================================

// GET /stores/public/:storeId/cart/recover/:abandonedCartId — the literal
// '/public' segment plus the '/stores' mount gives the same
// '/stores/public/...' storefront shape as shipping/coupons/wallet.
router.get(
  '/public/:storeId/cart/recover/:abandonedCartId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, abandonedCartId } = req.params;
      const { sig } = req.query;

      // HMAC verification
      const expected = crypto
        .createHmac('sha256', config.encryptionKey)
        .update(abandonedCartId)
        .digest('hex');

      if (sig !== expected) {
        res.status(403).json({
          success: false,
          error: { code: 'INVALID_SIGNATURE', message: 'Invalid or expired recovery link' },
        });
        return;
      }

      // Load abandoned cart
      const abandonedCart = await prisma.abandonedCart.findUnique({
        where: { id: abandonedCartId },
        include: {
          coupon: {
            select: { code: true },
          },
        },
      });

      if (!abandonedCart || abandonedCart.storeId !== storeId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Recovery link not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          cartItems: abandonedCart.cartItems,
          couponCode: abandonedCart.coupon?.code ?? null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
