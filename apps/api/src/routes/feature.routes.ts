import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { prisma } from '@force/database';
import { featureKeySchema, featureUpdatesSchema, FEATURE_REGISTRY } from '@force/shared';
import { featureService } from '../services/feature.service';

const router = Router();

// ==========================================
// Super Admin Routes
// Mounted at /admin — full feature management
// ==========================================

/**
 * GET /admin/stores/:id/features
 * Get all feature states + metadata for a store
 */
router.get(
  '/stores/:id/features',
  authenticate,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const [features, metadataRows] = await Promise.all([
        featureService.getStoreFeatures(id),
        prisma.storeFeature.findMany({
          where: { storeId: id },
          select: {
            featureKey: true,
            enabled: true,
            enabledAt: true,
            enabledBy: true,
            updatedAt: true,
          },
        }),
      ]);

      // Enrich metadata with enabledBy user name
      const userIds = metadataRows
        .map(r => r.enabledBy)
        .filter((uid): uid is string => uid !== null && uid !== undefined);

      const uniqueUserIds = [...new Set(userIds)];

      const users =
        uniqueUserIds.length > 0
          ? await prisma.user.findMany({
              where: { id: { in: uniqueUserIds } },
              select: { id: true, firstName: true, lastName: true },
            })
          : [];

      const userMap = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

      const metadata = metadataRows.map(row => ({
        featureKey: row.featureKey,
        enabled: row.enabled,
        enabledAt: row.enabledAt,
        enabledBy: row.enabledBy ? (userMap.get(row.enabledBy) ?? row.enabledBy) : null,
        updatedAt: row.updatedAt,
      }));

      res.json({
        success: true,
        data: { features, metadata, registry: FEATURE_REGISTRY },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /admin/stores/:id/features
 * Bulk update features for a store
 */
router.put(
  '/stores/:id/features',
  authenticate,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const parsed = featureUpdatesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'Invalid request body',
          },
        });
        return;
      }

      const features = await featureService.updateStoreFeatures(id, parsed.data, req.user!.userId);

      res.json({
        success: true,
        data: { features },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /admin/stores/:id/features/:featureKey
 * Set a single feature flag (idempotent)
 */
router.put(
  '/stores/:id/features/:featureKey',
  authenticate,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, featureKey } = req.params;

      const keyParsed = featureKeySchema.safeParse(featureKey);
      if (!keyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_FEATURE_KEY', message: `Unknown feature key: ${featureKey}` },
        });
        return;
      }

      const bodySchema = z.object({ enabled: z.boolean() });
      const bodyParsed = bodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: '`enabled` must be a boolean' },
        });
        return;
      }

      const features = await featureService.setFeature(
        id,
        keyParsed.data,
        bodyParsed.data.enabled,
        req.user!.userId
      );

      res.json({
        success: true,
        data: { features },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Store Admin Routes
// Mounted at /stores/:storeId — own store only
// ==========================================

/**
 * GET /stores/:storeId/my-features
 * Get own store's features (for store_admin sidebar gating)
 */
router.get(
  '/:storeId/my-features',
  authenticate,
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = req.params.storeId || (req as any).store?.id;

      const features = await featureService.getStoreFeatures(storeId);

      res.json({
        success: true,
        data: { features },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
