import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { PWAService } from '../services/pwa.service';
import { tenantContext } from '../middleware/tenant-context';

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
