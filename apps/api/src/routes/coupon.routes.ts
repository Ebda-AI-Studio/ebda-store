import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { couponValidateLimiter, writeLimiter, publicTenantLimiter } from '../middleware/security';
import { CouponService } from '../services/coupon.service';
import { resolveCustomerContext } from '../services/promotion-resolver';
import { tenantContext } from '../middleware/tenant-context';

const router = Router();

// Mounted at the bare '/stores' prefix in routes/index.ts, so Express does
// NOT populate req.params.storeId at the mount level — every route below
// declares its own '/:storeId/...' path. router.param runs AFTER Express
// resolves :storeId for the matched route, so RLS tenant context is set
// correctly here. See F2, docs/plans/2026-07-02-rls-cutover.md.
router.param('storeId', tenantContext);

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
  // Targeting — shared shape with Promotion (see promotion.routes.ts's
  // createSchema). All optional/empty = "everyone, whole cart" so existing
  // coupons are unchanged. CouponService.create/update already accepts
  // these; this schema previously stripped them before they got there.
  customerGroupId: z.string().uuid().nullish(),
  firstOrderOnly: z.boolean().optional(),
  minQuantity: z.number().int().min(1).nullish(),
  scopeProductIds: z.array(z.string().uuid()).max(500).optional(),
  scopeCategoryIds: z.array(z.string().uuid()).max(200).optional(),
});

const updateCouponSchema = createCouponSchema.partial();

// Same cart-item shape as promotion.routes.ts's preview endpoint — kept
// local (not imported) since each router already owns its own validation
// schemas in this codebase (see createCouponSchema above vs. promotion
// .routes.ts's createSchema).
const cartItemSchema = z.object({
  productId: z.string(),
  categoryIds: z.array(z.string()),
  quantity: z.number().int().min(0),
  lineTotal: z.number().int().min(0),
});
const cartItemsSchema = z.array(cartItemSchema).max(500);

// Targeting inputs on the public validate endpoint below (cartItems/phone/
// email) — validated up front so a malformed value (object/array instead of
// a string) is rejected with a clean 400 instead of reaching Prisma as an
// uncontrolled 500. `cartItems` stays optional here: its absence must leave
// the existing whole-cart `orderTotal` behavior byte-for-byte unchanged.
const validateTargetingSchema = z.object({
  cartItems: cartItemsSchema.optional(),
  phone: z.string().nullish(),
  email: z.string().nullish(),
});

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
  // Per-tenant aggregate backstop (audit P3) — bounds distributed volume
  // against one store's endpoint regardless of source-IP spread.
  publicTenantLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { code, orderTotal } = req.body;
      // Validated separately from code/orderTotal (left untouched below) so
      // a malformed cartItems/phone/email (e.g. an object or array instead
      // of a string) fails with a clean 400 here rather than reaching
      // Prisma inside resolveCustomerContext as an uncontrolled 500.
      const { cartItems, phone, email } = validateTargetingSchema.parse(req.body);

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

      // Calculate discount. Callers that pass cartItems get fine-grained
      // targeting (customer group, first-order, product/category scope)
      // evaluated against the matching subtotal; callers that only send
      // orderTotal (no cartItems) keep the original whole-cart calculation
      // — this branch is intentionally untouched so existing callers are
      // unaffected.
      //
      // free_shipping is NOT excluded here. It has no cart-targeted discount
      // math, which is why it used to skip this branch entirely — but skipping
      // it also skipped the ELIGIBILITY check, so this route reported a
      // free-shipping code as valid regardless of customer group, first-order,
      // minimum quantity or product scope. order.service.ts now evaluates
      // targeting for every coupon type at checkout, so leaving this route
      // permissive would show the customer a valid coupon and then reject it
      // at the last step. The discount it computes for free_shipping is zero
      // by design; the benefit is the zeroed shipping line, applied at order
      // creation.
      let discount = 0;
      if (Array.isArray(cartItems) && cartItems.length > 0) {
        // This route is unauthenticated (public storefront), so identity is
        // resolved from phone/email only — NOT a client-supplied customerId.
        // Accepting a body customerId here would let an attacker probe any
        // other customer's segment/first-order status without proving they
        // are that customer.
        const ctx = {
          ...(await resolveCustomerContext(storeId, { phone, email })),
          cartItems,
        };
        const evalResult = CouponService.evaluateForCart(coupon, ctx);
        if (!evalResult.eligible) {
          res.status(400).json({
            success: false,
            error: {
              code: 'COUPON_NOT_ELIGIBLE',
              message: 'This coupon does not apply to your cart.',
            },
          });
          return;
        }
        discount = evalResult.discount;
      } else if (orderTotal) {
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
