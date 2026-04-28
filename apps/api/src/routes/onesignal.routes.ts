/**
 * OneSignal subscription management for admin push notifications.
 * Mounted under /admin so only authenticated admins can subscribe their devices.
 *
 * Public app id endpoint is included so the admin frontend can pick the
 * configured OneSignal app id without being baked into the build (if you
 * rotate the app, no rebuild required).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import {
  OneSignalService,
  OneSignalNotConfiguredError,
  OneSignalRequestError,
} from '../services/onesignal.service';
import { config } from '../config';

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
  url: z
    .string()
    .url()
    .max(2000)
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

/**
 * GET /admin/notifications/onesignal/config
 * Returns the public OneSignal app id so the admin frontend can initialize
 * the SDK without bundling the value at build time.
 */
router.get('/notifications/onesignal/config', authenticate, (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      appId: config.onesignalAppId,
      enabled: !!(config.onesignalAppId && config.onesignalRestApiKey),
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
// applied server-side in OneSignalService.broadcastToStore — never trust a
// `storeId` in the body, always read it from req.params + requireStoreAccess.
// ──────────────────────────────────────────────────────────────────────────

const adminStoreMiddleware = [
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
];

/**
 * POST /admin/stores/:storeId/push/broadcast
 * Send a tenant-scoped push to every storefront subscriber tagged with
 * `storeId = :storeId`.
 */
router.post(
  '/stores/:storeId/push/broadcast',
  ...adminStoreMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const parsed = broadcastSchema.parse(req.body);

      const result = await OneSignalService.broadcastToStore({
        storeId,
        titleEn: parsed.titleEn,
        titleAr: parsed.titleAr,
        bodyEn: parsed.bodyEn,
        bodyAr: parsed.bodyAr,
        url: parsed.url,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof OneSignalNotConfiguredError) {
        res.status(503).json({
          success: false,
          error: {
            code: 'PUSH_NOT_CONFIGURED',
            message:
              'OneSignal is not configured on the server. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY in the API environment.',
          },
        });
        return;
      }
      if (error instanceof OneSignalRequestError) {
        res.status(502).json({
          success: false,
          error: {
            code: 'PUSH_PROVIDER_ERROR',
            message: `OneSignal returned ${error.status}: ${error.body || 'unknown error'}`,
          },
        });
        return;
      }
      next(error);
    }
  }
);

/**
 * GET /admin/stores/:storeId/push/broadcasts
 * Last 10 broadcasts that targeted this store, with delivery + click counts
 * pulled from OneSignal. Used by the admin notifications page to render an
 * audit-style list.
 */
router.get(
  '/stores/:storeId/push/broadcasts',
  ...adminStoreMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const broadcasts = await OneSignalService.listRecentBroadcasts(storeId, 10);
      res.json({ success: true, data: { broadcasts } });
    } catch (error) {
      if (error instanceof OneSignalNotConfiguredError) {
        res.status(503).json({
          success: false,
          error: {
            code: 'PUSH_NOT_CONFIGURED',
            message:
              'OneSignal is not configured on the server. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY in the API environment.',
          },
        });
        return;
      }
      if (error instanceof OneSignalRequestError) {
        res.status(502).json({
          success: false,
          error: {
            code: 'PUSH_PROVIDER_ERROR',
            message: `OneSignal returned ${error.status}: ${error.body || 'unknown error'}`,
          },
        });
        return;
      }
      next(error);
    }
  }
);

export default router;
