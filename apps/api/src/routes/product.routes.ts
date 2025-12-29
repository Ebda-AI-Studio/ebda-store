import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { ProductService } from '../services/product.service';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';

const router = Router({ mergeParams: true });

// Validation schemas
const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().optional(),
  price: z.number().int().min(0),
  compareAtPrice: z.number().int().min(0).optional(),
  sku: z.string().optional(),
  inventory: z.number().int().min(0).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  categories: z.array(z.string()).optional(),
  images: z.array(z.object({
    url: z.string().url(),
    alt: z.string().optional(),
  })).optional(),
});

const updateProductSchema = createProductSchema.partial();

// GET /stores/:storeId/products - List products
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { page, limit, status, category, search, featured } = req.query;

    const result = await ProductService.list(storeId, {
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      status: status as string,
      category: category as string,
      search: search as string,
      featured: featured === 'true',
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// GET /stores/:storeId/products/:id - Get product
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
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
});

// POST /stores/:storeId/products - Create product
router.post(
  '/',
  authenticate,
  requirePermission('products:write'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createProductSchema.parse(req.body);

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

export default router;
