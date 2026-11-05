/**
 * Catalogue import: upload photos / PDFs, review the extracted products, create drafts, publish.
 *
 * Mounted at the bare `/stores` prefix; every route declares its own `/:storeId/...` path.
 * Chain on every route: authenticate -> authorize('store_admin','super_admin') -> requireStoreAccess -> requireFeature('bulk_operations').
 * The plan allowance (`plans.limits.catalogImportPagesPerMonth`) is enforced in the service.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { tenantContext } from '../middleware/tenant-context';
import {
  uploadLimiter,
  dailyUploadLimiter,
  writeLimiter,
  catalogImportStoreLimiter,
} from '../middleware/security';
import { catalogueLimits } from '../lib/catalogue/page-ledger';
import * as svc from '../services/catalog-import.service';

const router = Router();
router.param('storeId', tenantContext);

const lim = catalogueLimits();
const upload = multer({
  storage: multer.memoryStorage(),
  // The multipart body is capped at fileSize * files before parsing (Worker memory), so these two
  // numbers ARE the memory bound. The sniffer, not the declared mime, decides what a file is.
  limits: { fileSize: Math.max(lim.maxImageBytes, lim.maxPdfBytes), files: lim.maxFilesPerJob },
});

// BE:S-6: the same plan gate the /bulk page applies in the UI (bulk_operations), enforced here too.
const admin = [
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('bulk_operations'),
] as const;

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

// POST /stores/:storeId/catalog-import   (multipart, field "files")
router.post(
  '/:storeId/catalog-import',
  ...admin,
  catalogImportStoreLimiter,
  uploadLimiter,
  dailyUploadLimiter,
  upload.array('files', lim.maxFilesPerJob),
  wrap(async (req, res) => {
    const files = ((req.files as Express.Multer.File[] | undefined) ?? []).map(f => ({
      buffer: f.buffer,
      originalName: f.originalname,
    }));
    const { jobId } = await svc.createJob(req.params.storeId, req.user?.userId, files);
    res.status(202).json({ success: true, data: { jobId } });
  })
);

router.get(
  '/:storeId/catalog-import',
  ...admin,
  wrap(async (req, res) => {
    res.json({ success: true, data: await svc.listJobs(req.params.storeId) });
  })
);

router.get(
  '/:storeId/catalog-import/:jobId',
  ...admin,
  wrap(async (req, res) => {
    res.json({ success: true, data: await svc.getJob(req.params.storeId, req.params.jobId) });
  })
);

router.get(
  '/:storeId/catalog-import/:jobId/items',
  ...admin,
  wrap(async (req, res) => {
    const q = z
      .object({
        status: z.enum(['pending', 'accepted', 'rejected', 'created', 'failed']).optional(),
        flagged: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().uuid().optional(),
      })
      .parse(req.query);
    const data = await svc.listItems(req.params.storeId, req.params.jobId, {
      status: q.status,
      flagged: q.flagged === undefined ? undefined : q.flagged === 'true',
      limit: q.limit,
      cursor: q.cursor,
    });
    res.json({ success: true, data });
  })
);

const patchSchema = z
  .object({
    name: z.string().max(300).nullable().optional(),
    nameAr: z.string().max(300).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    descriptionAr: z.string().max(2000).nullable().optional(),
    priceMinor: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    compareAtMinor: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    sku: z.string().max(60).nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
    createCategory: z.boolean().optional(),
    tags: z.array(z.string().max(60)).max(10).optional(),
    variants: z
      .array(
        z
          .object({
            options: z.record(z.string().max(60)),
            priceMinor: z.number().int().min(0).max(1_000_000_000).nullable(),
            sku: z.string().max(60).nullable().optional(),
          })
          .strict()
      )
      .max(30)
      .optional(),
    status: z.enum(['accepted', 'rejected', 'pending']).optional(),
    acknowledge: z.array(z.string().max(40)).max(20).optional(),
  })
  .strict();

router.patch(
  '/:storeId/catalog-import/:jobId/items/:itemId',
  ...admin,
  writeLimiter,
  wrap(async (req, res) => {
    const patch = patchSchema.parse(req.body);
    const item = await svc.patchItem(
      req.params.storeId,
      req.params.jobId,
      req.params.itemId,
      patch
    );
    res.json({ success: true, data: item });
  })
);

router.post(
  '/:storeId/catalog-import/:jobId/items/bulk-accept',
  ...admin,
  writeLimiter,
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await svc.bulkAcceptHighConfidence(req.params.storeId, req.params.jobId),
    });
  })
);

// The original bytes for the review screen. Tenant-checked; type re-sniffed; never executed in-page.
router.get(
  '/:storeId/catalog-import/:jobId/files/:fileId/source',
  ...admin,
  wrap(async (req, res) => {
    const f = await svc.getSourceFile(req.params.storeId, req.params.jobId, req.params.fileId);
    res
      .status(200)
      .set({
        'Content-Type': f.mime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': 'inline',
        'Content-Security-Policy': 'sandbox',
      })
      .send(f.body);
  })
);

router.post(
  '/:storeId/catalog-import/:jobId/files/:fileId/retry',
  ...admin,
  writeLimiter,
  wrap(async (req, res) => {
    await svc.retryFile(req.params.storeId, req.params.jobId, req.params.fileId);
    res.status(202).json({ success: true });
  })
);

router.post(
  '/:storeId/catalog-import/:jobId/cancel',
  ...admin,
  writeLimiter,
  wrap(async (req, res) => {
    await svc.cancelJob(req.params.storeId, req.params.jobId);
    res.json({ success: true });
  })
);

router.delete(
  '/:storeId/catalog-import/:jobId',
  ...admin,
  writeLimiter,
  wrap(async (req, res) => {
    await svc.deleteJob(req.params.storeId, req.params.jobId);
    res.json({ success: true });
  })
);

router.post(
  '/:storeId/catalog-import/:jobId/create-drafts',
  ...admin,
  writeLimiter,
  wrap(async (req, res) => {
    const body = z
      .object({ itemIds: z.array(z.string().uuid()).min(1).max(500).optional() })
      .strict()
      .parse(req.body ?? {});
    res.status(202).json({
      success: true,
      data: await svc.startCreateDrafts(req.params.storeId, req.params.jobId, body.itemIds),
    });
  })
);

router.post(
  '/:storeId/catalog-import/:jobId/publish',
  ...admin,
  writeLimiter,
  wrap(async (req, res) => {
    const body = z
      .object({ itemIds: z.array(z.string().uuid()).min(1).max(200) })
      .strict()
      .parse(req.body);
    res.json({
      success: true,
      data: await svc.publishItems(req.params.storeId, req.params.jobId, body.itemIds),
    });
  })
);

export default router;
