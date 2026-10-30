import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { storeDb } from '../lib/repo-factory';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { BulkService } from '../services/bulk.service';
import { PRODUCT_SEARCH_MAX_LIMIT, searchProductIds } from '../services/product-search.service';
import { xlsxBufferToImportCsv } from '../services/xlsx-import';
import { importCsvToPlatformCsv } from '../services/csv-import';
import { buildImportPreview } from '../services/import-preview';
import { currentStoreId, prisma, ProductStatus } from '@ebda/database';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { auditLog, writeLimiter } from '../middleware/security';
import { inngest } from '../lib/inngest/client';
import { streamXlsxResponse } from '../lib/exports/xlsx';
import { tenantContext } from '../middleware/tenant-context';
import { invalidateStoreProductCaches } from '../lib/public-cache';

import { fromMinor, excelMoneyFormat } from '@ebda/shared';
const router = Router();

// Mounted at the bare '/stores' prefix in routes/index.ts, so Express does
// NOT populate req.params.storeId at the mount level — every route below
// declares its own '/:storeId/...' path. router.param runs AFTER Express
// resolves :storeId for the matched route, so RLS tenant context is set
// correctly here. See F2, docs/plans/2026-07-02-rls-cutover.md.
router.param('storeId', tenantContext);

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

