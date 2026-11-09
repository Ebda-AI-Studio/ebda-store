import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireStoreAccess } from '../middleware/store-access';
import { prisma, SlugEntityType } from '@ebda/database';
import { storeWriter, storeDb } from '../lib/repo-factory';
import {
  invalidateCached,
  invalidateStoreCategoriesCaches,
  invalidateStoreProductCaches,
} from '../lib/public-cache';
import { assertSizeChartInStore } from '../services/size-chart.service';
import { deleteR2ObjectIfOrphan } from '../services/r2-cleanup.service';
import { recordSlugRedirect } from '../services/slug-redirect.service';
import logger from '../lib/logger';
import { backfillDefaultCategoryNameAr } from '../lib/default-category-backfill';
import { storeUpdate } from '../lib/repo-factory';

const router = Router({ mergeParams: true });

export const createCategorySchema = z.object({
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
  image: z.string().url().optional(),
  // BE:F-6: the same photo shape the product API takes ({url, alt}[]); the first one is the category image.
  images: z
    .array(z.object({ url: z.string().url(), alt: z.string().max(255).optional() }))
    .max(10)
    .optional(),
  metaTitle: z.string().max(180).optional().nullable(),
  metaTitleAr: z.string().max(180).optional().nullable(),
  metaDescription: z.string().max(400).optional().nullable(),
  metaDescriptionAr: z.string().max(400).optional().nullable(),
  metaDescriptionAeo: z.string().max(400).optional().nullable(),
  metaDescriptionAeoAr: z.string().max(400).optional().nullable(),
  showOnHomeStrip: z.boolean().optional(),
  // Size chart inherited by this category's products on the PDP (B0 Task 9). null clears.
  sizeChartId: z.string().uuid().nullable().optional(),
});

/** BE:E-5: a store never has this many categories; the cap is a safety valve, not a page size. */
const CATEGORY_LIST_MAX = 1000;

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  nameAr: z.string().max(255).optional().nullable(),
  slug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9\u0600-\u06FF-]+$/)
    .optional(),
  description: z.string().optional().nullable(),
  descriptionAr: z.string().optional().nullable(),
  image: z.string().url().optional().nullable(),
  metaTitle: z.string().max(180).optional().nullable(),
  metaTitleAr: z.string().max(180).optional().nullable(),
  metaDescription: z.string().max(400).optional().nullable(),
  metaDescriptionAr: z.string().max(400).optional().nullable(),
  metaDescriptionAeo: z.string().max(400).optional().nullable(),
  metaDescriptionAeoAr: z.string().max(400).optional().nullable(),
  showOnHomeStrip: z.boolean().optional(),
  // Size chart inherited by this category's products on the PDP (B0 Task 9). null clears.
  sizeChartId: z.string().uuid().nullable().optional(),
});

