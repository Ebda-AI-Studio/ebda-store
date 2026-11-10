import { generateImageVariants } from '../services/image-variants.service';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { checkStoreAccess } from '../middleware/store-access';
import { r2KeyBelongsToStore } from '../services/r2-cleanup.service';
import { requirePermission } from '../middleware/rbac';
import { StorageService } from '../services/storage.service';
import { resizeToAspect, enforceMaxDimensions } from '../services/image-resize.service';
import { uploadLimiter, dailyUploadLimiter, auditLog } from '../middleware/security';
import { runInStoreTenantContext } from '../lib/store-scoped-read';
import {
  IMAGE_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_BATCH_MAX,
  IMAGE_UPLOAD_ACCEPTED_TYPES,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { sniffVideo, VIDEO_MAX_BYTES } from '../lib/video-sniff';
import {
  sniffImage,
  IMAGE_EXT,
  sniffFont,
  FONT_EXT,
  renameByKind,
  uploadContentError,
} from '../lib/upload-sniff';

/**
 * Run a function under the tenant RLS context if a storeId is known,
 * or pass through unchanged otherwise. Upload routes accept a `storeId`
 * via query / header / body — when present we want every downstream
 * Prisma call (audit log inserts) to run with `current_store_id()` set
 * so RLS policies enforce tenant isolation. The legacy super_admin
 * "no storeId" path still needs to write platform-scoped rows, so we
 * fall through to the bare prisma client there.
 *
 * A store on its Durable Object gets the bare store scope (no Postgres transaction): `runInTenantContext` opened a
 * Prisma `$transaction`, which is POSTGRES_REMOVED on the Worker and 500ed every photo upload (2026-11-10, Ruling UPLOAD-DO-1).
 */
function withOptionalTenantContext<T>(storeId: string | null, fn: () => Promise<T>): Promise<T> {
  if (!storeId) return fn();
  return runInStoreTenantContext(storeId, fn);
}

const router = Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: IMAGE_UPLOAD_MAX_BYTES,
    files: IMAGE_UPLOAD_BATCH_MAX, // FU46-6: the admin batches larger selections
  },
  fileFilter: (_req, file, cb) => {
    // The declared type is only a first filter (the bytes decide, see upload-sniff.ts); it is
    // the same list the admin picker offers, so ICO/SVG/HEIC never reach the sniff.
    if ((IMAGE_UPLOAD_ACCEPTED_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, 'INVALID_FILE_TYPE', `Invalid file type: ${file.mimetype}`));
    }
  },
});

/**
 * GET /uploads/status
 * Check if storage is configured
 */
router.get('/status', authenticate, (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      available: StorageService.isAvailable(),
    },
  });
});

/**
 * Per-store upload folder whitelist. Mirrors the set in storage.service.ts —
 * we validate here too so a bad folder hint fails fast before we touch the
 * uploaded buffer or hit R2. `misc` is the default when callers don't pass
 * a folder hint at all.
 */
const ALLOWED_FOLDERS = new Set([
  'logos',
  'products',
  'categories',
  'pages',
  'branding',
  'hero',
  // Visual builder media (section images picked in the editor).
  'builder',
  'misc',
  // Custom fonts (woff2/woff/ttf/otf) uploaded by the typography
  // admin. The /uploads/font endpoint enforces the file-type filter
  // — this set is the broader allowlist for both image and font flows.
  'fonts',
]);

/**
 * Resolve the folder hint + tenant scope for an upload request.
 *
 * - `folder` comes from the query string. Defaults to `misc`.
 *   Disallowed values produce a 400 INVALID_FOLDER.
 * - `storeId` comes from query / header / JWT, in that order.
 *   ANY value picked from those sources is then verified against
 *   `Store.ownerId` for the caller — without this check, a merchant
 *   of store A could pass `storeId=<other-store>` in the header and
 *   write into another tenant's R2 prefix (the storage service uses
 *   the storeId verbatim to compose `stores/<id>/...` keys). We need
 *   the same ownership guard `requireStoreAccess` provides on the
 *   middleware layer, but applied INSIDE the handler since multi-form
 *   uploads include the storeId in body fields, not the URL.
 *
 * super_admin bypasses the ownership check (cross-tenant uploads are
 * an intentional platform-staff capability — same semantics as the
 * existing `requireStoreAccess` middleware).
 */