// GET /stores/:storeId/bulk/export.xlsx - Export products to XLSX
// Sibling to the CSV export above — same query, same column set, formatted
// as an Excel workbook. Shape matches the CSV columns 1:1 so either file
// can be re-imported (for the columns that support re-import).
router.get(
  '/:storeId/bulk/export.xlsx',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { status, search, includeDeleted } = req.query;

      // Build the same where clause as BulkService.exportProducts
      const where: Record<string, unknown> = { storeId };
      if (status) where.status = status as ProductStatus;
      if (includeDeleted !== 'true') where.deletedAt = null;
      if (search) {
        where.id = {
          in: await searchProductIds(storeId, search as string, {
            scope: 'admin',
            includeDeleted: includeDeleted === 'true',
            limit: PRODUCT_SEARCH_MAX_LIMIT,
          }),
        };
      }

      const products = await (
        await storeDb(storeId)
      ).product.findMany({
        where,
        include: {
          images: { orderBy: { position: 'asc' } },
          categories: { include: { category: true } },
          tags: { include: { tag: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10000,
      });

      const rows = products.map(p => ({
        id: p.id,
        name: p.name,
        nameAr: p.nameAr ?? '',
        slug: p.slug,
        description: p.description ?? '',
        descriptionAr: p.descriptionAr ?? '',
        price: fromMinor(p.price),
        compareAtPrice: p.compareAtPrice != null ? fromMinor(p.compareAtPrice) : '',
        costPrice: p.costPrice != null ? fromMinor(p.costPrice) : '',
        sku: p.sku ?? '',
        barcode: p.barcode ?? '',
        inventory: p.inventory,
        lowStockThreshold: p.lowStockThreshold,
        trackInventory: p.trackInventory,
        weight: p.weight ?? '',
        status: p.status,
        featured: p.featured,
        isNew: p.isNew,
        categories: p.categories.map(c => c.category.name).join(', '),
        tags: p.tags.map(t => t.tag.name).join(', '),
        images: p.images.map(i => i.url).join(', '),
        metaTitle: p.metaTitle ?? '',
        metaTitleAr: p.metaTitleAr ?? '',
        metaDescription: p.metaDescription ?? '',
        metaDescriptionAr: p.metaDescriptionAr ?? '',
        searchTerms: p.searchTerms ?? '',
      }));

      await auditLog({
        action: 'bulk.export',
        userId: req.user!.userId,
        resourceType: 'product',
        resourceId: storeId,
        details: { type: 'products_xlsx' },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const date = new Date().toISOString().slice(0, 10);
      await streamXlsxResponse(res, {
        filename: `products-${storeId}-${date}.xlsx`,
        sheetName: 'Products',
        columns: [
          { header: 'ID', key: 'id', width: 38 },
          { header: 'Name', key: 'name', width: 30 },
          { header: 'Name (AR)', key: 'nameAr', width: 30 },
          { header: 'Slug', key: 'slug', width: 24 },
          { header: 'Description', key: 'description', width: 40 },
          { header: 'Description (AR)', key: 'descriptionAr', width: 40 },
          {
            header: 'Price (EGP)',
            key: 'price',
            width: 14,
            numFmt: excelMoneyFormat({ grouped: true }),
          },
          {
            header: 'Compare At Price (EGP)',
            key: 'compareAtPrice',
            width: 22,
            numFmt: excelMoneyFormat({ grouped: true }),
          },
          {
            header: 'Cost Price (EGP)',
            key: 'costPrice',
            width: 18,
            numFmt: excelMoneyFormat({ grouped: true }),
          },
          { header: 'SKU', key: 'sku', width: 16 },
          { header: 'Barcode', key: 'barcode', width: 16 },
          { header: 'Inventory', key: 'inventory', width: 12 },
          { header: 'Low Stock Threshold', key: 'lowStockThreshold', width: 20 },
          { header: 'Track Inventory', key: 'trackInventory', width: 16 },
          { header: 'Weight', key: 'weight', width: 10 },
          { header: 'Status', key: 'status', width: 12 },
          { header: 'Featured', key: 'featured', width: 10 },
          { header: 'Is New', key: 'isNew', width: 10 },
          { header: 'Categories', key: 'categories', width: 30 },
          { header: 'Tags', key: 'tags', width: 30 },
          { header: 'Images', key: 'images', width: 60 },
          { header: 'Meta Title', key: 'metaTitle', width: 30 },
          { header: 'Meta Title (AR)', key: 'metaTitleAr', width: 30 },
          { header: 'Meta Description', key: 'metaDescription', width: 40 },
          { header: 'Meta Description (AR)', key: 'metaDescriptionAr', width: 40 },
          { header: 'Search Words', key: 'searchTerms', width: 40 },
        ],
        rows,
      });
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
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const template = BulkService.getImportTemplate();

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=product_import_template.csv');
      res.send(template);
    } catch (err) {
      // Express 4 does NOT forward async rejections to errorHandler.
      next(err);
    }
  }
);

// POST /stores/:storeId/bulk/import-preview - Dry run of an import. Runs the
// SAME conversion as /import and /import-xlsx (EGP cells -> piastres, per-row
// PRICE_* errors) and returns what would be written, with prices in piastres.
// Nothing is persisted or queued. Send either { csvData } or { xlsxBase64,
// options }; the admin formats the piastres as EGP and asks the merchant to
// confirm before calling the real import.
router.post(
  '/:storeId/bulk/import-preview',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { csvData, xlsxBase64, options } = req.body ?? {};

      let csv: string;
      let format: string;
      if (typeof xlsxBase64 === 'string' && xlsxBase64) {
        const parsedOptions = xlsxImportOptionsSchema.parse(options || {});
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
        csv = await xlsxBufferToImportCsv(buffer, {
          skuPrefix: parsedOptions.skuPrefix,
          defaultInventory: parsedOptions.defaultInventory,
          defaultStatus: parsedOptions.defaultStatus,
          trackInventory: parsedOptions.trackInventory,
        });
        format = 'xlsx';
      } else if (typeof csvData === 'string' && csvData) {
        const converted = importCsvToPlatformCsv(csvData);
        csv = converted.csv;
        format = `csv:${converted.format}`;
      } else {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DATA', message: 'csvData or xlsxBase64 is required' },
        });
        return;
      }

      // The store's current prices feed the "looks like piastres" warning.
      const existing = await (
        await storeDb(storeId)
      ).product.findMany({
        where: { storeId, deletedAt: null },
        select: { price: true },
        take: 5000,
      });

      res.json({
        success: true,
        data: {
          format,
          preview: buildImportPreview(
            csv,
            existing.map(p => p.price)
          ),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/bulk/import - Enqueue an async product import
// from CSV. Returns immediately with a jobId; the admin polls
// /import-jobs/:jobId for progress + final result.
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

      // One CSV entry point for both layouts: Ebda's own template
      // converts EGP prices to piastres (strict 2 decimals, per-row PRICE_*
      // errors); a Shopify product export is grouped by Handle and converted
      // the same way into the same internal platform CSV. Either way the single BulkService importer does the work.
      const converted = importCsvToPlatformCsv(csvData);

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkImportJob.create({
        data: {
          storeId,
          userId,
          csvData: converted.csv,
          updateExisting: parsedOptions.updateExisting ?? true,
        },
        select: { id: true, status: true, createdAt: true },
      });

      await inngest.send({
        name: 'bulk-import/started',
        data: { jobId: job.id, storeId },
      });

      await auditLog({
        action: 'bulk.import.queued',
        userId,
        resourceType: 'product',
        resourceId: storeId,
        details: { jobId: job.id, source: `csv:${converted.format}` },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(202).json({
        success: true,
        data: { job },
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

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkImportJob.create({
        data: {
          storeId,
          userId,
          csvData,
          updateExisting: parsedOptions.updateExisting ?? true,
        },
        select: { id: true, status: true, createdAt: true },
      });

      await inngest.send({
        name: 'bulk-import/started',
        data: { jobId: job.id, storeId },
      });

      await auditLog({
        action: 'bulk.import.queued',
        userId,
        resourceType: 'product',
        resourceId: storeId,
        details: { jobId: job.id, source: 'xlsx' },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(202).json({
        success: true,
        data: { job },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/bulk/import-jobs/:jobId - Poll a queued/running
// import for progress + final result. Returns the lightweight job
// row (without csvData) so the admin can render a progress bar.
router.get(
  '/:storeId/bulk/import-jobs/:jobId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, jobId } = req.params;
      const job = await (
        await storeDb(currentStoreId())
      ).bulkImportJob.findFirst({
        where: { id: jobId, storeId },
        select: {
          id: true,
          status: true,
          total: true,
          processed: true,
          created: true,
          updated: true,
          failed: true,
          errors: true,
          errorMessage: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
        },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Import job not found' },
        });
        return;
      }

      res.json({ success: true, data: { job } });
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

      // A deleted product must stop being listed/purchasable (and drop out
      // of any bundle's componentSum-derived availability) immediately, not
      // after the cache TTL — same class of gap the other bundle write
      // paths had.
      await invalidateStoreProductCaches(storeId);

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

      // A status flip (active ↔ draft/archived) changes what the storefront
      // and any owning bundle may list — same class of gap as bulk delete.
      await invalidateStoreProductCaches(storeId);

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
