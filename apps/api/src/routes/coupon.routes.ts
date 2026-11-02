import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { storeDb } from '../lib/repo-factory';
import { prisma } from '@ebda/database';
import { authenticate, authorize, optionalAuthenticate, customerUserId } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import {
  couponValidateLimiter,
  couponValidateDistinctLimiter,
  writeLimiter,
  publicTenantLimiter,
} from '../middleware/security';
import { CouponService } from '../services/coupon.service';
import { resolveCustomerContext } from '../services/promotion-resolver';
import { buyerFromRequest } from '../lib/buyer-identity';
import { tenantContext } from '../middleware/tenant-context';

import { minorToDecimalString } from '@ebda/shared';
const router = Router();

// Mounted at the bare '/stores' prefix in routes/index.ts, so Express does
// NOT populate req.params.storeId at the mount level — every route below
// declares its own '/:storeId/...' path. router.param runs AFTER Express
// resolves :storeId for the matched route, so RLS tenant context is set
// correctly here. See F2, docs/plans/2026-07-02-rls-cutover.md.
router.param('storeId', tenantContext);

// Validation schemas
export const createCouponSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .transform(s => s.toUpperCase()),
  name: z.string().min(1).max(100),
  // Optional free text — `null` clears the column on an update, `undefined`
  // (omitted key) leaves it alone, same convention as customerGroupId /
  // minQuantity below. Without the null form an emptied field cannot clear.
  nameAr: z.string().max(100).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  descriptionAr: z.string().max(500).optional().nullable(),
  type: z.enum(['percentage', 'fixed', 'free_shipping']),
  value: z.number().min(0),
  // Limits/dates the merchant can clear — `null` removes the restriction
  // (no minimum / no cap / unlimited uses / never expires), `undefined`
  // (omitted key) leaves the stored value alone. Same convention as
  // nameAr/description above and customerGroupId/minQuantity below.
  minOrderAmount: z.number().min(0).nullish(),
  maxDiscount: z.number().min(0).nullish(),
  usageLimit: z.number().int().min(1).nullish(),
  usageLimitPerUser: z.number().int().min(1).nullish(),
  isActive: z.boolean().optional(),
  // `.nullable()` runs BEFORE the transform so `null` bypasses the
  // `.datetime()` format check entirely instead of being coerced into
  // `new Date(null)` (which is the epoch, not "no restriction") or being
  // dropped to `undefined` (which would silently leave the old date in
  // place instead of clearing it).
  startsAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .transform(s => (s == null ? s : new Date(s))),
  expiresAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .transform(s => (s == null ? s : new Date(s))),
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

export const updateCouponSchema = createCouponSchema.partial();

// Same cart-item shape as promotion.routes.ts's preview endpoint — kept
// local (not imported) since each router already owns its own validation
// schemas in this codebase (see createCouponSchema above vs. promotion
// .routes.ts's createSchema).
const cartItemSchema = z.object({
  productId: z.string(),
  // Optional: the storefront cart only knows productId/quantity/price, never
  // category ids, so when they are absent the route resolves them from the
  // store's own products (see below) — the same way OrderService.create does.
  categoryIds: z.array(z.string()).optional(),
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
  /**
   * The WHOLE loose cart (tier / group priced lines included), which a free-shipping code is judged on (Ruling B2B-M2,
   * final review P2-3); `orderTotal` / `cartItems` stay the base-priced basis every other coupon type uses (B2B-5).
   * Optional: a client that sends neither keeps the base-priced judgement.
   */
  looseOrderTotal: z.number().int().min(0).optional(),
  looseCartItems: cartItemsSchema.optional(),
});

/**
 * Fill in category ids for quote lines that did not carry them, from this
 * store's own products — the same source OrderService.create builds its
 * targeting snapshot from, so a category-scoped coupon is judged here exactly
 * as it will be at checkout. A line whose product is not in this store keeps
 * an empty list (it can still count toward an unscoped coupon, as it would in
 * the order), never another store's categories.
 */
