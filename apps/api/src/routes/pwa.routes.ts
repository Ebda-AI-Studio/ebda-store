import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import multer from 'multer';
import { pngDimensions } from '../lib/upload-sniff';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { uploadLimiter, dailyUploadLimiter, auditLog } from '../middleware/security';
import { PWAService, generatePwaIconSet } from '../services/pwa.service';
import { cleanupRemovedJsonUrls } from '../services/r2-cleanup.service';
import { tenantContext } from '../middleware/tenant-context';
import { AppError } from '../middleware/error-handler';
import { storeDb } from '../lib/repo-factory';

const router = Router();

// Mounted at the bare '/stores' prefix in routes/index.ts, so Express does
// NOT populate req.params.storeId at the mount level — every route below
// declares its own '/:storeId/...' path. router.param runs AFTER Express
// resolves :storeId for the matched route, so RLS tenant context is set
// correctly here. See F2, docs/plans/2026-07-02-rls-cutover.md.
router.param('storeId', tenantContext);

// Validation schemas
// The admin form uses controlled inputs that emit '' when cleared. Coerce
// '' to undefined for url-typed fields so a cleared icon doesn't trip
// z.string().url() and 400 the whole save.
const optionalUrl = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.string().url().optional()
);

const updateSettingsSchema = z.object({
  pwaEnabled: z.boolean().optional(),
  settings: z
    .object({
      appName: z.string().max(100).optional(),
      appNameAr: z.string().max(100).optional(),
      shortName: z.string().max(12).optional(),
      shortNameAr: z.string().max(12).optional(),
      description: z.string().max(500).optional(),
      descriptionAr: z.string().max(500).optional(),
      themeColor: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/)
        .optional(),
      backgroundColor: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/)
        .optional(),
      icon192: optionalUrl,
      icon512: optionalUrl,
      maskableIcon: optionalUrl,
      // Full icon set (B5, 2026-05-04 plan). Populated server-side by
      // POST /:storeId/pwa/icons, but also accepted here as plain URLs so
      // the admin's "Advanced" override inputs can still hand-edit them.
      iconSource: optionalUrl,
      icon384: optionalUrl,
      iconAppleTouch: optionalUrl,
      favicon32: optionalUrl,
      favicon16: optionalUrl,
      display: z.enum(['fullscreen', 'standalone', 'minimal-ui', 'browser']).optional(),
      orientation: z.enum(['any', 'portrait', 'landscape']).optional(),
      startUrl: z.string().optional(),
      installPromptEnabled: z.boolean().optional(),
      offlineEnabled: z.boolean().optional(),
      pushNotificationsEnabled: z.boolean().optional(),
      iosStatusBarStyle: z.enum(['default', 'black', 'black-translucent']).optional(),
      splashScreenColor: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/)
        .optional(),
    })
    .optional(),
});

// ==========================================
// Admin Routes
// ==========================================

// GET /stores/:storeId/pwa/settings - Get PWA settings
router.get(
  '/:storeId/pwa/settings',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('pwa'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const result = await PWAService.getSettings(storeId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/pwa/settings - Update PWA settings
router.put(
  '/:storeId/pwa/settings',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('pwa'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = updateSettingsSchema.parse(req.body);

      const result = await PWAService.updateSettings(storeId, data);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Icon-set upload (B5; Workers-safe since Ruling FU46-8). No image library runs on workerd: each
// size is resized by the Cloudflare Images binding when the deploy carries it (D1016-ICONS-1),
// else the source is stored as sent under every size's key. Either way it must be a square PNG of
// at least 512×512 (checked from its bytes below), and at most 1 MB because in the fallback the
// same bytes are served for the 16/32px favicons too.
export const PWA_ICON_MAX_BYTES = 1024 * 1024;
const iconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PWA_ICON_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new AppError(400, 'INVALID_FILE_TYPE', 'The icon must be a PNG image.', {
          messageEn: 'The icon must be a PNG image.',
          messageAr: 'الأيقونة لازم تكون صورة PNG.',
        })
      );
    }
  },
});

const MIN_ICON_DIMENSION = 512;

