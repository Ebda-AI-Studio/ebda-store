/**
 * OneSignal subscription management for admin push notifications.
 * Mounted under /admin so only authenticated admins can subscribe their devices.
 *
 * Public app id endpoint is included so the admin frontend can pick the
 * configured OneSignal app id without being baked into the build (if you
 * rotate the app, no rebuild required).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { OneSignalService } from '../services/onesignal.service';
import { config } from '../config';
import { auditLog } from '../middleware/security';
import { pushService } from '../services/push.service';

const router = Router();

const subscribeSchema = z.object({
  playerId: z.string().min(1),
  deviceLabel: z.string().max(120).optional(),
});

const broadcastSchema = z.object({
  titleEn: z.string().trim().min(1).max(200),
  titleAr: z.string().trim().min(1).max(200),
  bodyEn: z.string().trim().min(1).max(2000),
  bodyAr: z.string().trim().min(1).max(2000),
  // OneSignal accepts any URL but we validate to keep typos out and surface
  // a clean 422 rather than a downstream OneSignal error.
  // BE:S-17: https only. `z.string().url()` accepts `javascript:` / `data:` / `http:`, which a push tap would open.
  url: z
    .string()
    .url()
    .max(2000)
    .refine(v => /^https:\/\//i.test(v), { message: 'url must start with https://' })
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

/**
 * GET /admin/notifications/onesignal/config
 * Returns the public OneSignal app id so the admin frontend can initialize
 * the SDK without bundling the value at build time.
 */
router.get('/notifications/onesignal/config', authenticate, (_req: Request, res: Response) => {
  // The admin frontend lives at https://store.ebda.app which is a
  // different origin from the storefront. OneSignal apps are locked to
  // a single chrome_web_origin so we use a dedicated app for admin push
  // (configured via ONESIGNAL_ADMIN_APP_ID). Falls back to the
  // storefront app id when the admin-specific env var isn't set —
  // pushes will subscribe but the SDK will throw an "origin mismatch"
  // error because the storefront app's origin doesn't match
  // store.ebda.app.
  res.json({
    success: true,
    data: {
      appId: config.onesignalAdminAppId,
      enabled: !!(config.onesignalAdminAppId && config.onesignalAdminRestApiKey),
    },
  });
});

/**
 * POST /admin/notifications/onesignal/subscribe
 * Persist a OneSignal player id for the authenticated user. Idempotent.
 */
router.post(
  '/notifications/onesignal/subscribe',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { playerId, deviceLabel } = subscribeSchema.parse(req.body);
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED' } });
        return;
      }
      await OneSignalService.upsertSubscription(userId, playerId, deviceLabel);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/notifications/onesignal/devices
 * List the authenticated user's registered devices for self-management.
 */
router.get(
  '/notifications/onesignal/devices',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED' } });
        return;
      }
      const devices = await OneSignalService.listSubscriptions(userId);
      res.json({ success: true, data: { devices } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /admin/notifications/onesignal/devices/:playerId
 * Revoke a single device. The OneSignal SDK on that browser also disposes
 * the subscription on next session start; the DB delete here is the
 * authoritative server-side record.
 */
router.delete(
  '/notifications/onesignal/devices/:playerId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED' } });
        return;
      }
      await OneSignalService.deleteSubscription(userId, req.params.playerId);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// Storefront broadcast endpoints
//
// These let a store admin push a one-off notification to every storefront
// device that consented to push for THIS store. The per-store filter is
// applied server-side (pushService.sendToStore) — never trust a
// `storeId` in the body, always read it from req.params + requireStoreAccess.
// ──────────────────────────────────────────────────────────────────────────

const adminStoreMiddleware = [
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // Marketing push broadcast is a Professional-tier feature. Without this gate
  // the admin blast path (pushService.sendToStore) sends real push
  // to every storefront subscriber on ANY plan — a billing leak. Matches the
  // customer subscribe route's requireFeature('push_notifications').
  // super_admin bypasses inside requireFeature.
  requireFeature('push_notifications'),
];

/**
 * GET /admin/stores/:storeId/push/status
 * One plain answer for the merchant page: can this store send push right now, and to how many devices.
 * `available` is false when the platform keys are not installed (our side, never the merchant's).
 */
router.get(
  '/stores/:storeId/push/status',
  ...adminStoreMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const available = pushService.isConfigured();
      const subscribers = available ? await pushService.getSubscriberCount(storeId) : 0;
      res.json({ success: true, data: { available, subscribers } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /admin/stores/:storeId/push/broadcast
 * Native Web Push (VAPID) to every storefront device subscribed for THIS store. The store id comes from the path
 * (requireStoreAccess), never the body. The ar + en copy rides in `data.i18n`; the storefront worker shows the one that
 * matches the shopper's browser language.
 */
router.post(
  '/stores/:storeId/push/broadcast',
  ...adminStoreMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const parsed = broadcastSchema.parse(req.body);

      if (!pushService.isConfigured()) {
        res.status(503).json({
          success: false,
          error: {
            code: 'PUSH_NOT_CONFIGURED',
            message: 'Push notifications are not available yet.',
          },
        });
        return;
      }

      const result = await pushService.broadcastToStore(storeId, parsed);

      if (result.skipped === 'channel_disabled') {
        res.status(409).json({
          success: false,
          error: {
            code: 'PUSH_CHANNEL_DISABLED',
            message: 'Turn on push notifications for this store first.',
          },
        });
        return;
      }

      await auditLog({
        action: 'push.broadcast.sent',
        userId: req.user!.userId,
        storeId,
        resourceType: 'store',
        resourceId: storeId,
        // the copy itself is merchant content and can be long: record sizes and the target only
        details: { titleLength: parsed.titleEn.length, hasUrl: Boolean(parsed.url) },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { id: `${Date.now()}`, recipients: result.recipients, delivered: result.delivered },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/stores/:storeId/push/broadcasts
 * Last 10 broadcasts for this store, from the notification log (delivered / failed per send).
 */
router.get(
  '/stores/:storeId/push/broadcasts',
  ...adminStoreMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const broadcasts = await pushService.listRecentBroadcasts(storeId, 10);
      res.json({ success: true, data: { broadcasts } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