async function withCategoryIds(
  storeId: string,
  items: z.infer<typeof cartItemsSchema>
): Promise<Array<z.infer<typeof cartItemSchema> & { categoryIds: string[] }>> {
  const missing = items.filter(i => !i.categoryIds).map(i => i.productId);
  if (missing.length === 0) {
    return items.map(i => ({ ...i, categoryIds: i.categoryIds ?? [] }));
  }
  const products = await (
    await storeDb(storeId)
  ).product.findMany({
    where: { id: { in: [...new Set(missing)] }, storeId },
    select: { id: true, categories: { select: { categoryId: true } } },
  });
  const byId = new Map(products.map(p => [p.id, p.categories.map(c => c.categoryId)]));
  return items.map(i => ({ ...i, categoryIds: i.categoryIds ?? byId.get(i.productId) ?? [] }));
}

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
  // Distinct-code budget shared with /orders/quote + /orders (enumeration needs distinct codes).
  couponValidateDistinctLimiter,
  // Per-tenant aggregate backstop (audit P3) — bounds distributed volume
  // against one store's endpoint regardless of source-IP spread.
  publicTenantLimiter,
  // Issue 2066: a signed-in shopper's group is keyed off their ACCOUNT at
  // order-create; the quote must see the same verified identity (never a
  // body-supplied one). Guests pass through untouched.
  optionalAuthenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { code, orderTotal: basisOrderTotal } = req.body;
      // Validated separately from code/orderTotal (left untouched below) so
      // a malformed cartItems/phone/email (e.g. an object or array instead
      // of a string) fails with a clean 400 here rather than reaching
      // Prisma inside resolveCustomerContext as an uncontrolled 500.
      const parsed = validateTargetingSchema.parse(req.body);
      const { phone, email } = parsed;

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

      // A free-shipping code is judged on the whole loose cart (Ruling B2B-M2), exactly as OrderService.create does.
      const looseBasis = coupon.type === 'free_shipping';
      const orderTotal =
        looseBasis && parsed.looseOrderTotal != null ? parsed.looseOrderTotal : basisOrderTotal;
      const cartItems =
        looseBasis && parsed.looseCartItems ? parsed.looseCartItems : parsed.cartItems;

      // Check minimum order amount. `orderTotal != null` rather than a
      // truthiness check: a bundle-only cart's basis is legitimately `0`
      // (P2-a) — the old truthy guard skipped this check entirely for that
      // cart, so the quote said "applied" and checkout then 400ed at
      // order.service.ts's own minOrderAmount gate with no way for the
      // customer to recover short of clearing the code.
      if (coupon.minOrderAmount && orderTotal != null && orderTotal < coupon.minOrderAmount) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MIN_ORDER_NOT_MET',
            message: `Minimum order amount of ${minorToDecimalString(coupon.minOrderAmount)} EGP required`,
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
        // The customer id comes ONLY from a verified token (customerUserId),
        // exactly the identity OrderService.create resolves the group from.
        const signedInCustomerId = customerUserId(req);
        // Group membership comes from the SESSION only (Ruling B2B-2c/2e); the typed phone / email never confer a group.
        const custCtx = await resolveCustomerContext(
          storeId,
          { phone, email, customerId: signedInCustomerId ?? null },
          buyerFromRequest(req)
        );
        const ctx = {
          ...custCtx,
          // Unknown is not ineligible. The cart page quotes before the shopper
          // has typed any identity, and resolveCustomerContext answers "no
          // group" for that — which would refuse a customer-group code to the
          // very members it was made for. Checkout sends the typed phone/email,
          // and OrderService.create re-evaluates against the real identity.
          // (First-order already resolves permissively with no identity.)
          //
          //
          // Issue 2066 (and the PR 2301 audit): the quote resolves the group
          // from the SAME identity order-create does — the signed-in account
          // when there is one — so a VIP typing a recipient's phone is quoted
          // by their account. A guest whose typed contact matches no Customer
          // row stays refused: order-create would refuse them too (hard 400),
          // and quoting a code that checkout then rejects is worse.
          customerGroupId:
            phone || email || signedInCustomerId ? custCtx.customerGroupId : coupon.customerGroupId,
          cartItems: await withCategoryIds(storeId, cartItems),
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