export async function resolveFolderAndStore(
  req: Request
): Promise<
  | { ok: true; folder: string; storeId: string | null }
  | { ok: false; status: number; error: { code: string; message: string } }
> {
  const rawFolder = (req.query.folder as string | undefined) || 'misc';
  const folder = rawFolder.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!ALLOWED_FOLDERS.has(folder)) {
    return {
      ok: false,
      status: 400,
      error: {
        code: 'INVALID_FOLDER',
        message: `Folder '${folder}' is not allowed. Allowed: ${Array.from(ALLOWED_FOLDERS).join(', ')}`,
      },
    };
  }
  const queryStoreId = (req.query.storeId as string | undefined) || undefined;
  const headerStoreId = (req.headers['x-store-id'] as string | undefined) || undefined;
  const userStoreId = req.user?.storeId || undefined;
  const storeId = queryStoreId || headerStoreId || userStoreId || null;

  // No storeId at all. `storage.service.ts`'s `composeKey` HARD-FAILS
  // (AppError 400 MISSING_TENANT) for every folder in ALLOWED_FOLDERS above
  // — there is no tenant-less key it will write, by design, since 2026-08-09
  // (see its doc comment). Reject here too, before touching the uploaded
  // buffer or hitting R2, instead of letting a super_admin's request reach
  // the service only to be rejected deeper in. A non-super-admin still gets
  // the more specific 403 first.
  if (!storeId) {
    if (req.user?.role !== 'super_admin') {
      return {
        ok: false,
        status: 403,
        error: { code: 'FORBIDDEN', message: 'storeId is required for non-super-admin uploads' },
      };
    }
    return {
      ok: false,
      status: 400,
      error: {
        code: 'MISSING_TENANT',
        message: 'storeId is required — every upload must be scoped to a store.',
      },
    };
  }

  // Verify the caller owns this storeId before we trust it as the R2
  // key prefix. super_admin always passes; store_admin must own it.
  const access = await checkStoreAccess(storeId, req.user!);
  if (!access.ok) {
    return {
      ok: false,
      status: access.status,
      error: { code: access.code, message: access.message },
    };
  }
  return { ok: true, folder, storeId };
}

/**
 * GET /uploads/list?storeId=<id>&folder=<folder>&cursor=<token>
 * The visual builder's media picker: one page of the store's own uploaded
 * images (R2 prefix `stores/<storeId>/<folder>/`, or every folder when
 * `folder` is omitted). Same tenant check as the upload routes
 * (`resolveFolderAndStore`: ownership verified, super_admin may cross), and a
 * store id is REQUIRED — there is no un-scoped listing.
 */
router.get(
  '/list',
  authenticate,
  requirePermission('products:write'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const folderGiven = typeof req.query.folder === 'string' && req.query.folder !== '';
      const resolved = await resolveFolderAndStore(req);
      if (!resolved.ok) {
        res.status(resolved.status).json({ success: false, error: resolved.error });
        return;
      }
      if (!resolved.storeId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_TENANT', message: 'storeId is required' },
        });
        return;
      }
      const prefix = `stores/${resolved.storeId}/${folderGiven ? `${resolved.folder}/` : ''}`;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const page = await StorageService.listByPrefix(prefix, { cursor, limit: 60 });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ success: true, data: page });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /uploads/image
 * Upload a single image
 */
