import { Router, Request, Response, NextFunction } from 'express';
import { analyticsRead } from '../lib/analytics-backend';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import { FeatureKey } from '@ebda/shared';
import { requireRecentLogin } from '../middleware/require-mfa';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { refuseDemoStore } from '../middleware/demo-store';
import { featureService } from '../services/feature.service';
import { notificationConfigService } from '../services/notification-config.service';
import { pushService } from '../services/push.service';
import logger from '../lib/logger';
import { eventConfigShape, mergeEventFlags } from '../lib/notification-event-flags';

// TWO routers, deliberately (#1993): the admin half is mounted ONLY at the
// bare '/stores' prefix; `publicRouter` is the only thing mounted at
// '/public'. Do NOT collapse them back into one router mounted at both —
// `csrfProtection` skips '/public/' paths and `restrictPlatformOnlyOrigins`
// only covers '/api/v1/stores', so an admin route republished under '/public'
// becomes a CSRF-free, credentialed cross-origin target for any
// merchant-registered custom domain. Full reasoning: loyalty.routes.ts header.
// Guarded by tests/unit/public-mount-admin-route-guard.test.ts.
const router = Router();
const publicRouter = Router();

// The generic `:channel` param route can't take a single `requireFeature(key)`
// at the middleware layer (channel isn't known until the request lands), so
// the gate is resolved per-channel inside the handler instead. Any unlisted
// channel is not plan-gated here — only the channels below need a check.
// `whatsapp` (Business API) is flagged OFF for every store (WHATSAPP-OFF-1).
// Mirrors requireFeature's fail-closed 403 FEATURE_DISABLED shape + super_admin
// bypass.
const GATED_CHANNEL_FEATURES: Partial<Record<string, FeatureKey>> = {
  whatsapp: 'whatsapp',
  sms: 'sms',
  push: 'push_notifications',
};

async function assertChannelFeatureEnabled(
  req: Request,
  res: Response,
  storeId: string,
  channel: string
): Promise<boolean> {
  const featureKey = GATED_CHANNEL_FEATURES[channel];
  if (!featureKey) return true;

  // Super-admin bypass — matches requireFeature's platform-staff exemption.
  if (req.user?.role === 'super_admin') return true;

  const enabled = await featureService.isFeatureEnabled(storeId, featureKey);
  if (!enabled) {
    res.status(403).json({
      success: false,
      error: 'Feature not available',
      code: 'FEATURE_DISABLED',
      feature: featureKey,
    });
    return false;
  }
  return true;
}

// ==========================================
// Validation schemas
// ==========================================

const upsertConfigSchema = z.object({
  provider: z.string().min(1),
  credentials: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
});

// Accepts either `push` (canonical) or `push_notifications` (the channel
// key the admin UI uses internally) so the contract is forgiving — drift
// between admin and API field names is what produced the 400s the
// merchant saw on every save before this fix.
// Single-event payload (legacy). Bulk payload `{ events: [...] }` is
// preferred — see the route below — and is what the admin actually sends.
const upsertEventConfigSchema = eventConfigShape;
const bulkEventConfigSchema = z.object({
  events: z.array(eventConfigShape).min(1).max(50),
});

const logsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  channel: z.string().optional(),
  event: z.string().optional(),
  status: z.string().optional(),
});

const pushSubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  deviceInfo: z.string().optional(),
});

const pushUnsubscribeSchema = z.object({
  endpoint: z.string().min(1),
});

// ==========================================
// Admin middleware chain shorthand
// ==========================================
const adminMiddleware = [authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess];

