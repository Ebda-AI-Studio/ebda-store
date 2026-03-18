import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { PWAService } from '../services/pwa.service';

const router = Router();

// Validation schemas
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
      icon192: z.string().url().optional(),
      icon512: z.string().url().optional(),
      maskableIcon: z.string().url().optional(),
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
