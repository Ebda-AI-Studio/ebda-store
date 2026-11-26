/**
 * Automatic promotion CRUD — applies without a code, unlike coupons. Same
 * targeting shape as customer-groups.routes.ts (which owns the customer
 * groups these promotions can target).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { storeDb } from '../lib/repo-factory';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import { authenticate, authorize, optionalAuthenticate } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import {
  promotionBrowsePreviewLimiter,
  promotionPreviewLimiter,
  publicTenantLimiter,
} from '../middleware/security';
import { PromotionService } from '../services/promotion.service';
import { resolveBestPromotion, resolveCustomerContext } from '../services/promotion-resolver';
import { tenantContext } from '../middleware/tenant-context';
import { buyerFromRequest } from '../lib/buyer-identity';
import { PriceResolver } from '../services/price-resolver.service';

const router = Router();

// Mounted at the bare '/stores' prefix in routes/index.ts, so Express does
// NOT populate req.params.storeId at the mount level — every route below
// declares its own '/:storeId/...' path. router.param runs AFTER Express
// resolves :storeId for the matched route, so RLS tenant context is set
// correctly here. Same shape as coupon.routes.ts / customer-groups.routes.ts.
router.param('storeId', tenantContext);

// free_shipping is a valid CouponType (shared with the `Coupon` model, where
// it is fully supported) but promotions have no shipping-line handler and
// `resolveBestPromotion` excludes the type outright — accepting it here
// would let a merchant create a free_shipping promotion that silently never
// applies. Rejected at this admin boundary until a shipping-line handler
// ships (automatic free-shipping promotions are a deferred fast-follow).
export const createSchema = z.object({
  name: z.string().min(1).max(150),
  nameAr: z.string().max(150).nullish(),
  description: z.string().max(2000).nullish(),
  descriptionAr: z.string().max(2000).nullish(),
  type: z.enum(['percentage', 'fixed']),
  value: z.number().int().min(0),
  maxDiscount: z.number().int().min(0).nullish(),
  priority: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
  startsAt: z.coerce.date().nullish(),
  expiresAt: z.coerce.date().nullish(),
  customerGroupId: z.string().uuid().nullish(),
  firstOrderOnly: z.boolean().optional(),
  minOrderAmount: z.number().int().min(0).nullish(),
  minQuantity: z.number().int().min(1).nullish(),
  scopeProductIds: z.array(z.string().uuid()).max(500).optional(),
  scopeCategoryIds: z.array(z.string().uuid()).max(200).optional(),
});

export const updateSchema = createSchema.partial();

// The storefront cart only carries product ids + quantities (no category
// ids — those live server-side on Product.categories), so the public
// preview endpoint resolves products itself rather than trusting a
// client-built targeting snapshot (a client could otherwise fabricate
// categoryIds/lineTotal to probe or fake promotion eligibility).
const previewItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(1),
});

const previewSchema = z.object({
  items: z.array(previewItemSchema).max(500),
  phone: z.string().nullish(),
  email: z.string().nullish(),
});
// The browse (PDP / cart) preview takes ONLY items: a typed phone / email would let a 120/min caller probe which
// phones are VIP / first-order customers. Unknown keys (phone, email, any identity field) are stripped, never read.
const browsePreviewSchema = z.object({ items: z.array(previewItemSchema).max(500) });

// GET /stores/:storeId/promotions - List all promotions
router.get(
  '/:storeId/promotions',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, isActive, search } = req.query;

      const result = await PromotionService.list(storeId, {
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

// GET /stores/:storeId/promotions/:id - Get promotion by ID
router.get(
  '/:storeId/promotions/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const promotion = await PromotionService.getById(storeId, id);

      res.json({
        success: true,
        data: { promotion },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/promotions - Create promotion
router.post(
  '/:storeId/promotions',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createSchema.parse(req.body);

      const promotion = await PromotionService.create(storeId, data);

      res.status(201).json({
        success: true,
        data: { promotion },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/promotions/:id - Update promotion
router.put(
  '/:storeId/promotions/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = updateSchema.parse(req.body);

      const promotion = await PromotionService.update(storeId, id, data);

      res.json({
        success: true,
        data: { promotion },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/promotions/:id - Delete promotion
router.delete(
  '/:storeId/promotions/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      await PromotionService.delete(storeId, id);

      res.json({
        success: true,
        data: { message: 'Promotion deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /stores/:storeId/promotions/:id/toggle - Toggle promotion active status
router.patch(
  '/:storeId/promotions/:id/toggle',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const promotion = await PromotionService.toggleActive(storeId, id);

      res.json({
        success: true,
        data: { promotion },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Public endpoint: preview the best automatic promotion for a cart
// POST /public/stores/:storeId/promotions/preview
//
// Rate-limited (20/min per IP) — same posture as the public
// coupons/validate endpoint below in coupon.routes.ts: NO
// authenticate/authorize, since storefront shoppers (including guests)
// need this before/during checkout to preview which automatic promotion
// applies. `router.param('storeId', tenantContext)` above still wraps this
// route (it declares its own ':storeId'), same as coupons/validate.
const makePreviewHandler =
  (browse: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { items, phone, email } = browse
        ? { ...browsePreviewSchema.parse(req.body), phone: undefined, email: undefined }
        : previewSchema.parse(req.body);

      // Lines are priced by the ONE resolver for the signed-in buyer (product level: the preview carries no variant, so a
      // variant with its own price is previewed at the product price, display only). A line priced by a tier or a group
      // price is excluded from the discount basis (Ruling B2B-5); the authoritative discount is recomputed at order creation.
      const buyer = buyerFromRequest(req);
      const products = await (
        await storeDb(storeId)
      ).product.findMany({
        where: { id: { in: items.map(i => i.productId) }, storeId },
        select: { id: true, price: true, categories: { select: { categoryId: true } } },
      });
      const productsById = new Map(products.map(p => [p.id, p]));
      const resolver = await PriceResolver.forBuyer(storeId, buyer);
      const priced = await resolver.priceCart(
        items.flatMap((item, i) => {
          const product = productsById.get(item.productId);
          return product
            ? [
                {
                  key: String(i),
                  product: { id: product.id, price: product.price },
                  qty: item.quantity,
                },
              ]
            : [];
        })
      );
      const cartItems = items.flatMap((item, i) => {
        const product = productsById.get(item.productId);
        const line = priced.get(String(i));
        if (!product || !line || line.source !== 'base') return [];
        return [
          {
            productId: item.productId,
            categoryIds: product.categories.map(c => c.categoryId),
            quantity: item.quantity,
            lineTotal: line.unitMinor * item.quantity,
          },
        ];
      });

      // Group membership comes from the SESSION only (Ruling B2B-2c/2e): a typed phone / email never confers a group.
      const ctx = {
        ...(await resolveCustomerContext(storeId, { phone, email }, buyer)),
        cartItems,
      };
      const best = await resolveBestPromotion(storeId, ctx);

      res.json({
        success: true,
        data: {
          promotion: best ? { id: best.promotionId, discount: best.discount } : null,
        },
      });
    } catch (error) {
      next(error);
    }
  };

// Checkout's bucket (20/min/IP). The PDP and the cart use the browse route below, never this one.
router.post(
  '/public/:storeId/promotions/preview',
  promotionPreviewLimiter,
  // Per-tenant aggregate backstop (audit P3) — bounds distributed volume
  // against one store's endpoint regardless of source-IP spread.
  publicTenantLimiter,
  // The signed-in customer (never a body-supplied identity) decides group membership and group prices.
  optionalAuthenticate,
  makePreviewHandler(false)
);

// Same preview for the PDP and the cart (its own, more generous bucket: see promotionBrowsePreviewLimiter).
router.post(
  '/public/:storeId/promotions/preview-browse',
  promotionBrowsePreviewLimiter,
  publicTenantLimiter,
  optionalAuthenticate,
  makePreviewHandler(true)
);

export default router;
