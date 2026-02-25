import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { BulkService } from '../services/bulk.service';
import { ProductStatus } from '@force/database';
import { auditLog, writeLimiter } from '../middleware/security';

const router = Router();

// Validation schemas
const bulkDeleteSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(100),
  permanent: z.boolean().optional().default(false),
});

const bulkStatusSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(100),
  status: z.enum(['draft', 'active', 'archived']),
});

const importOptionsSchema = z.object({
  updateExisting: z.boolean().optional().default(true),
});

// GET /stores/:storeId/bulk/export - Export products to CSV
router.get(
  '/:storeId/bulk/export',
  authenticate,
  authorize('store_admin', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { status, category, search, includeDeleted } = req.query;

      const csv = await BulkService.exportProducts(storeId, {
        status: status as ProductStatus | undefined,
        category: category as string | undefined,
        search: search as string | undefined,
        includeDeleted: includeDeleted === 'true',
      });

      // Audit log
      await auditLog({
        action: 'bulk.export',
        userId: req.user!.userId,
        resourceType: 'product',
        resourceId: storeId,
        details: { type: 'products_csv' },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=products_${storeId}_${Date.now()}.csv`
      );
      res.send(csv);
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/bulk/template - Get CSV import template
router.get(
  '/:storeId/bulk/template',
  authenticate,
  authorize('store_admin', 'super_admin'),
  async (_req: Request, res: Response) => {
    const template = BulkService.getImportTemplate();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=product_import_template.csv');
    res.send(template);
  }
);

// POST /stores/:storeId/bulk/import - Import products from CSV
router.post(
  '/:storeId/bulk/import',
  authenticate,
  authorize('store_admin', 'super_admin'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { csvData, options } = req.body;

      if (!csvData || typeof csvData !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DATA', message: 'csvData is required and must be a string' },
        });
        return;
      }

      const parsedOptions = importOptionsSchema.parse(options || {});
      const userId = req.user!.userId;

      const result = await BulkService.importProducts(storeId, csvData, parsedOptions, userId);

      // Audit log
      await auditLog({
        action: 'bulk.import',
        userId,
        resourceType: 'product',
        resourceId: storeId,
        details: {
          total: result.total,
          created: result.created,
          updated: result.updated,
          failed: result.failed,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { result },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/bulk/delete - Bulk delete products
router.post(
  '/:storeId/bulk/delete',
  authenticate,
  authorize('store_admin', 'super_admin'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { productIds, permanent } = bulkDeleteSchema.parse(req.body);
      const userId = req.user!.userId;

      const result = await BulkService.bulkDelete(storeId, productIds, permanent);

      // Audit log
      await auditLog({
        action: 'bulk.delete',
        userId,
        resourceType: 'product',
        resourceId: storeId,
        details: {
          count: productIds.length,
          permanent,
          deleted: result.deleted,
          failed: result.failed,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { result },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/bulk/status - Bulk update product status
router.post(
  '/:storeId/bulk/status',
  authenticate,
  authorize('store_admin', 'super_admin'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { productIds, status } = bulkStatusSchema.parse(req.body);
      const userId = req.user!.userId;

      const result = await BulkService.bulkUpdateStatus(
        storeId,
        productIds,
        status as ProductStatus
      );

      // Audit log
      await auditLog({
        action: 'bulk.status_update',
        userId,
        resourceType: 'product',
        resourceId: storeId,
        details: {
          count: productIds.length,
          status,
          updated: result.updated,
          failed: result.failed,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { result },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
