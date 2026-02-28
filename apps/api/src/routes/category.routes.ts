import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { prisma } from '@force/database';

const router = Router({ mergeParams: true });

const createCategorySchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().optional(),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().optional(),
});

// GET /stores/:storeId/categories
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
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
});

// POST /stores/:storeId/categories
router.post(
  '/',
  authenticate,
  requirePermission('products:write'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createCategorySchema.parse(req.body);

      const slug =
        data.slug ||
        data.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '');

      // Check for duplicate slug within store
      const existing = await prisma.category.findFirst({
        where: { storeId, slug, deletedAt: null },
      });

      if (existing) {
        res.status(409).json({
          success: false,
          error: { code: 'DUPLICATE_SLUG', message: 'A category with this slug already exists' },
        });
        return;
      }

      const category = await prisma.category.create({
        data: {
          storeId,
          name: data.name,
          slug,
          description: data.description,
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

      // Check slug uniqueness if changing
      if (data.slug && data.slug !== existing.slug) {
        const duplicate = await prisma.category.findFirst({
          where: { storeId, slug: data.slug, deletedAt: null, id: { not: categoryId } },
        });
        if (duplicate) {
          res.status(409).json({
            success: false,
            error: { code: 'DUPLICATE_SLUG', message: 'A category with this slug already exists' },
          });
          return;
        }
      }

      const category = await prisma.category.update({
        where: { id: categoryId },
        data: {
          name: data.name,
          slug: data.slug,
          description: data.description,
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
