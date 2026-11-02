import { Router, Request, Response, NextFunction } from 'express';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { ProductService } from '../services/product.service';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { invalidateCachedPrefix } from '../lib/public-cache';
import { parseOptionalBooleanQuery } from '../lib/query-params';
import { EXCERPT_MAX_LENGTH } from '../lib/ai/product-excerpt-generator';
import {
  PRODUCT_BADGE_LABEL_MAX_LENGTH,
  SEARCH_TERMS_MAX_LENGTH,
  cleanSearchTerms,
  personalisationConfigSchema,
  productFactsSchema,
} from '@ebda/shared';

const router = Router({ mergeParams: true });

// Validation schemas

/**
 * Merchant-authored product card badge label (EN or AR).
 *
 * Trims BEFORE measuring, then rejects anything still over the cap:
 *   - `"  Offer  "`      → `"Offer"` (a padded label is a typo, not an error)
 *   - `"   "`            → `null`    (whitespace-only IS clearing it)
 *   - 33+ real chars     → 400       (a badge is a chip, not a paragraph —
 *                                     truncating silently would ship a label
 *                                     the merchant never wrote)
 *   - `null`             → `null`    (clear the column)
 *   - key omitted        → untouched (Prisma's convention, same as every
 *                                     other nullable free-text column here)
 *
 * The cap is shared with the DB column (`VARCHAR(32)`) and the admin input's
 * maxLength via PRODUCT_BADGE_LABEL_MAX_LENGTH so the three cannot drift.
 */
const badgeLabelSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform(value => (typeof value === 'string' ? value.trim() || null : value))
  .refine(value => value == null || value.length <= PRODUCT_BADGE_LABEL_MAX_LENGTH, {
    message: `Badge label must be ${PRODUCT_BADGE_LABEL_MAX_LENGTH} characters or fewer.`,
  });