router.post(
  '/image',
  authenticate,
  requirePermission('products:write'),
  uploadLimiter,
  dailyUploadLimiter,
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'No file uploaded' },
        });
        return;
      }
      const sniffed = sniffImage(req.file.buffer);
      if (!sniffed) {
        res.status(400).json({ success: false, error: uploadContentError('image') });
        return;
      }

      const resolved = await resolveFolderAndStore(req);
      if (!resolved.ok) {
        res.status(resolved.status).json({ success: false, error: resolved.error });
        return;
      }

      const result = await withOptionalTenantContext(resolved.storeId, async () => {
        // R2 upload itself doesn't touch Postgres so the tenant
        // context is mostly there for the audit log, but wrapping the
        // whole block keeps the boundary obvious — every per-tenant
        // side-effect of an upload happens under the SET LOCAL.
        //
        // Auto-resize per ?aspect= query param (ahmad's ask 2026-05-16:
        // 'if image not in recommended size, backend resizes to recommended').
        // ImageUpload in admin sends its aspectRatio prop as ?aspect=.
        // Falls back to original buffer when unset / unknown / sharp fails.
        const aspectQuery = (req.query.aspect as string | undefined) ?? undefined;
        const aspectResized = await resizeToAspect(req.file!.buffer, aspectQuery);
        // Unconditional ceiling AFTER the optional aspect crop. resizeToAspect
        // is opt-in via ?aspect= and no product-image surface sends it, so
        // without this a 26 MP camera original is stored and served as-is —
        // which is exactly how demo-boutique ended up shipping a 28 MB PNG to mobile
        // customers for three months.
        const resizedBuffer = await enforceMaxDimensions(aspectResized);

        // Named by the bytes we STORE (a resize can re-encode a GIF to JPEG), never the
        // client's name: storage derives the Content-Type from this extension.
        const storedKind = sniffImage(resizedBuffer) ?? sniffed;
        const uploaded = await StorageService.upload(
          resizedBuffer,
          renameByKind(req.file!.originalname, IMAGE_EXT[storedKind], 'image'),
          {
            folder: resolved.folder,
            storeId: resolved.storeId,
          }
        );

        // PREMIUM-2: resized WebP variants, once, at upload. Never fails the upload.
        await generateImageVariants(uploaded.key, resizedBuffer);

        await auditLog({
          storeId: resolved.storeId ?? undefined,
          action: 'file.uploaded',
          userId: req.user!.userId,
          resourceType: 'file',
          resourceId: uploaded.key,
          details: {
            filename: req.file!.originalname,
            size: uploaded.size,
            contentType: uploaded.contentType,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        return uploaded;
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

// ── Video (page-builder hero loops) ─────────────────────────────────────────
// Separate multer + endpoint: image routes must never start accepting video.
// Declared mime AND magic bytes must agree (see lib/video-sniff.ts).
const VIDEO_FOLDERS = new Set(['hero', 'builder']);
const VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VIDEO_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if ((VIDEO_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, 'INVALID_VIDEO_TYPE', 'Only video/mp4 and video/webm are accepted'));
    }
  },
});

/** multer's size error -> 413, other MulterErrors -> 400, the filter's AppError -> its own status. */
function receiveVideo(req: Request, res: Response, next: NextFunction): void {
  videoUpload.single('file')(req, res, (err?: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        success: false,
        error: { code: 'VIDEO_TOO_LARGE', message: 'Video is larger than 6 MB' },
      });
      return;
    }
    if (err instanceof multer.MulterError) {
      // LIMIT_UNEXPECTED_FILE / LIMIT_FILE_COUNT (a second file, a wrong field): the client's fault.
      res.status(400).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof AppError) {
      res
        .status(err.statusCode)
        .json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    next(err);
  });
}

/**
 * POST /uploads/video?folder=hero|builder&storeId=<id>
 * One mp4/webm (<= 6 MB) into stores/<storeId>/<folder>/. Returns the same
 * `{ success, data: { url, key, size, contentType } }` shape as /image.
 */
