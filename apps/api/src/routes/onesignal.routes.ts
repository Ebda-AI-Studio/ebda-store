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
import { authenticate } from '../middleware/auth';
import { OneSignalService } from '../services/onesignal.service';
import { config } from '../config';

const router = Router();

const subscribeSchema = z.object({
  playerId: z.string().min(1),
  deviceLabel: z.string().max(120).optional(),
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

export default router;