const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  // Free-text columns the merchant can legitimately empty on the edit form.
  // Nullable so an emptied input can CLEAR the column — `undefined` (key
  // omitted) still means "leave alone", same convention as `excerpt` and the
  // SEO meta below. Without `.nullable()` the admin's `null` 400s, which is
  // why an emptied description used to save with no effect.
  // `name` is required and stays non-nullable.
  nameAr: z.string().max(255).optional().nullable(),
  slug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9\u0600-\u06FF-]+$/)
    .optional(),
  description: z.string().optional().nullable(),
  descriptionAr: z.string().optional().nullable(),
  // Short 1-2 sentence blurb — written by the bulk-ai-excerpt sweep or
  // manually. Nullable so the admin form can explicitly clear it (same
  // undefined/null convention as SEO meta below).
  excerpt: z.string().max(EXCERPT_MAX_LENGTH).optional().nullable(),
  excerptAr: z.string().max(EXCERPT_MAX_LENGTH).optional().nullable(),
  price: z.number().int().min(0),
  // Nullable so the admin form can explicitly clear an existing value
  // (Prisma treats `undefined` as "leave alone"; we need `null` to clear).
  compareAtPrice: z.number().int().min(0).optional().nullable(),
  // Cost-of-goods in piastres, used for profit reporting. Nullable so the
  // admin form can clear a previously-set value.
  costPrice: z.number().int().min(0).optional().nullable(),
  // Admin-authored discount input. The service derives price/compareAtPrice
  // from these at save time. null clears a previously-set discount.
  discountType: z.enum(['percentage', 'fixed']).optional().nullable(),
  // percentage → basis points (percent×100, e.g. 12.5%→1250, range 0–10000)
  // fixed      → piastres
  discountValue: z.number().int().min(0).optional().nullable(),
  sku: z.string().optional().nullable(),
  /** BARCODE-1: EAN-13 / UPC-A (check digit verified) or Code 128 text; '' / null clears. */
  barcode: z.string().max(100).optional().nullable(),
  inventory: z.number().int().min(0).optional(),
  // Per-product threshold for the LOW STOCK badge / merchant alerts.
  // Default lives on the schema (5). Without this in Zod, the createProductSchema
  // strips it and merchant edits silently no-op.
  lowStockThreshold: z.number().int().min(0).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  isFeatured: z.boolean().optional(),
  isNew: z.boolean().optional(),
  isBestSeller: z.boolean().optional(),
  // Free-text card badge, bilingual. Sibling of the isNew/isBestSeller card
  // flags — the difference is that this one carries the merchant's own words.
  badgeLabel: badgeLabelSchema,
  badgeLabelAr: badgeLabelSchema,
  // Spec rows (fabric, karat, ingredients...). Whole-array replace; omitted = untouched.
  facts: productFactsSchema.optional(),
  // Made-to-order business days (0-60). null = ready to ship (clears); undefined leaves alone.
  leadTimeDays: z.number().int().min(0).max(60).nullable().optional(),
  // Extra words shoppers type (dialect / Franco / English). Searched, never displayed.
  // Over-long raw input is a 400 here (never the DB CHECK's 500); the transform
  // normalises to the canonical "a, b, c" form (<= SEARCH_TERMS_MAX_LENGTH).
  // null/'' clears; undefined leaves alone (the partial() update convention).
  searchTerms: z
    .string()
    .max(SEARCH_TERMS_MAX_LENGTH)
    .nullable()
    .optional()
    .transform(v => (v === undefined ? undefined : cleanSearchTerms(v))),
  // Per-line customer text field (e.g. name to embroider). null clears; undefined leaves alone.
  personalisation: personalisationConfigSchema.nullable().optional(),
  // PDP size guide: own chart; null = inherit the category's chart. undefined leaves alone.
  sizeChartId: z.string().uuid().nullable().optional(),
  // SEO meta — null clears, undefined leaves alone (Prisma convention).
  metaTitle: z.string().max(180).optional().nullable(),
  metaTitleAr: z.string().max(180).optional().nullable(),
  metaDescription: z.string().max(400).optional().nullable(),
  metaDescriptionAr: z.string().max(400).optional().nullable(),
  // AEO — conversational answer-engine copy (separate from SEO meta).
  metaDescriptionAeo: z.string().max(400).optional().nullable(),
  metaDescriptionAeoAr: z.string().max(400).optional().nullable(),
  categories: z.array(z.string()).optional(),
  // B2B (Task 4): minimum order quantity (null = none) and audience. Setting either needs b2b.wholesale; clearing never does.
  moq: z.number().int().min(2).max(1_000_000).nullable().optional(),
  audience: z.enum(['public', 'wholesale_only']).optional(),
  images: z
    .array(
      z.object({
        url: z.string().url(),
        alt: z.string().optional(),
      })
    )
    .optional(),
});

/**
 * Reject a fixed discount that exceeds the price — it would produce a
 * negative sale price. The storefront's `computeDiscountAmount` clamps at
 * render time, but a `discountValue > price` is always a data-entry mistake:
 * fail loudly so the merchant fixes it rather than silently storing garbage.
 *
 * Only enforceable when BOTH `price` and `discountValue` are present on the
 * payload (always true for create; conditionally true for partial updates —
 * the update-only case where `price` is omitted is caught in ProductService).
 */
function refineFixedDiscount(
  data: { discountType?: string | null; discountValue?: number | null; price?: number },
  ctx: z.RefinementCtx
): void {
  if (
    data.discountType === 'fixed' &&
    typeof data.discountValue === 'number' &&
    typeof data.price === 'number' &&
    data.discountValue > data.price
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['discountValue'],
      message: 'Fixed discount cannot exceed the price (would produce a negative sale price).',
    });
  }
}

export const createProductSchemaChecked = createProductSchema.superRefine(refineFixedDiscount);
export const updateProductSchema = createProductSchema.partial().superRefine(refineFixedDiscount);

/**
 * @swagger
 * /stores/{storeId}/products:
 *   get:
 *     summary: List products
 *     description: Get paginated list of products for a store
 *     tags: [Products]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, draft, archived]
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: featured
 *         description: Omit for all products; 'true' or 'false' filters. Any other value is a 400.
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: List of products
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     products:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Product'
 *                     meta:
 *                       $ref: '#/components/schemas/Pagination'
 */