router.post(
  '/video',
  authenticate,
  requirePermission('products:write'),
  uploadLimiter,
  dailyUploadLimiter,
  receiveVideo,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'No file uploaded' },
        });
        return;
      }
      if (file.buffer.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'EMPTY_FILE', message: 'The uploaded file is empty' },
        });
        return;
      }
      if (file.buffer.length > VIDEO_MAX_BYTES) {
        res.status(413).json({
          success: false,
          error: { code: 'VIDEO_TOO_LARGE', message: 'Video is larger than 6 MB' },
        });
        return;
      }

      const resolved = await resolveFolderAndStore(req);
      if (!resolved.ok) {
        res.status(resolved.status).json({ success: false, error: resolved.error });
        return;
      }
      if (!VIDEO_FOLDERS.has(resolved.folder)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_FOLDER',
            message: `Video uploads are limited to: ${Array.from(VIDEO_FOLDERS).join(', ')}`,
          },
        });
        return;
      }

      const sniffed = sniffVideo(file.buffer);
      if (!sniffed || sniffed !== file.mimetype) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_VIDEO_CONTENT',
            message: 'File content does not match a valid mp4/webm video',
          },
        });
        return;
      }

      // Store under the SNIFFED type's extension, never the client's filename ext.
      const ext = sniffed === 'video/mp4' ? '.mp4' : '.webm';
      const base = file.originalname.replace(/\.[^.]*$/, '') || 'video';

      const result = await withOptionalTenantContext(resolved.storeId, async () => {
        const uploaded = await StorageService.upload(file.buffer, `${base}${ext}`, {
          folder: resolved.folder,
          storeId: resolved.storeId,
          contentType: sniffed,
          allowedTypes: [...VIDEO_TYPES],
          maxSize: VIDEO_MAX_BYTES,
          cacheControl: 'public, max-age=31536000, immutable',
        });

        await auditLog({
          storeId: resolved.storeId ?? undefined,
          action: 'file.uploaded',
          userId: req.user!.userId,
          resourceType: 'file',
          resourceId: uploaded.key,
          details: {
            filename: file.originalname,
            size: uploaded.size,
            contentType: uploaded.contentType,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        return uploaded;
      });

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /uploads/images
 * Upload multiple images
 */
router.post(
  '/images',
  authenticate,
  requirePermission('products:write'),
  uploadLimiter,
  dailyUploadLimiter,
  upload.array('files', IMAGE_UPLOAD_BATCH_MAX),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_FILES', message: 'No files uploaded' },
        });
        return;
      }
      // One non-image refuses the whole batch: nothing in it is stored. `invalidIndexes`
      // (positions in this request, never the client's filenames) lets the admin name the
      // refused files and re-send the rest.
      const sniffedAll = files.map(f => sniffImage(f.buffer));
      if (sniffedAll.some(kind => kind === null)) {
        const invalidIndexes = sniffedAll.flatMap((kind, i) => (kind === null ? [i] : []));
        res
          .status(400)
          .json({ success: false, error: uploadContentError('image', { invalidIndexes }) });
        return;
      }

      const resolved = await resolveFolderAndStore(req);
      if (!resolved.ok) {
        res.status(resolved.status).json({ success: false, error: resolved.error });
        return;
      }

      const results = await withOptionalTenantContext(resolved.storeId, async () => {
        // Same unconditional size ceiling as POST /image — batching the
        // upload must not be a way to opt out of it. Without this, a
        // multi-select gallery upload stored camera originals at full size
        // (see enforceMaxDimensions' doc comment for the incident this
        // guards against).
        const capped = await Promise.all(
          files.map(async (f, i) => {
            const buffer = await enforceMaxDimensions(f.buffer);
            const kind = sniffImage(buffer) ?? sniffedAll[i]!;
            return { buffer, filename: renameByKind(f.originalname, IMAGE_EXT[kind], 'image') };
          })
        );
        const uploaded = await StorageService.uploadMultiple(capped, {
          folder: resolved.folder,
          storeId: resolved.storeId,
        });

        await auditLog({
          storeId: resolved.storeId ?? undefined,
          action: 'files.uploaded',
          userId: req.user!.userId,
          resourceType: 'file',
          details: {
            count: uploaded.length,
            totalSize: uploaded.reduce((sum, r) => sum + r.size, 0),
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        return uploaded;
      });

      res.json({
        success: true,
        data: { files: results },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /uploads/:key
 * Delete a file
 */
router.delete(
  // path-to-regexp v6 syntax: `:key(*)` makes `key` capture the rest
  // of the URL (so `/uploads/stores/<id>/products/abc.jpg` resolves
  // to `key = "stores/<id>/products/abc.jpg"`). The migration to
  // Express 5 / path-to-regexp v8 (which renames this to `/*key`)
  // is deferred — the v5 type changes propagate `string | string[]`
  // through every `req.params.X` read in the codebase, which is a
  // bigger refactor than this hardening pass should take on.
  '/:key(*)',
  authenticate,
  requirePermission('products:delete'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key } = req.params;

      // Validate key doesn't contain path traversal
      if (key.includes('..') || key.startsWith('/')) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_KEY', message: 'Invalid file key' },
        });
        return;
      }

      // Verify the caller owns the storeId in the header BEFORE the
      // prefix check. The previous version trusted the header value
      // verbatim — a forged `x-store-id: <victim-store>` paired with a
      // forged key under that prefix would pass the prefix check, and
      // the only thing standing between the request and a cross-tenant
      // delete was the multer/permission middleware (which doesn't
      // bind the header to the user's actual store ownership).
      const storeId = req.headers['x-store-id'] as string;
      if (!storeId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_STORE', message: 'Store ID is required' },
        });
        return;
      }

      const access = await checkStoreAccess(storeId, req.user!);
      if (!access.ok) {
        res
          .status(access.status)
          .json({ success: false, error: { code: access.code, message: access.message } });
        return;
      }

      if (!r2KeyBelongsToStore(key, storeId, { legacyFlat: true })) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Cannot delete files from another store' },
        });
        return;
      }

      await withOptionalTenantContext(storeId, async () => {
        await StorageService.delete(key);

        await auditLog({
          storeId,
          action: 'file.deleted',
          userId: req.user!.userId,
          resourceType: 'file',
          resourceId: key,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      });

      res.json({
        success: true,
        data: { message: 'File deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Custom-font uploads have a different MIME-type allowlist than image
// uploads, so they get their own multer + endpoint instead of bolting
// onto /uploads/image.
const fontUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB — fonts are typically <500KB; cap is generous
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = new Set([
      'font/woff2',
      'font/woff',
      'font/ttf',
      'font/otf',
      // Browsers are inconsistent about font MIME types — some send
      // application/* variants. Accept the safe set that maps to
      // formats we'd write into a CSS @font-face src().
      'application/font-woff2',
      'application/font-woff',
      'application/x-font-woff',
      'application/x-font-woff2',
      'application/x-font-ttf',
      'application/x-font-otf',
      'application/octet-stream', // Some browsers send this for fonts; we still validate the extension below.
    ]);
    const allowedExts = /\.(woff2|woff|ttf|otf)$/i;
    if (allowedTypes.has(file.mimetype) || allowedExts.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          400,
          'INVALID_FONT_TYPE',
          `Invalid font file: ${file.originalname} (${file.mimetype})`
        )
      );
    }
  },
});

