import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { qrSettingsSchema } from '@ebda/shared/qr/schema';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { tenantContext } from '../middleware/tenant-context';
import { requireFeature } from '../middleware/feature-gate';
import { StoreService } from '../services/store.service';
import { prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { qrStats, readQrSettings } from '../services/qr.service';
import { storeDb } from '../lib/repo-factory';

const router = Router();

// Mounted at the bare '/stores' prefix (see pwa.routes.ts): bind the RLS tenant context once
// :storeId is resolved for the matched route.
router.param('storeId', tenantContext);

const statsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

// GET /stores/:storeId/qr/settings - design settings + what the admin needs to build links
router.get(
  '/:storeId/qr/settings',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'), // BE:F-8: same gate as the /codes page
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const store = await (
        await storeDb(storeId)
      ).store.findFirst({
        where: { id: storeId },
        select: { slug: true, domain: true, domainStatus: true, whatsapp: true, settings: true },
      });
      if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');
      res.json({
        success: true,
        data: {
          settings: readQrSettings(store.settings),
          slug: store.slug,
          // Only a VERIFIED custom domain may appear in a printed code.
          domain: store.domainStatus === 'active' ? store.domain : null,
          hasWhatsapp: !!store.whatsapp,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/qr/settings - save the design (Zod strict at the edge)
router.put(
  '/:storeId/qr/settings',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'), // BE:F-8: same gate as the /codes page
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const settings = qrSettingsSchema.parse(req.body);
      await StoreService.updateQrSettings(storeId, settings);
      res.json({ success: true, data: { settings } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/qr/stats?days=30 - scans per code
router.get(
  '/:storeId/qr/stats',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'), // BE:F-8: same gate as the /codes page
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { days } = statsQuery.parse(req.query);
      res.json({ success: true, data: { days, rows: await qrStats(storeId, days) } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
