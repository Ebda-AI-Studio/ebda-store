import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { prisma, withStore } from '@ebda/database';
import { asOperator, platformHubOnD1 } from '../lib/platform-scope';
import { getAccountsBrief } from '../lib/identity-client';
import { storeDb } from '../lib/repo-factory';
import { featureKeySchema, featureUpdatesSchema, FEATURE_REGISTRY } from '@ebda/shared';
import { featureService } from '../services/feature.service';
import { auditLog } from '../middleware/security';

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
  requireMfaEnrolled,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const [features, metadataRows] = await Promise.all([
        featureService.getStoreFeatures(id),
        // This router is context-less (no ambient store): bind the target store AFTER
        // requireStoreAccess authorised it, so the tenant guard and RLS both see it.
        withStore(id, tx =>
          tx.storeFeature.findMany({
            where: { storeId: id },
            select: {
              featureKey: true,
              enabled: true,
              enabledAt: true,
              enabledBy: true,
              expiresAt: true,
              reason: true,
              updatedAt: true,
            },
          })
        ),
      ]);

      // Enrich metadata with enabledBy user name
      const userIds = metadataRows
        .map(r => r.enabledBy)
        .filter((uid): uid is string => uid !== null && uid !== undefined);

      const uniqueUserIds = [...new Set(userIds)];

      const users =
        uniqueUserIds.length > 0
          ? await asOperator(req.user!.userId, async () =>
              (await platformHubOnD1())
                ? getAccountsBrief(uniqueUserIds)
                : prisma.user.findMany({
                    where: { id: { in: uniqueUserIds } },
                    select: { id: true, firstName: true, lastName: true },
                  })
            )
          : [];

      const userMap = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

      const metadata = metadataRows.map(row => ({
        featureKey: row.featureKey,
        enabled: row.enabled,
        enabledAt: row.enabledAt,
        enabledBy: row.enabledBy ? (userMap.get(row.enabledBy) ?? row.enabledBy) : null,
        expiresAt: row.expiresAt,
        reason: row.reason,
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
  requireMfaEnrolled,
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

      await auditLog({
        action: 'store.features_bulk_updated',
        userId: req.user!.userId,
        storeId: id,
        resourceType: 'store',
        resourceId: id,
        details: { updates: parsed.data },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

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
  requireMfaEnrolled,
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

      // PATCH semantics (Ruling SF-EXPIRY-1): an omitted `expiresAt` / `reason` KEEPS the stored value, an explicit
      // `null` clears it. A plain toggle must never silently turn a time-boxed grant permanent. A past `expiresAt`
      // is refused: it would be a no-op override (use DELETE to clear one).
      const bodySchema = z.object({
        enabled: z.boolean(),
        expiresAt: z.coerce
          .date()
          .refine(
            d => d.getTime() > Date.now(),
            'expiresAt must be in the future / يجب أن يكون تاريخ الانتهاء في المستقبل'
          )
          .nullable()
          .optional(),
        reason: z.string().trim().max(200).nullable().optional(),
      });
      const bodyParsed = bodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: bodyParsed.error.issues[0]?.message ?? 'Invalid request body',
          },
        });
        return;
      }
      const meta: { expiresAt?: Date | null; reason?: string | null } = {};
      if (bodyParsed.data.expiresAt !== undefined) meta.expiresAt = bodyParsed.data.expiresAt;
      if (bodyParsed.data.reason !== undefined) meta.reason = bodyParsed.data.reason || null;

      const features = await featureService.setFeature(
        id,
        keyParsed.data,
        bodyParsed.data.enabled,
        req.user!.userId,
        meta
      );

      await auditLog({
        action: 'store.feature_toggled',
        userId: req.user!.userId,
        storeId: id,
        resourceType: 'store_feature',
        resourceId: keyParsed.data,
        details: {
          featureKey: keyParsed.data,
          enabled: bodyParsed.data.enabled,
          expiresAt: meta.expiresAt,
          reason: meta.reason,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

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
 * DELETE /admin/stores/:id/features/:featureKey
 * Clear a single feature override so it falls back to PLAN_BASELINE.
 * Idempotent — returns success even if no override existed.
 */
router.delete(
  '/stores/:id/features/:featureKey',
  authenticate,
  requireMfaEnrolled,
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

      const features = await featureService.clearFeatureOverride(id, keyParsed.data);

      await auditLog({
        action: 'store.feature_override_cleared',
        userId: req.user!.userId,
        storeId: id,
        resourceType: 'store_feature',
        resourceId: keyParsed.data,
        details: { featureKey: keyParsed.data, reason: 'fell_back_to_plan_baseline' },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

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
 * DELETE /admin/stores/:id/features
 * Reset ALL feature overrides for a store back to PLAN_BASELINE.
 * Super-admin nuclear button — used by the "Reset to plan defaults"
 * action on the Manage Features page.
 */
router.delete(
  '/stores/:id/features',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const features = await featureService.resetAllOverrides(req.params.id);

      await auditLog({
        action: 'store.features_reset_to_baseline',
        userId: req.user!.userId,
        storeId: req.params.id,
        resourceType: 'store',
        resourceId: req.params.id,
        details: { reason: 'super_admin_reset_all_overrides' },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

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
 * PUT /admin/stores/:id/plan
 * Change the store's plan. Per the 2026-05-27 architectural decision,
 * this does NOT touch StoreFeature override rows — every existing
 * override is preserved across upgrade and downgrade.
 *
 * Body: { plan: 'free' | 'starter' | 'professional' | 'enterprise' }
 */
router.put(
  '/stores/:id/plan',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bodySchema = z.object({
        plan: z.enum(['free', 'starter', 'professional', 'enterprise']),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'Invalid plan',
          },
        });
        return;
      }

      // Capture previous plan so the audit row shows from → to.
      const prev = await withStore(req.params.id, async () =>
        (await storeDb(req.params.id)).store.findUnique({
          where: { id: req.params.id },
          select: { plan: true },
        })
      );

      const features = await featureService.setStorePlan(
        req.params.id,
        parsed.data.plan,
        req.user!.userId
      );

      await auditLog({
        action: 'store.plan_changed',
        userId: req.user!.userId,
        storeId: req.params.id,
        resourceType: 'store',
        resourceId: req.params.id,
        details: { fromPlan: prev?.plan ?? null, toPlan: parsed.data.plan },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { plan: parsed.data.plan, features },
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
  requireMfaEnrolled,
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