/**
 * POST /uploads/font
 * Upload a custom font file (.woff2 / .woff / .ttf / .otf) into
 * `stores/<storeId>/fonts/...`. Used by the typography admin page.
 * Returns the public URL + format (extension) so the admin can write
 * a TypographyFontSourceCustom entry into the store's typography
 * config without a second round-trip.
 */
router.post(
  '/font',
  authenticate,
  // BE:S-18: `settings:write` is super_admin only, so every merchant got 403 on the typography page. The store owner's own
  // permission is `store:settings`; `checkStoreAccess` below still pins the upload to a store the caller can manage.
  requirePermission('store:settings'),
  uploadLimiter,
  dailyUploadLimiter,
  fontUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'No font file uploaded' },
        });
        return;
      }
      // The bytes decide the format (the filter above admits octet-stream and any name).
      const fontKind = sniffFont(req.file.buffer);
      if (!fontKind) {
        res.status(400).json({ success: false, error: uploadContentError('font') });
        return;
      }

      // Force the folder to `fonts` regardless of what the client sent
      // — keeps every per-store font under a predictable prefix that
      // `r2-orphan-audit.ts` and the typography R2-cleanup branch can
      // reason about.
      const storeId = (req.query.storeId as string) || (req.headers['x-store-id'] as string);
      if (!storeId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_STORE', message: 'storeId is required for font uploads' },
        });
        return;
      }
      const access = await checkStoreAccess(storeId, req.user!);
      if (!access.ok) {
        res
          .status(access.status)
          .json({ success: false, error: { code: access.code, message: access.message } });
        return;
      }

      const ext = FONT_EXT[fontKind].slice(1);
      const result = await withOptionalTenantContext(storeId, async () => {
        const uploaded = await StorageService.upload(
          req.file!.buffer,
          renameByKind(req.file!.originalname, FONT_EXT[fontKind], 'font'),
          {
            folder: 'fonts',
            storeId,
            contentType: fontKind,
            allowedTypes: ['font/woff2', 'font/woff', 'font/ttf', 'font/otf'],
          }
        );

        await auditLog({
          storeId,
          action: 'font.uploaded',
          userId: req.user!.userId,
          resourceType: 'file',
          resourceId: uploaded.key,
          details: { filename: req.file!.originalname, size: uploaded.size, format: ext },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        return { ...uploaded, format: ext };
      });

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
