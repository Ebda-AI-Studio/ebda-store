import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireStoreAccess } from '../middleware/store-access';
import { prisma } from '@force/database';
import { invalidateCached } from '../lib/public-cache';

const router = Router({ mergeParams: true });

const createCategorySchema = z.object({
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
});

const updateCategorySchema = z.object({
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
});

// GET /stores/:storeId/categories — admin list. Used to be
// `authenticate` only; any store_admin token could read another
// tenant's categories by changing :storeId. Storefront category
// listing goes through /public/stores/:storeId/categories.
router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const categories = await prisma.category.findMany({
        where: { storeId, deletedAt: null },
        orderBy: { name: 'asc' },
        include: {
          _count: { select: { products: true } },
        },
      });

      res.json({
        success: true,
        data: { categories },
      });
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
      const data = createCategorySchema.parse(req.body);

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
        await prisma.category.findFirst({
          where: { storeId, slug, deletedAt: null },
        })
      ) {
        suffix++;
        slug = `${baseSlug}-${suffix}`;
      }

      const category = await prisma.category.create({
        data: {
          storeId,
          name: data.name,
          nameAr: data.nameAr,
          slug,
          description: data.description,
          descriptionAr: data.descriptionAr,
          image: data.image,
        },
        include: {
          _count: { select: { products: true } },
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
      await invalidateCached(`public:categories:${storeId}`);

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
      const data = updateCategorySchema.parse(req.body);

      // Verify category belongs to store
      const existing = await prisma.category.findFirst({
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
          await prisma.category.findFirst({
            where: { storeId, slug: data.slug, deletedAt: null, id: { not: categoryId } },
          })
        ) {
          suffix++;
          data.slug = `${baseSlug}-${suffix}`;
        }
      }

      const category = await prisma.category.update({
        where: { id: categoryId },
        data: {
          name: data.name,
          nameAr: data.nameAr,
          slug: data.slug,
          description: data.description,
          descriptionAr: data.descriptionAr,
          image: data.image,
        },
        include: {
          _count: { select: { products: true } },
        },
      });

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

      const existing = await prisma.category.findFirst({
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
      await prisma.category.update({
        where: { id: categoryId },
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

      await invalidateCached(`public:categories:${storeId}`);

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