// ==========================================
// GET /:storeId/notifications/configs
// List all channel configs (credentials masked)
// ==========================================
router.get(
  '/:storeId/notifications/configs',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const configs = await notificationConfigService.getStoreConfigs(storeId);

      // Mask credentials for all channels
      const masked = Object.fromEntries(
        Object.entries(configs).map(([channel, config]) => [
          channel,
          {
            ...config,
            credentials: notificationConfigService.maskCredentials(config.credentials),
          },
        ])
      );

      res.json({ success: true, data: { configs: masked } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /:storeId/notifications/configs/:channel
// Get single channel config (masked)
// ==========================================
router.get(
  '/:storeId/notifications/configs/:channel',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, channel } = req.params;
      const config = await notificationConfigService.getConfig(storeId, channel);

      if (!config) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `No config found for channel: ${channel}` },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          config: {
            ...config,
            credentials: notificationConfigService.maskCredentials(config.credentials),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// PUT /:storeId/notifications/configs/:channel
// Upsert channel credentials
// ==========================================
router.put(
  '/:storeId/notifications/configs/:channel',
  ...adminMiddleware,
  rejectImpersonated, // TEN-3: provider credentials are the owner's own
  requireRecentLogin, // TEN-4: credential-class change needs a recent sign-in
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, channel } = req.params;
      // sms is Enterprise-only, push_notifications is Professional+. Without
      // this gate a lower-tier merchant could save real third-party
      // credentials (e.g. Unifonic) before ever paying for the channel.
      if (!(await assertChannelFeatureEnabled(req, res, storeId, channel))) return;
      const data = upsertConfigSchema.parse(req.body);

      const config = await notificationConfigService.upsertConfig(storeId, channel, data);

      res.json({
        success: true,
        data: {
          config: {
            ...config,
            credentials: notificationConfigService.maskCredentials(config.credentials),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// DELETE /:storeId/notifications/configs/:channel
// Remove channel config
// ==========================================
router.delete(
  '/:storeId/notifications/configs/:channel',
  ...adminMiddleware,
  rejectImpersonated, // TEN-3: provider credentials are the owner's own
  requireRecentLogin, // TEN-4: credential-class change needs a recent sign-in
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, channel } = req.params;
      await notificationConfigService.deleteConfig(storeId, channel);

      res.json({ success: true, data: { message: 'Channel config deleted successfully' } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// POST /:storeId/notifications/test/:channel
// Test channel connection
// ==========================================
router.post(
  '/:storeId/notifications/test/:channel',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, channel } = req.params;
      // Same gate as the config save route — test-connection round-trips a
      // live call to the third-party provider (e.g. Unifonic Account/info),
      // which is itself a paid-feature capability.
      if (!(await assertChannelFeatureEnabled(req, res, storeId, channel))) return;
      const result = await notificationConfigService.testConnection(storeId, channel);

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /:storeId/notifications/events
// Get event configs
// ==========================================
router.get(
  '/:storeId/notifications/events',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const events = await notificationConfigService.getEventConfigs(storeId);

      res.json({ success: true, data: { events } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// PUT /:storeId/notifications/events
// Update event configs
// ==========================================
router.put(
  '/:storeId/notifications/events',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      // Accept BOTH shapes:
      //   1. Bulk:   `{ events: [{event, whatsapp, sms, push|push_notifications}, ...] }`
      //              (what the admin actually sends from the events table)
      //   2. Single: `{ event, whatsapp, sms, push|push_notifications }`
      //              (kept so older clients keep working)
      const body = req.body as Record<string, unknown> | undefined;
      const isBulk = body && Array.isArray((body as Record<string, unknown>).events);

      if (isBulk) {
        const { events } = bulkEventConfigSchema.parse(req.body);
        const results: Array<{ event: string; whatsapp: boolean; sms: boolean; push: boolean }> =
          [];
        const stored = await notificationConfigService.getEventConfigs(storeId);
        for (const e of events) {
          const updated = await notificationConfigService.upsertEventConfig(
            storeId,
            e.event,
            mergeEventFlags(stored, e)
          );
          results.push({ event: e.event, ...updated });
        }
        res.json({ success: true, data: { events: results } });
        return;
      }

      const parsed = upsertEventConfigSchema.parse(req.body);
      const { event } = parsed;
      const updated = await notificationConfigService.upsertEventConfig(
        storeId,
        event,
        mergeEventFlags(await notificationConfigService.getEventConfigs(storeId), parsed)
      );
      res.json({ success: true, data: { event, ...updated } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /:storeId/notifications/logs
// Paginated notification logs
// ==========================================
router.get(
  '/:storeId/notifications/logs',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, channel, event, status } = logsQuerySchema.parse(req.query);

      const where = {
        storeId,
        ...(channel ? { channel } : {}),
        ...(event ? { event } : {}),
        ...(status ? { status } : {}),
      };

      const listArgs = {
        where,
        orderBy: { createdAt: 'desc' as const },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          channel: true,
          event: true,
          status: true,
          providerMessageId: true,
          error: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
      };
      // Ruling NZ-AN-1: a Durable Object store's log lives in its DO once its analytics moved
      const [total, logs] = await analyticsRead(
        storeId,
        async r =>
          Promise.all([r.notificationLog.count({ where }), r.notificationLog.findMany(listArgs)]),
        async () =>
          Promise.all([
            prisma.notificationLog.count({ where }),
            prisma.notificationLog.findMany(listArgs),
          ])
      );

      res.json({
        success: true,
        data: {
          logs,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /:storeId/notifications/stats
// Notification statistics (counts by channel, status)
// ==========================================
router.get(
  '/:storeId/notifications/stats',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      // Group by channel + status for a breakdown
      const statArgs = {
        by: ['channel', 'status'] as ('channel' | 'status')[],
        where: { storeId },
        _count: { id: true as const },
      };
      const [groups, total] = await analyticsRead(
        storeId,
        async r =>
          Promise.all([
            r.notificationLog.groupBy(statArgs),
            r.notificationLog.count({ where: { storeId } }),
          ]),
        async () =>
          Promise.all([
            prisma.notificationLog.groupBy(statArgs),
            prisma.notificationLog.count({ where: { storeId } }),
          ])
      );

      // Build a nested map: { channel: { status: count } }
      const stats: Record<string, Record<string, number>> = {};
      for (const row of groups) {
        if (!stats[row.channel]) stats[row.channel] = {};
        stats[row.channel][row.status] = row._count.id;
      }

      res.json({ success: true, data: { stats, total } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Public Routes — NO auth required (publicRouter, mounted ONLY at '/public')
// ==========================================

// POST /public/:storeId/push/subscribe
// Register a push subscription (anonymous users can subscribe).
// Paths carry no extra '/public' prefix: publicRouter is mounted at '/public',
// so the full URL resolves to /public/:storeId/push/subscribe — matching what
// the storefront sends.
publicRouter.post(
  '/:storeId/push/subscribe',
  refuseDemoStore,
  requireFeature('push_notifications'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { endpoint, keys, deviceInfo } = pushSubscribeSchema.parse(req.body);

      // Optionally bind to a logged-in customer if token is present
      const customerId = (req as Request & { user?: { id: string } }).user?.id ?? undefined;

      await pushService.subscribe(
        storeId,
        {
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          deviceInfo,
        },
        customerId
      );

      logger.info({ storeId }, '[notification.routes] Push subscription registered');

      res.status(201).json({ success: true, data: { message: 'Subscribed successfully' } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /public/:storeId/push/unsubscribe
// Remove a push subscription
publicRouter.post(
  '/:storeId/push/unsubscribe',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { endpoint } = pushUnsubscribeSchema.parse(req.body);

      await pushService.unsubscribe(endpoint);

      logger.info({ endpoint }, '[notification.routes] Push subscription removed');

      res.json({ success: true, data: { message: 'Unsubscribed successfully' } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Orders-PWA staff push routes — AUTHENTICATED (staff/admin only)
//
// Distinct from the public storefront push routes above. These register the
// staff member's device against the `orders_app` audience so the order-created
// Inngest fanout can ping the Orders PWA without ever touching shopper
// subscriptions. Role + store-access gated (adminMiddleware): only a user who
// can actually see the store's orders may subscribe a device to its order
// pushes. Mounted at /stores → /stores/:storeId/orders-app/push/subscribe.
// ==========================================
router.post(
  '/:storeId/orders-app/push/subscribe',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { endpoint, keys, deviceInfo } = pushSubscribeSchema.parse(req.body);

      // The authenticated staff user's id — non-null here because `authenticate`
      // ran in the chain. Binds the device to the staff member so a later
      // offboarding / token revocation can prune their devices.
      const customerId = (req as Request & { user?: { id: string } }).user?.id ?? undefined;

      await pushService.subscribe(
        storeId,
        { endpoint, p256dh: keys.p256dh, auth: keys.auth, deviceInfo },
        customerId,
        'orders_app'
      );

      logger.info(
        { storeId, customerId },
        '[notification.routes] Orders-app push subscription registered'
      );

      res.status(201).json({ success: true, data: { message: 'Subscribed successfully' } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:storeId/orders-app/push/unsubscribe',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { endpoint } = pushUnsubscribeSchema.parse(req.body);

      await pushService.unsubscribe(endpoint);

      logger.info({ endpoint }, '[notification.routes] Orders-app push subscription removed');

      res.json({ success: true, data: { message: 'Unsubscribed successfully' } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

// Storefront-only router, mounted at '/public' in routes/index.ts.
export { publicRouter as publicNotificationRoutes };