/** A bilingual 400 for a PWA icon source the route refuses by its bytes. */
function iconError(
  code: 'ICON_NOT_PNG' | 'ICON_NOT_SQUARE' | 'ICON_TOO_SMALL',
  dims?: { width: number; height: number }
): AppError {
  const got = dims ? ` (${dims.width}×${dims.height})` : '';
  const text = {
    ICON_NOT_PNG: ['The icon must be a PNG image.', 'الأيقونة لازم تكون صورة PNG.'],
    ICON_NOT_SQUARE: [`The icon must be square${got}.`, `الأيقونة لازم تكون مربعة${got}.`],
    ICON_TOO_SMALL: [
      `The icon must be at least ${MIN_ICON_DIMENSION}×${MIN_ICON_DIMENSION}px${got}.`,
      `الأيقونة لازم تكون ${MIN_ICON_DIMENSION}×${MIN_ICON_DIMENSION} بكسل على الأقل${got}.`,
    ],
  }[code];
  return new AppError(400, code, text[0], { messageEn: text[0], messageAr: text[1] });
}

// POST /stores/:storeId/pwa/icons - Upload one source icon, generate the
// full size set server-side, persist the resulting URLs onto pwaSettings.
router.post(
  '/:storeId/pwa/icons',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('pwa'),
  uploadLimiter,
  dailyUploadLimiter,
  iconUpload.single('source'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const file = req.file;
      if (!file) {
        throw new AppError(400, 'NO_FILE', 'Upload a square PNG icon, 512×512px or larger', {
          messageEn: 'Upload a square PNG icon, 512×512px or larger',
          messageAr: 'ارفع أيقونة PNG مربعة بحجم 512×512 بكسل أو أكبر',
        });
      }

      // The bytes decide (Ruling FU46-8): a PNG by its magic, its size from IHDR.
      const dims = pngDimensions(file.buffer);
      if (!dims) throw iconError('ICON_NOT_PNG');
      if (dims.width !== dims.height) throw iconError('ICON_NOT_SQUARE', dims);
      if (dims.width < MIN_ICON_DIMENSION) throw iconError('ICON_TOO_SMALL', dims);

      const previous = await (
        await storeDb(storeId)
      ).store.findUnique({
        where: { id: storeId },
        select: { pwaSettings: true },
      });
      // The maskable icon is padded with the store's PWA background (D1016-ICONS-1).
      const bg = (previous?.pwaSettings as Record<string, unknown> | null)?.backgroundColor;
      const generated = await generatePwaIconSet(storeId, file.buffer, {
        background: typeof bg === 'string' ? bg : undefined,
      });
      const result = await PWAService.updateSettings(storeId, { settings: generated });
      // Every generation writes NEW versioned keys (pwa.service.ts), so the
      // previous generation's icons are unreferenced from here on. Delete
      // them once this write commits (issue 2201) instead of leaving ~9
      // objects per upload for an opt-in sweeper — `cleanupRemovedJsonUrls`
      // re-checks every URL against the shared reference registry, so an
      // icon still used anywhere else is kept.
      // Diffed against the MERGED settings (what updateSettings persisted), so
      // only URLs this generation replaced are candidates.
      const previousSettings = (previous?.pwaSettings ?? {}) as Record<string, unknown>;
      void cleanupRemovedJsonUrls(previousSettings, { ...previousSettings, ...generated });

      await auditLog({
        action: 'pwa.icons.uploaded',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: storeId,
        details: {
          filename: file.originalname,
          size: file.size,
          sourceDims: `${dims.width}x${dims.height}`,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { icons: generated, ...result },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Public Routes
// ==========================================

// GET /public/:storeId/manifest.json - Get PWA manifest
router.get(
  '/public/:storeId/manifest.json',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const manifest = await PWAService.generateManifest(storeId);

      if (!manifest) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'PWA not enabled for this store' },
        });
        return;
      }

      res.setHeader('Content-Type', 'application/manifest+json');
      res.json(manifest);
    } catch (error) {
      next(error);
    }
  }
);

// GET /public/:storeId/pwa/config - Get PWA configuration for frontend
router.get(
  '/public/:storeId/pwa/config',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const [swConfig, iosConfig] = await Promise.all([
        PWAService.getServiceWorkerConfig(storeId),
        PWAService.getIOSConfig(storeId),
      ]);

      res.json({
        success: true,
        data: {
          serviceWorker: swConfig,
          ios: iosConfig,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
