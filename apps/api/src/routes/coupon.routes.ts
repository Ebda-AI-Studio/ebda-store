import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { couponValidateLimiter, writeLimiter } from '../middleware/security';
import { CouponService } from '../services/coupon.service';

const router = Router();

// Validation schemas
const createCouponSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .transform(s => s.toUpperCase()),
  name: z.string().min(1).max(100),
  nameAr: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  descriptionAr: z.string().max(500).optional(),
  type: z.enum(['percentage', 'fixed', 'free_shipping']),
  value: z.number().min(0),
  minOrderAmount: z.number().min(0).optional(),
  maxDiscount: z.number().min(0).optional(),
  usageLimit: z.number().int().min(1).optional(),
  usageLimitPerUser: z.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
  startsAt: z
    .string()
    .datetime()
    .optional()
    .transform(s => (s ? new Date(s) : undefined)),
  expiresAt: z
    .string()
    .datetime()
    .optional()
    .transform(s => (s ? new Date(s) : undefined)),
});

const updateCouponSchema = createCouponSchema.partial();

// GET /stores/:storeId/coupons - List all coupons
router.get(
  '/:storeId/coupons',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('coupons'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, isActive, search } = req.query;

      const result = await CouponService.list(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
        search: search as string,
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

// GET /stores/:storeId/coupons/:id - Get coupon by ID
router.get(
  '/:storeId/coupons/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('coupons'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const coupon = await CouponService.getById(storeId, id);

      res.json({
        success: true,
        data: { coupon },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/coupons - Create coupon
router.post(
  '/:storeId/coupons',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('coupons'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createCouponSchema.parse(req.body);

      const coupon = await CouponService.create(storeId, data);

      res.status(201).json({
        success: true,
        data: { coupon },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/coupons/:id - Update coupon
router.put(
  '/:storeId/coupons/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('coupons'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = updateCouponSchema.parse(req.body);

      const coupon = await CouponService.update(storeId, id, data);

      res.json({
        success: true,
        data: { coupon },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/coupons/:id - Delete coupon
router.delete(
  '/:storeId/coupons/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('coupons'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      await CouponService.delete(storeId, id);

      res.json({
        success: true,
        data: { message: 'Coupon deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /stores/:storeId/coupons/:id/toggle - Toggle coupon active status
router.patch(
  '/:storeId/coupons/:id/toggle',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('coupons'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const coupon = await CouponService.toggleActive(storeId, id);

      res.json({
        success: true,
        data: { coupon },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Public endpoint: Validate coupon code
// POST /public/stores/:storeId/coupons/validate
//
// Rate-limited at 20/min per IP to prevent brute-force code discovery.
// Responses are intentionally generic — we never reveal whether a code
// doesn't exist vs is expired vs is exhausted (all return INVALID_COUPON)
// so an attacker can't distinguish valid codes from invalid ones.
router.post(
  '/public/:storeId/coupons/validate',
  couponValidateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { code, orderTotal } = req.body;

      if (!code) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CODE', message: 'Coupon code is required' },
        });
        return;
      }

      let coupon;
      try {
        coupon = await CouponService.getByCode(storeId, code);
      } catch {
        // Return a generic response regardless of whether the code doesn't
        // exist, is expired, or is exhausted — prevents code enumeration.
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_COUPON', message: 'Coupon code is not valid' },
        });
        return;
      }

      // Check minimum order amount
      if (coupon.minOrderAmount && orderTotal && orderTotal < coupon.minOrderAmount) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MIN_ORDER_NOT_MET',
            message: `Minimum order amount of ${(coupon.minOrderAmount / 1000).toFixed(3)} KWD required`,
          },
        });
        return;
      }

      // Calculate discount if order total provided
      let discount = 0;
      if (orderTotal) {
        discount = CouponService.calculateDiscount(coupon, orderTotal);
      }

      res.json({
        success: true,
        data: {
          coupon: {
            id: coupon.id,
            code: coupon.code,
            name: coupon.name,
            nameAr: coupon.nameAr,
            type: coupon.type,
            value: coupon.value,
            minOrderAmount: coupon.minOrderAmount,
            maxDiscount: coupon.maxDiscount,
          },
          discount,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
