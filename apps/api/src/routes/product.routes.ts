import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { ProductService } from '../services/product.service';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

const router = Router({ mergeParams: true });

// Validation schemas
const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  nameAr: z.string().max(255).optional(),
  slug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9\u0600-\u06FF-]+$/)
    .optional(),
  description: z.string().optional(),
  descriptionAr: z.string().optional(),
  price: z.number().int().min(0),
  // Nullable so the admin form can explicitly clear an existing value
  // (Prisma treats `undefined` as "leave alone"; we need `null` to clear).
  compareAtPrice: z.number().int().min(0).optional().nullable(),
  // Cost-of-goods in fils, used for profit reporting. Nullable so the
  // admin form can clear a previously-set value.
  costPrice: z.number().int().min(0).optional().nullable(),
  // Admin-authored discount input. The service derives price/compareAtPrice
  // from these at save time. null clears a previously-set discount.
  discountType: z.enum(['percentage', 'fixed']).optional().nullable(),
  // percentage → basis points (percent×100, e.g. 12.5%→1250, range 0–10000)
  // fixed      → fils
  discountValue: z.number().int().min(0).optional().nullable(),
  sku: z.string().optional(),
  inventory: z.number().int().min(0).optional(),
  // Per-product threshold for the LOW STOCK badge / merchant alerts.
  // Default lives on the schema (5). Without this in Zod, the createProductSchema
  // strips it and merchant edits silently no-op.
  lowStockThreshold: z.number().int().min(0).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  isFeatured: z.boolean().optional(),
  isNew: z.boolean().optional(),
  isBestSeller: z.boolean().optional(),
  // SEO meta — null clears, undefined leaves alone (Prisma convention).
  metaTitle: z.string().max(180).optional().nullable(),
  metaTitleAr: z.string().max(180).optional().nullable(),
  metaDescription: z.string().max(400).optional().nullable(),
  metaDescriptionAr: z.string().max(400).optional().nullable(),
  // AEO — conversational answer-engine copy (separate from SEO meta).
  metaDescriptionAeo: z.string().max(400).optional().nullable(),
  metaDescriptionAeoAr: z.string().max(400).optional().nullable(),
  categories: z.array(z.string()).optional(),
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

const createProductSchemaChecked = createProductSchema.superRefine(refineFixedDiscount);
const updateProductSchema = createProductSchema.partial().superRefine(refineFixedDiscount);

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
        featured: featured === 'true',
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
        inStock: inStock === 'true',
        onSale: onSale === 'true',
        isNew: isNew === 'true',
        featured: featured === 'true',
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
      const result = await prisma.product.updateMany({
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
      const faqs = await prisma.productFaq.findMany({
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
      const body = productFaqSchema.parse(req.body);
      const faq = await prisma.productFaq.create({
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
      const body = productFaqSchema.partial().parse(req.body);
      const result = await prisma.productFaq.updateMany({
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
      const updated = await prisma.productFaq.findUnique({ where: { id: req.params.faqId } });
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
      const deleted = await prisma.productFaq.deleteMany({
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

export default router;
