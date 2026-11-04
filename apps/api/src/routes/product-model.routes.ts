/**
 * Product 3D models — admin API. Mounted at `/stores/:storeId/product-models`
 * ABOVE the `/stores/:storeId/products` and `/stores/:storeId` tenantContext
 * mounts in routes/index.ts (load-bearing: an Express `use` mount is a prefix
 * match, so a later tenantContext mount would open the request transaction
 * before these handlers ran — #1602).
 *
 * Why the two uploads are NOT inside a request transaction: a 15 MB file on a
 * mobile link can take longer than the 30 s the request transaction lives.
 * They validate the bytes, put the object in R2 with no transaction open, then
 * write the row in ONE short `runInTenantContext`; if that write fails, the
 * just-written object is deleted (compensation, rule multi-step-rollback).
 * Every other route is DB-only and runs under `tenantContext` as usual.
 *
 * Design: docs/plans/2026-10-07-product-3d-viewer.md.
 */
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { runInTenantContext } from '@ebda/database';
import {
  MODEL3D_MAX_BYTES,
  model3dBindingsBodySchema,
  model3dErrorMessage,
  model3dUpdateSchema,
  validateGlb,
  validateUsdz,
  type Model3dErrorCode,
} from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { tenantContext } from '../middleware/tenant-context';
import { uploadLimiter, dailyUploadLimiter, auditLog, writeLimiter } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import { StorageService } from '../services/storage.service';
import {
  deleteR2ObjectIfOrphan,
  r2KeyBelongsToStore,
  urlToR2Key,
} from '../services/r2-cleanup.service';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import logger from '../lib/logger';
import { storeDb, storeWriter } from '../lib/repo-factory';
import {
  ADMIN_MODEL3D_SELECT,
  assertProductInStore,
  getAdminModel,
  getModelRow,
  replaceBindings,
  setUsdz,
  upsertModel,
} from '../services/product-model.service';

const router = Router({ mergeParams: true });

// Byte-level validation decides what a file is (validateGlb/validateUsdz), so
// there is no MIME filter here: browsers send `application/octet-stream`,
// `model/gltf-binary` or nothing at all for these types.
const modelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MODEL3D_MAX_BYTES, files: 1 },
});

/** Turn multer's size error into the same bilingual 400 the validator gives. */
function receiveFile(req: Request, res: Response, next: NextFunction): void {
  modelUpload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      sendInvalid(res, 'TOO_LARGE');
      return;
    }
    next(err);
  });
}

function sendInvalid(res: Response, code: Model3dErrorCode, detail?: string): void {
  res.status(400).json({
    success: false,
    error: {
      code: 'INVALID_MODEL',
      message: model3dErrorMessage(code, 'en'),
      details: {
        reason: code,
        detail,
        messageEn: model3dErrorMessage(code, 'en'),
        messageAr: model3dErrorMessage(code, 'ar'),
      },
    },
  });
}

/** `ring 01.glb` → `ring-01.glb`-ish; storage.service sanitizes again. */
function fileNameWith(original: string | undefined, ext: '.glb' | '.usdz'): string {
  const base = (original ?? 'model').replace(/\.[^.]*$/, '') || 'model';
  return `${base}${ext}`;
}

const writeChain = [
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  requireFeature('product_3d'),
];

// GET /stores/:storeId/product-models/:productId — model (or null) + the
// product's options with value ids for the mapping table. Not feature-gated:
// a store whose feature was switched off can still see (and delete) its model.
router.get(
  '/:productId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const data = await getAdminModel(storeId, productId);
      res.json({ success: true, data: { ...data, limits: { maxBytes: MODEL3D_MAX_BYTES } } });
    } catch (err) {
      next(err);
    }
  }
);