// Admin product list. Used to be unauthenticated and returned drafts +
// archived rows for any storeId — anyone could enumerate unpublished
// inventory by sequencing storeId UUIDs. The storefront uses
// /public/products which has its own active-only filter; this admin
// path now requires merchant auth + store ownership and trusts the
// caller's `status` query param.
router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, status, category, search, featured, ids, withSalesQuantity } = req.query;
      const idsParam =
        typeof ids === 'string' && ids.length > 0
          ? ids
              .split(',')
              .map(s => s.trim())
              .filter(Boolean)
              .slice(0, 50)
          : undefined;

      const result = await ProductService.list(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        status: status as string,
        category: category as string,
        search: search as string,
        // Tri-state: absent -> undefined, so the default list does not add
        // `WHERE featured = false` and hide featured products.
        featured: parseOptionalBooleanQuery(featured, 'featured'),
        ids: idsParam,
        // Inventory page opts in to the per-product sold-units aggregate.
        withSalesQuantity: withSalesQuantity === 'true',
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

// GET /stores/:storeId/products/search - Advanced search with filters.
// Admin-only — same reasoning as the list endpoint above. Public search
// goes through /public/products/search which filters status='active'.
// `inStock` / `onSale` / `isNew` / `featured` are tri-state: omit for no
// filter, 'true' or 'false' to filter (false = the exact complement, issues
// 2318 / 2325), anything else is a 400.
router.get(
  '/search',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const {
        q,
        page,
        limit,
        categories,
        tags,
        minPrice,
        maxPrice,
        inStock,
        onSale,
        isNew,
        featured,
        sortBy,
      } = req.query;

      const result = await ProductService.advancedSearch(storeId, {
        query: q as string,
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        categories: categories ? (categories as string).split(',') : undefined,
        tags: tags ? (tags as string).split(',') : undefined,
        minPrice: minPrice ? parseInt(minPrice as string) : undefined,
        maxPrice: maxPrice ? parseInt(maxPrice as string) : undefined,
        inStock: parseOptionalBooleanQuery(inStock, 'inStock'),
        onSale: parseOptionalBooleanQuery(onSale, 'onSale'),
        isNew: parseOptionalBooleanQuery(isNew, 'isNew'),
        featured: parseOptionalBooleanQuery(featured, 'featured'),
        sortBy: sortBy as
          | 'newest'
          | 'oldest'
          | 'price_asc'
          | 'price_desc'
          | 'name_asc'
          | 'name_desc'
          | 'popular'
          | 'rating',
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

// GET /stores/:storeId/products/suggestions - admin typeahead. Public
// version is the storefront search-suggest endpoint.
router.get(
  '/suggestions',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { q, limit } = req.query;

      const result = await ProductService.getSearchSuggestions(
        storeId,
        q as string,
        limit ? parseInt(limit as string) : undefined
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/products/filters - admin filter options.
router.get(
  '/filters',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const filters = await ProductService.getFilterOptions(storeId);

      res.json({
        success: true,
        data: { filters },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Two endpoints — one per carousel — that let merchants set the display order
// of products within the "New Arrivals" and "Best Sellers" homepage carousels.
// They follow the exact same shape as the category product reorder endpoint in
// category.routes.ts (PR #362).

const reorderCarouselSchema = z.object({
  orderedProductIds: z.array(z.string().uuid()).min(1).max(500),
});

// GET /stores/:storeId/products/new-arrivals
// List all products with isNew=true in their current carousel order
// (newArrivalPosition ASC, createdAt DESC tiebreaker). Used by the admin UI.
router.get(
  '/new-arrivals',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const products = await (
        await storeDb(storeId)
      ).product.findMany({
        where: { storeId, isNew: true, deletedAt: null },
        orderBy: [{ newArrivalPosition: 'asc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          nameAr: true,
          sku: true,
          status: true,
          newArrivalPosition: true,
          images: { orderBy: { position: 'asc' }, take: 1, select: { url: true } },
        },
      });
      res.json({ success: true, data: { products } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/products/new-arrivals/reorder
// Persist the merchant's display order for the New Arrivals carousel.
// Body: { orderedProductIds: [...] } — validates every ID is an isNew product.
router.put(
  '/new-arrivals/reorder',
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { orderedProductIds } = reorderCarouselSchema.parse(req.body);

      // Validate every supplied ID is a product in this store with isNew=true.
      const existing = await (
        await storeDb(storeId)
      ).product.findMany({
        where: { storeId, isNew: true, id: { in: orderedProductIds }, deletedAt: null },
        select: { id: true },
      });
      const existingIds = new Set(existing.map(r => r.id));
      const unknown = orderedProductIds.filter(id => !existingIds.has(id));
      if (unknown.length > 0) {
        res.status(422).json({
          success: false,
          error: {
            code: 'PRODUCT_NOT_IN_CAROUSEL',
            message: `${unknown.length} product(s) not found in the New Arrivals carousel`,
          },
        });
        return;
      }

      // Persist positions in a single transaction — position = index.
      const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
      await w.$transaction(
        orderedProductIds.map((id, index) =>
          w.product.update({
            where: { id, storeId },
            data: { newArrivalPosition: index },
          })
        )
      );

      // Bust the public product cache so the storefront immediately reflects
      // the new order on next request.
      await invalidateCachedPrefix(`public:products:${storeId}:`);

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/products/best-sellers
// List all products with isBestSeller=true in their current carousel order
// (bestSellerPosition ASC, createdAt DESC tiebreaker). Used by the admin UI.
router.get(
  '/best-sellers',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const products = await (
        await storeDb(storeId)
      ).product.findMany({
        where: { storeId, isBestSeller: true, deletedAt: null },
        orderBy: [{ bestSellerPosition: 'asc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          nameAr: true,
          sku: true,
          status: true,
          bestSellerPosition: true,
          images: { orderBy: { position: 'asc' }, take: 1, select: { url: true } },
        },
      });
      res.json({ success: true, data: { products } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/products/best-sellers/reorder
// Persist the merchant's display order for the Best Sellers carousel.
// Body: { orderedProductIds: [...] } — validates every ID is an isBestSeller product.
router.put(
  '/best-sellers/reorder',
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { orderedProductIds } = reorderCarouselSchema.parse(req.body);

      // Validate every supplied ID is a product in this store with isBestSeller=true.
      const existing = await (
        await storeDb(storeId)
      ).product.findMany({
        where: { storeId, isBestSeller: true, id: { in: orderedProductIds }, deletedAt: null },
        select: { id: true },
      });
      const existingIds = new Set(existing.map(r => r.id));
      const unknown = orderedProductIds.filter(id => !existingIds.has(id));
      if (unknown.length > 0) {
        res.status(422).json({
          success: false,
          error: {
            code: 'PRODUCT_NOT_IN_CAROUSEL',
            message: `${unknown.length} product(s) not found in the Best Sellers carousel`,
          },
        });
        return;
      }

      // Persist positions in a single transaction — position = index.
      const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
      await w.$transaction(
        orderedProductIds.map((id, index) =>
          w.product.update({
            where: { id, storeId },
            data: { bestSellerPosition: index },
          })
        )
      );

      // Bust the public product cache so the storefront immediately reflects
      // the new order on next request.
      await invalidateCachedPrefix(`public:products:${storeId}:`);

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/products/:id - admin product detail. Returns
// drafts + archived. Storefront uses /public/products/:slug which
// filters status='active' + deletedAt:null.
router.get(
  '/:id',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const product = await ProductService.getById(storeId, id);

      res.json({
        success: true,
        data: { product },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/products/bulk-set-backorder
//
// Flip Product.allowBackorder for EVERY active product in the store in one
// shot. Saves merchants from clicking through 200+ products individually.
// Used by the inventory page's "Enable backorder on all products" button.
//
// Body: { enabled: boolean }
//   true  → every active product gets allowBackorder=true
//   false → every active product gets allowBackorder=false
//
// Only touches status='active' + deletedAt=null products. Archived / draft /
// soft-deleted products are skipped so a future restore doesn't surprise the
// merchant by inheriting the bulk-flip.
router.post(
  '/bulk-set-backorder',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.backorder'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { enabled } = req.body as { enabled?: unknown };
      if (typeof enabled !== 'boolean') {
        throw new AppError(400, 'INVALID_BODY', 'enabled must be true or false');
      }
      const result = await (
        await storeWriter(storeId)
      ).product.updateMany({
        where: { storeId, status: 'active', deletedAt: null },
        data: { allowBackorder: enabled },
      });
      await auditLog({
        action: 'product.bulk_backorder',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: storeId,
        details: { enabled, productCount: result.count },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({
        success: true,
        data: { updated: result.count, enabled },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/products/bulk-set-low-stock-threshold
//
// Set Product.lowStockThreshold for a SELECTED set of products in one shot.
// Used by the inventory page's bulk threshold control. Unlike bulk-set-backorder
// (which targets every active product) this takes an explicit productIds list so
// the merchant controls exactly which rows change.
//
// Body: { productIds: string[]; lowStockThreshold: number }
router.post(
  '/bulk-set-low-stock-threshold',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('inventory.stock_alerts'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { productIds, lowStockThreshold } = req.body as {
        productIds?: unknown;
        lowStockThreshold?: unknown;
      };
      if (
        !Array.isArray(productIds) ||
        productIds.length === 0 ||
        !productIds.every(id => typeof id === 'string' && id.length > 0)
      ) {
        throw new AppError(400, 'INVALID_BODY', 'productIds must be a non-empty string array');
      }
      if (
        typeof lowStockThreshold !== 'number' ||
        !Number.isInteger(lowStockThreshold) ||
        lowStockThreshold < 0
      ) {
        throw new AppError(400, 'INVALID_BODY', 'lowStockThreshold must be a non-negative integer');
      }

      const result = await ProductService.bulkSetLowStockThreshold(
        storeId,
        productIds as string[],
        lowStockThreshold
      );

      await auditLog({
        action: 'product.bulk_low_stock_threshold',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: storeId,
        details: { lowStockThreshold, productCount: result.count },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { updated: result.count, lowStockThreshold },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/products/bulk-update
//
// Mass-edit a set of products in a single store.
// Body: { productIds, fields: { status?, addCategoryId?, isFeatured?, isNew?,
//         isBestSeller?, price?:{mode,value}, inventory?:{mode,value} } }
//
// Price and inventory mutations only touch SIMPLE products (products without
// variants store stock on variants — mutating the parent is wrong).
// Returns { updated, skippedVariantProducts }.
const bulkUpdateSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(500),
  fields: z
    .object({
      status: z.enum(['draft', 'active', 'archived']).optional(),
      addCategoryId: z.string().uuid().optional(),
      isFeatured: z.boolean().optional(),
      isNew: z.boolean().optional(),
      isBestSeller: z.boolean().optional(),
      price: z
        .object({
          mode: z.enum(['set', 'adjustPct']),
          // For 'set': piastres (integer, ≥0, ≤ Postgres int4 max ~2.1B)
          // For 'adjustPct': percent in range -99..+10000 (avoids int4 overflow
          //   from an unbounded multiplier against large piastres values)
          value: z
            .number()
            .min(-99, 'adjustPct must be ≥ -99 (up to 99% off)')
            .max(2_147_483_647, 'price value too large'),
        })
        // `set` is an absolute piastres price → must be a non-negative integer.
        // Without this, `{ mode:'set', value:-50 }` passes the shared min(-99)
        // and the service silently clamps it to 0, zeroing every product's price.
        .refine(p => p.mode !== 'set' || (Number.isInteger(p.value) && p.value >= 0), {
          message: 'set price must be a non-negative integer (piastres)',
          path: ['value'],
        })
        .optional(),
      inventory: z
        .object({
          mode: z.enum(['set', 'adjust']),
          // Clamp to int4 range; negative set values are clamped to 0 by the service.
          value: z.number().int().min(-2_147_483_647).max(2_147_483_647),
        })
        .optional(),
    })
    .refine(d => Object.keys(d).length > 0, { message: 'fields must have at least one key' }),
});

router.post(
  '/bulk-update',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { productIds, fields } = bulkUpdateSchema.parse(req.body);

      const result = await ProductService.bulkUpdate(storeId, productIds, fields);

      await auditLog({
        action: 'product.bulk_update',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: storeId,
        details: { productCount: productIds.length, fields: Object.keys(fields).join(', ') },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/products - Create product
router.post(
  '/',
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createProductSchemaChecked.parse(req.body);

      const product = await ProductService.create(storeId, data);

      // Audit log
      await auditLog({
        action: 'product.created',
        userId: req.user!.userId,
        resourceType: 'product',
        resourceId: product.id,
        details: { name: product.name, sku: product.sku },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(201).json({
        success: true,
        data: { product },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/products/:id - Update product
router.put(
  '/:id',
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = updateProductSchema.parse(req.body);

      const product = await ProductService.update(storeId, id, data);

      // Audit log
      await auditLog({
        action: 'product.updated',
        userId: req.user!.userId,
        resourceType: 'product',
        resourceId: id,
        details: { changedFields: Object.keys(data).join(', ') },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { product },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/products/:id - Delete product
router.delete(
  '/:id',
  authenticate,
  requirePermission('products:delete'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      // Get product name before deletion for audit
      const product = await ProductService.getById(storeId, id);

      await ProductService.delete(storeId, id);

      // Audit log
      await auditLog({
        action: 'product.deleted',
        userId: req.user!.userId,
        resourceType: 'product',
        resourceId: id,
        details: { name: product.name },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { message: 'Product deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ===== Product FAQ CRUD =====

const productFaqSchema = z.object({
  question: z.string().min(1).max(500),
  questionAr: z.string().max(500).optional().nullable(),
  answer: z.string().min(1).max(5000),
  answerAr: z.string().max(5000).optional().nullable(),
});

router.get(
  '/:id/faqs',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const w = await storeWriter(req.params.storeId);
      const product = await w.product.findFirst({
        where: { id: req.params.id, storeId: req.params.storeId },
        select: { id: true },
      });
      if (!product) throw new AppError(404, 'NOT_FOUND', 'Product not found');

      const faqs = await (
        await storeDb(req.params.storeId)
      ).productFaq.findMany({
        where: { productId: req.params.id },
        orderBy: { createdAt: 'asc' },
      });
      res.json({ success: true, data: faqs });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/faqs',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const w = await storeWriter(req.params.storeId);
      const product = await w.product.findFirst({
        where: { id: req.params.id, storeId: req.params.storeId },
        select: { id: true },
      });
      if (!product) throw new AppError(404, 'NOT_FOUND', 'Product not found');

      const body = productFaqSchema.parse(req.body);
      const faq = await w.productFaq.create({
        data: {
          productId: req.params.id,
          question: body.question,
          questionAr: body.questionAr ?? null,
          answer: body.answer,
          answerAr: body.answerAr ?? null,
          aiDrafted: false,
          manuallyEdited: true,
        },
      });
      res.status(201).json({ success: true, data: faq });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/:id/faqs/:faqId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const w = await storeWriter(req.params.storeId);
      const product = await w.product.findFirst({
        where: { id: req.params.id, storeId: req.params.storeId },
        select: { id: true },
      });
      if (!product) throw new AppError(404, 'NOT_FOUND', 'Product not found');

      const body = productFaqSchema.partial().parse(req.body);
      const result = await w.productFaq.updateMany({
        where: { id: req.params.faqId, productId: req.params.id },
        data: {
          ...(body.question !== undefined && { question: body.question }),
          ...(body.questionAr !== undefined && { questionAr: body.questionAr }),
          ...(body.answer !== undefined && { answer: body.answer }),
          ...(body.answerAr !== undefined && { answerAr: body.answerAr }),
          manuallyEdited: true,
        },
      });
      if (result.count === 0) {
        throw new AppError(404, 'NOT_FOUND', 'FAQ not found');
      }
      const updated = await (
        await storeDb(req.params.storeId)
      ).productFaq.findUnique({ where: { id: req.params.faqId } });
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id/faqs/:faqId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const w = await storeWriter(req.params.storeId);
      const product = await w.product.findFirst({
        where: { id: req.params.id, storeId: req.params.storeId },
        select: { id: true },
      });
      if (!product) throw new AppError(404, 'NOT_FOUND', 'Product not found');

      const deleted = await w.productFaq.deleteMany({
        where: { id: req.params.faqId, productId: req.params.id },
      });
      if (deleted.count === 0) {
        throw new AppError(404, 'NOT_FOUND', 'FAQ not found');
      }
      res.json({ success: true, data: { message: 'FAQ deleted' } });
    } catch (error) {
      next(error);
    }
  }
);

// ─── Carousel reorder endpoints ──────────────────────────────────────────────
//

export default router;
