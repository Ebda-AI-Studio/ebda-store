import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { BulkService } from '../services/bulk.service';
import { xlsxBufferToImportCsv } from '../services/xlsx-import';
import { ProductStatus } from '@force/database';
import { auditLog, writeLimiter } from '../middleware/security';

const router = Router();

// Scope the feature gate to the bulk subtree only — see inventory.routes.ts
// for why the previous `router.use(requireFeature('bulk_operations'))`
// over-triggered on sibling mounts under '/stores'.
router.use('/:storeId/bulk', requireFeature('bulk_operations'));

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

const xlsxImportOptionsSchema = z.object({
  updateExisting: z.boolean().optional().default(true),
  skuPrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,16}$/)
    .optional(),
  defaultInventory: z.number().int().min(0).max(1_000_000).optional(),
  defaultStatus: z.enum(['draft', 'active', 'archived']).optional(),
  trackInventory: z.boolean().optional(),
});

// Base64-encoded xlsx payloads. 10MB is plenty for merchant catalogues and
// keeps JSON body parsing honest.
const MAX_XLSX_BYTES = 10 * 1024 * 1024;

// GET /stores/:storeId/bulk/export - Export products to CSV
router.get(
  '/:storeId/bulk/export',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
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
  requireStoreAccess,
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
  requireStoreAccess,
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

// POST /stores/:storeId/bulk/import-xlsx - Import products from an XLSX file
// (base64 encoded). Accepts the same option shape as /import plus optional
// xlsx-specific defaults (skuPrefix, defaultInventory, defaultStatus,
// trackInventory). The sheet is parsed server-side, mapped against common
// English/Arabic header aliases, converted to the platform CSV format, and
// handed to the regular CSV importer so there's one source of truth for
// product creation.
router.post(
  '/:storeId/bulk/import-xlsx',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { xlsxBase64, options } = req.body;

      if (!xlsxBase64 || typeof xlsxBase64 !== 'string') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_DATA',
            message: 'xlsxBase64 is required and must be a base64 string',
          },
        });
        return;
      }

      const parsedOptions = xlsxImportOptionsSchema.parse(options || {});
      const userId = req.user!.userId;

      const buffer = Buffer.from(xlsxBase64, 'base64');
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_XLSX_BYTES) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_DATA',
            message: `xlsx file must be between 1 byte and ${MAX_XLSX_BYTES} bytes`,
          },
        });
        return;
      }

      const csvData = await xlsxBufferToImportCsv(buffer, {
        skuPrefix: parsedOptions.skuPrefix,
        defaultInventory: parsedOptions.defaultInventory,
        defaultStatus: parsedOptions.defaultStatus,
        trackInventory: parsedOptions.trackInventory,
      });

      const result = await BulkService.importProducts(
        storeId,
        csvData,
        { updateExisting: parsedOptions.updateExisting ?? true },
        userId
      );

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
  requireStoreAccess,
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
  requireStoreAccess,
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