// POST /stores/:storeId/product-models/:productId/glb — upload / replace the GLB.
router.post(
  '/:productId/glb',
  ...writeChain,
  uploadLimiter,
  dailyUploadLimiter,
  receiveFile,
  async (req: Request, res: Response, next: NextFunction) => {
    const { storeId, productId } = req.params;
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: { code: 'NO_FILE', message: 'No file' } });
        return;
      }
      const bytes = new Uint8Array(
        req.file.buffer.buffer,
        req.file.buffer.byteOffset,
        req.file.size
      );
      const result = validateGlb(bytes);
      if (!result.ok) {
        sendInvalid(res, result.code, result.detail);
        return;
      }
      // Fail before the R2 write when the product is not this store's.
      await runInTenantContext(storeId, () => assertProductInStore(storeId, productId));

      const uploaded = await StorageService.upload(
        req.file.buffer,
        fileNameWith(req.file.originalname, '.glb'),
        {
          folder: 'models',
          storeId,
          contentType: 'model/gltf-binary',
          allowedTypes: ['model/gltf-binary'],
          maxSize: MODEL3D_MAX_BYTES,
        }
      );

      let saved: {
        written: Awaited<ReturnType<typeof upsertModel>>;
        model: unknown;
      };
      try {
        saved = await runInTenantContext(storeId, async () => {
          const w = await upsertModel(storeId, productId, {
            modelUrl: uploaded.url,
            modelBytes: uploaded.size,
            materials: result.materials,
            gltfVariants: result.gltfVariants,
            stats: result.stats,
          });
          await auditLog({
            action: 'product.model3d.uploaded',
            userId: req.user!.userId,
            resourceType: 'product',
            resourceId: productId,
            details: { key: uploaded.key, size: uploaded.size, vertices: result.stats.vertices },
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });
          const m = await (
            await storeDb(storeId)
          ).productModel.findFirst({
            where: { storeId, productId },
            select: ADMIN_MODEL3D_SELECT,
          });
          return { written: w, model: m };
        });
      } catch (err) {
        // Compensation: the row never committed, so the object is unreferenced.
        await StorageService.delete(uploaded.key).catch(e =>
          logger.warn({ err: e, key: uploaded.key }, '[model3d] compensating R2 delete failed')
        );
        throw err;
      }

      const { written, model } = saved;
      if (written.previousModelUrl && written.previousModelUrl !== uploaded.url) {
        void deleteR2ObjectIfOrphan(written.previousModelUrl);
      }
      await invalidateStoreProductCaches(storeId);
      res.status(201).json({
        success: true,
        data: { model, warnings: result.warnings, droppedBindings: written.droppedBindings },
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /stores/:storeId/product-models/:productId/usdz — optional iOS AR file.
router.post(
  '/:productId/usdz',
  ...writeChain,
  uploadLimiter,
  dailyUploadLimiter,
  receiveFile,
  async (req: Request, res: Response, next: NextFunction) => {
    const { storeId, productId } = req.params;
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: { code: 'NO_FILE', message: 'No file' } });
        return;
      }
      const bytes = new Uint8Array(
        req.file.buffer.buffer,
        req.file.buffer.byteOffset,
        req.file.size
      );
      const result = validateUsdz(bytes);
      if (!result.ok) {
        sendInvalid(res, result.code);
        return;
      }
      await runInTenantContext(storeId, () => getModelRow(storeId, productId));
      const uploaded = await StorageService.upload(
        req.file.buffer,
        fileNameWith(req.file.originalname, '.usdz'),
        {
          folder: 'models',
          storeId,
          contentType: 'model/vnd.usdz+zip',
          allowedTypes: ['model/vnd.usdz+zip'],
          maxSize: MODEL3D_MAX_BYTES,
        }
      );
      let previous: string | null;
      try {
        const r0 = await runInTenantContext(storeId, async () => {
          const r = await setUsdz(storeId, productId, uploaded.url, uploaded.size);
          await auditLog({
            action: 'product.model3d.usdz_uploaded',
            userId: req.user!.userId,
            resourceType: 'product',
            resourceId: productId,
            details: { key: uploaded.key, size: uploaded.size },
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });
          return r;
        });
        previous = r0.previousUsdzUrl;
      } catch (err) {
        await StorageService.delete(uploaded.key).catch(e =>
          logger.warn({ err: e, key: uploaded.key }, '[model3d] compensating R2 delete failed')
        );
        throw err;
      }
      if (previous && previous !== uploaded.url) void deleteR2ObjectIfOrphan(previous);
      await invalidateStoreProductCaches(storeId);
      res
        .status(201)
        .json({ success: true, data: { usdzUrl: uploaded.url, usdzBytes: uploaded.size } });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /stores/:storeId/product-models/:productId — alt text, AR toggle,
// poster, remove USDZ.
router.put(
  '/:productId',
  ...writeChain,
  writeLimiter,
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const body = model3dUpdateSchema.parse(req.body);
      // A poster must be one of OUR objects, in THIS store's prefix — never a
      // third-party URL every shopper's browser would then fetch.
      if (body.posterUrl) {
        const key = urlToR2Key(body.posterUrl);
        if (!key || !r2KeyBelongsToStore(key, storeId)) {
          throw new AppError(
            400,
            'INVALID_POSTER',
            'Poster must be an image uploaded to this store'
          );
        }
      }
      const current = await getModelRow(storeId, productId);
      const model = await (
        await storeWriter(storeId)
      ).productModel.update({
        where: { id: current.id, storeId },
        data: {
          ...(body.altText !== undefined ? { altText: body.altText || null } : {}),
          ...(body.altTextAr !== undefined ? { altTextAr: body.altTextAr || null } : {}),
          ...(body.arEnabled !== undefined ? { arEnabled: body.arEnabled } : {}),
          ...(body.posterUrl !== undefined ? { posterUrl: body.posterUrl } : {}),
          ...(body.usdzUrl === null ? { usdzUrl: null, usdzBytes: null } : {}),
        },
        select: ADMIN_MODEL3D_SELECT,
      });
      if (
        body.posterUrl !== undefined &&
        current.posterUrl &&
        current.posterUrl !== body.posterUrl
      ) {
        void deleteR2ObjectIfOrphan(current.posterUrl);
      }
      if (body.usdzUrl === null && current.usdzUrl) void deleteR2ObjectIfOrphan(current.usdzUrl);
      await invalidateStoreProductCaches(storeId);
      res.json({ success: true, data: { model } });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /stores/:storeId/product-models/:productId/bindings — replace the set.
router.put(
  '/:productId/bindings',
  ...writeChain,
  writeLimiter,
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const { bindings } = model3dBindingsBodySchema.parse(req.body);
      const count = await replaceBindings(storeId, productId, bindings);
      const model = await (
        await storeDb(storeId)
      ).productModel.findFirst({
        where: { storeId, productId },
        select: ADMIN_MODEL3D_SELECT,
      });
      await invalidateStoreProductCaches(storeId);
      res.json({ success: true, data: { model, count } });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /stores/:storeId/product-models/:productId — NOT feature-gated, so a
// store whose feature was switched off can still remove its model.
router.delete(
  '/:productId',
  authenticate,
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
  tenantContext,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const current = await getModelRow(storeId, productId);
      await (
        await storeWriter(storeId)
      ).productModel.delete({ where: { id: current.id, storeId } });
      await auditLog({
        action: 'product.model3d.deleted',
        userId: req.user!.userId,
        resourceType: 'product',
        resourceId: productId,
        details: { modelUrl: current.modelUrl },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      // Deferred until after COMMIT (deleteR2ObjectIfOrphan defers itself).
      for (const url of [current.modelUrl, current.usdzUrl, current.posterUrl]) {
        if (url) void deleteR2ObjectIfOrphan(url);
      }
      await invalidateStoreProductCaches(storeId);
      res.json({ success: true, data: { deleted: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