// GET /stores/:storeId/categories/best-sellers-image — read the
// store's Best Sellers virtual category cover. Tiny endpoint so the
// admin UI can show the current value alongside the real category
// list. Mounted before `/` to avoid colliding with the categoryId
// path parameter on the PUT/DELETE routes.
router.get(
  '/best-sellers-image',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      // Defensive: when the column hasn't been provisioned yet (pre-
      // migration), return null rather than 500ing. The admin form
      // shows an empty uploader and the next save kicks the column
      // into existence on Railway's Dockerfile-driven migrate-deploy.
      try {
        const store = await (
          await storeDb(storeId)
        ).store.findUnique({
          where: { id: storeId },
          select: { bestSellersImage: true },
        });
        res.json({ success: true, data: { image: store?.bestSellersImage ?? null } });
      } catch (err) {
        logger.warn({ err, storeId }, '[best-sellers-image GET] column missing?');
        res.json({ success: true, data: { image: null } });
      }
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/categories/best-sellers-image — set/clear the
// virtual category cover. Pass `image: null` to clear; passing an
// R2-hosted URL queues the previous one for orphan cleanup.
router.put(
  '/best-sellers-image',
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const schema = z.object({
        image: z.string().url().nullable(),
      });
      const data = schema.parse(req.body);

      const existing = await (
        await storeDb(storeId)
      ).store.findUnique({
        where: { id: storeId },
        select: { bestSellersImage: true },
      });
      const previous = existing?.bestSellersImage ?? null;

      const store = await storeUpdate(prisma, {
        where: { id: storeId },
        data: { bestSellersImage: data.image },
        select: { bestSellersImage: true },
      });

      if (previous && previous !== data.image) {
        void deleteR2ObjectIfOrphan(previous).catch(err =>
          logger.warn({ err, storeId }, '[best-sellers-image] r2 cleanup failed')
        );
      }

      await auditLog({
        action: 'store.bestSellersImage.updated',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: storeId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Bust the public categories cache so the storefront sees the
      // new tile image on the next request rather than waiting out
      // the 120s TTL.
      await invalidateStoreCategoriesCaches(storeId);

      res.json({ success: true, data: { image: store.bestSellersImage } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/categories — admin list. Used to be
// `authenticate` only; any store_admin token could read another
// tenant's categories by changing :storeId. Storefront category
// listing goes through /public/stores/:storeId/categories.
router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)

      const categories = await w.category.findMany({
        where: { storeId, deletedAt: null },
        // Merchant-defined order first (Category.position), name as the stable
        // tiebreaker so stores that never reordered keep their A→Z look.
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        take: CATEGORY_LIST_MAX, // BE:E-5
        include: {
          // Exclude archived/deleted from the category product count so it
          // reflects live catalog size, not historical/hidden products.
          _count: {
            select: {
              products: { where: { product: { deletedAt: null, status: { not: 'archived' } } } },
            },
          },
        },
      });

      // BE:F-5 / QA P2-5: lazy, idempotent repair of a pre-fix default category (no Arabic name).
      if (await backfillDefaultCategoryNameAr(w, storeId, categories)) {
        await invalidateStoreCategoriesCaches(storeId);
      }

      res.json({
        success: true,
        data: { categories },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/categories/reorder — persist the merchant's drag/move
// order. Body: { orderedIds: [...] } in the desired display order; we write
// position = index for each. `updateMany` scoped to (id, storeId) so a token
// can never reorder another tenant's categories. Literal path declared BEFORE
// the `/:categoryId` routes so it isn't shadowed by the param route.
const reorderCategoriesSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(500),
});
router.put(
  '/reorder',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
      const { orderedIds } = reorderCategoriesSchema.parse(req.body);
      await w.$transaction(
        orderedIds.map((id, index) =>
          w.category.updateMany({
            where: { id, storeId, deletedAt: null },
            data: { position: index },
          })
        )
      );
      await invalidateStoreCategoriesCaches(storeId);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/categories/:categoryId/products
// List all products in a category in their current display order (position ASC,
// then createdAt DESC as stable tiebreaker). Used by the admin reorder UI.
router.get(
  '/:categoryId/products',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, categoryId } = req.params;
      const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)

      const category = await w.category.findFirst({
        where: { id: categoryId, storeId, deletedAt: null },
        select: { id: true, name: true, nameAr: true },
      });
      if (!category) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Category not found' },
        });
        return;
      }

      const links = await w.productCategory.findMany({
        where: { categoryId },
        orderBy: [{ position: 'asc' }, { product: { createdAt: 'desc' } }],
        select: {
          position: true,
          product: {
            select: {
              id: true,
              name: true,
              nameAr: true,
              sku: true,
              status: true,
              images: { orderBy: { position: 'asc' }, take: 1, select: { url: true } },
            },
          },
        },
      });

      const products = links.map(l => ({ ...l.product, position: l.position }));

      res.json({ success: true, data: { category, products } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/categories/:categoryId/products/reorder
// Persist the merchant's drag/move order for products within a category.
// Body: { orderedProductIds: [...] } in the desired display order; we write
// ProductCategory.position = index for each pair. The route validates that every
// product ID in the body actually belongs to the category so a token cannot
// forge positions for another tenant's products.
const reorderCategoryProductsSchema = z.object({
  orderedProductIds: z.array(z.string().uuid()).min(1).max(500),
});
router.put(
  '/:categoryId/products/reorder',
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, categoryId } = req.params;
      const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
      const { orderedProductIds } = reorderCategoryProductsSchema.parse(req.body);

      // Verify the category belongs to the store.
      const category = await w.category.findFirst({
        where: { id: categoryId, storeId, deletedAt: null },
        select: { id: true },
      });
      if (!category) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Category not found' },
        });
        return;
      }

      // Validate that every supplied product ID is actually in this category.
      // `updateMany` scoped to (productId, categoryId) is already safe (it
      // silently ignores IDs not in the category), but we surface an explicit
      // error so callers know when their list is stale.
      const existing = await w.productCategory.findMany({
        where: { categoryId, productId: { in: orderedProductIds } },
        select: { productId: true },
      });
      const existingIds = new Set(existing.map(r => r.productId));
      const unknown = orderedProductIds.filter(id => !existingIds.has(id));
      if (unknown.length > 0) {
        res.status(422).json({
          success: false,
          error: {
            code: 'PRODUCT_NOT_IN_CATEGORY',
            message: `${unknown.length} product(s) not found in this category`,
          },
        });
        return;
      }

      // Persist positions in a single transaction — set position = index.
      await w.$transaction(
        orderedProductIds.map((productId, index) =>
          w.productCategory.updateMany({
            where: { productId, categoryId },
            data: { position: index },
          })
        )
      );

      // Bust the public product cache for this store so the storefront
      // immediately reflects the new order on the next request.
      await invalidateStoreCategoriesCaches(storeId);

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/categories
router.post(
  '/',
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
      const data = createCategorySchema.parse(req.body);
      await assertSizeChartInStore(storeId, data.sizeChartId);

      let baseSlug =
        data.slug ||
        data.name
          .toLowerCase()
          .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')
          .replace(/(^-|-$)/g, '');

      // If slug is empty (e.g. pure symbols), use a fallback
      if (!baseSlug) {
        baseSlug = `category-${Date.now()}`;
      }

      // Auto-deduplicate: append -1, -2, etc. if slug exists
      let slug = baseSlug;
      let suffix = 0;
      while (
        await w.category.findFirst({
          where: { storeId, slug, deletedAt: null },
        })
      ) {
        suffix++;
        slug = `${baseSlug}-${suffix}`;
      }

      const category = await w.category.create({
        data: {
          storeId,
          name: data.name,
          nameAr: data.nameAr,
          slug,
          description: data.description,
          descriptionAr: data.descriptionAr,
          image: data.image ?? data.images?.[0]?.url,
          // SEO meta — mirror the PUT path so fields are persisted at create
          // time. Without this block the fields pass Zod validation but are
          // silently dropped, making every newly created category lose all SEO.
          metaTitle: data.metaTitle,
          metaTitleAr: data.metaTitleAr,
          metaDescription: data.metaDescription,
          metaDescriptionAr: data.metaDescriptionAr,
          metaDescriptionAeo: data.metaDescriptionAeo,
          metaDescriptionAeoAr: data.metaDescriptionAeoAr,
          // Homepage-strip visibility (omitted → DB default true).
          showOnHomeStrip: data.showOnHomeStrip,
          sizeChartId: data.sizeChartId ?? null,
        },
        include: {
          // Exclude archived/deleted from the category product count so it
          // reflects live catalog size, not historical/hidden products.
          _count: {
            select: {
              products: { where: { product: { deletedAt: null, status: { not: 'archived' } } } },
            },
          },
        },
      });

      await auditLog({
        action: 'category.created',
        userId: req.user!.userId,
        resourceType: 'category',
        resourceId: category.id,
        details: { name: category.name },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Storefront caches the public category list for 120s. Without
      // this bust, a merchant adding a category waits two minutes for
      // it to appear on the live site.
      await invalidateStoreCategoriesCaches(storeId);

      res.status(201).json({
        success: true,
        data: { category },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/categories/:categoryId
router.put(
  '/:categoryId',
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, categoryId } = req.params;
      const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
      const data = updateCategorySchema.parse(req.body);
      await assertSizeChartInStore(storeId, data.sizeChartId);

      // Verify category belongs to store
      const existing = await w.category.findFirst({
        where: { id: categoryId, storeId, deletedAt: null },
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Category not found' },
        });
        return;
      }

      // Auto-deduplicate slug if changing
      if (data.slug && data.slug !== existing.slug) {
        const baseSlug = data.slug;
        let suffix = 0;
        while (
          await w.category.findFirst({
            where: { storeId, slug: data.slug, deletedAt: null, id: { not: categoryId } },
          })
        ) {
          suffix++;
          data.slug = `${baseSlug}-${suffix}`;
        }
      }

      const previousImage = existing.image;

      // This route is mounted under `tenantContext` middleware, which already
      // wraps the whole request in one ambient tenant transaction (RLS GUC
      // set via `runInTenantContext`). Calling the proxied `prisma` directly
      // (not a nested `prisma.$transaction`) lets both the update and the
      // capture ride that ambient tx — atomic, and RLS-enforced.
      const category = await w.category.update({
        where: { id: categoryId, storeId },
        data: {
          name: data.name,
          nameAr: data.nameAr,
          slug: data.slug,
          description: data.description,
          descriptionAr: data.descriptionAr,
          image: data.image,
          // SEO meta — accept only when present so omitting them
          // doesn't clear an existing value. null in the patch
          // explicitly clears (Prisma convention).
          ...(data.metaTitle !== undefined ? { metaTitle: data.metaTitle } : {}),
          ...(data.metaTitleAr !== undefined ? { metaTitleAr: data.metaTitleAr } : {}),
          ...(data.metaDescription !== undefined ? { metaDescription: data.metaDescription } : {}),
          ...(data.metaDescriptionAr !== undefined
            ? { metaDescriptionAr: data.metaDescriptionAr }
            : {}),
          // AEO — separate conversational copy column.
          ...(data.metaDescriptionAeo !== undefined
            ? { metaDescriptionAeo: data.metaDescriptionAeo }
            : {}),
          ...(data.metaDescriptionAeoAr !== undefined
            ? { metaDescriptionAeoAr: data.metaDescriptionAeoAr }
            : {}),
          // Homepage-strip visibility — only when present (omitting it never
          // flips an existing value).
          ...(data.showOnHomeStrip !== undefined ? { showOnHomeStrip: data.showOnHomeStrip } : {}),
          ...(data.sizeChartId !== undefined ? { sizeChartId: data.sizeChartId } : {}),
        },
        include: {
          // Exclude archived/deleted from the category product count so it
          // reflects live catalog size, not historical/hidden products.
          _count: {
            select: {
              products: { where: { product: { deletedAt: null, status: { not: 'archived' } } } },
            },
          },
        },
      });

      if (data.slug && data.slug !== existing.slug) {
        await recordSlugRedirect(
          prisma,
          storeId,
          SlugEntityType.CATEGORY,
          existing.slug,
          data.slug
        );
      }

      // If the cover image changed, queue the old object for R2 cleanup.
      // Only fires when `data.image` is in the patch (undefined means
      // "leave existing"). Best-effort, no failure surfaced upstream.
      if (data.image !== undefined && previousImage && previousImage !== data.image) {
        void deleteR2ObjectIfOrphan(previousImage).catch(err =>
          logger.warn({ err, categoryId }, '[category.update] r2 cleanup failed')
        );
      }

      await auditLog({
        action: 'category.updated',
        userId: req.user!.userId,
        resourceType: 'category',
        resourceId: category.id,
        details: { name: category.name },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      await invalidateCached(`public:categories:${storeId}`);
      // The PDP payload carries the category's size chart (inherited by its products), so a
      // changed link must reach the product caches too (this also clears the categories cache).
      if (data.sizeChartId !== undefined && data.sizeChartId !== existing.sizeChartId) {
        await invalidateStoreProductCaches(storeId);
      }

      res.json({
        success: true,
        data: { category },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/categories/:categoryId
router.delete(
  '/:categoryId',
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, categoryId } = req.params;
      const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)

      const existing = await w.category.findFirst({
        where: { id: categoryId, storeId, deletedAt: null },
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Category not found' },
        });
        return;
      }

      // Soft delete
      await w.category.update({
        where: { id: categoryId, storeId },
        data: { deletedAt: new Date() },
      });

      await auditLog({
        action: 'category.deleted',
        userId: req.user!.userId,
        resourceType: 'category',
        resourceId: categoryId,
        details: { name: existing.name },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      await invalidateStoreCategoriesCaches(storeId);
      // A deleted category stops lending its size chart to its products' PDPs.
      if (existing.sizeChartId) await invalidateStoreProductCaches(storeId);

      res.json({
        success: true,
        data: { message: 'Category deleted' },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
