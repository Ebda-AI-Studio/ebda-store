import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { notificationConfigService } from '../services/notification-config.service';
import { pushService } from '../services/push.service';
import logger from '../lib/logger';

const router = Router();

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
const eventConfigShape = z
  .object({
    event: z.string().min(1),
    whatsapp: z.boolean(),
    sms: z.boolean(),
    push: z.boolean().optional(),
    push_notifications: z.boolean().optional(),
  })
  .transform(v => ({
    event: v.event,
    whatsapp: v.whatsapp,
    sms: v.sms,
    // `push` wins when both are sent; defaults to false so a missing
    // field doesn't accidentally enable a channel.
    push: typeof v.push === 'boolean' ? v.push : (v.push_notifications ?? false),
  }));

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, channel } = req.params;
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
        for (const e of events) {
          const updated = await notificationConfigService.upsertEventConfig(storeId, e.event, {
            whatsapp: e.whatsapp,
            sms: e.sms,
            push: e.push,
          });
          results.push({ event: e.event, ...updated });
        }
        res.json({ success: true, data: { events: results } });
        return;
      }

      const { event, whatsapp, sms, push } = upsertEventConfigSchema.parse(req.body);
      const updated = await notificationConfigService.upsertEventConfig(storeId, event, {
        whatsapp,
        sms,
        push,
      });
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

      const [total, logs] = await Promise.all([
        prisma.notificationLog.count({ where }),
        prisma.notificationLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
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
        }),
      ]);

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
      const groups = await prisma.notificationLog.groupBy({
        by: ['channel', 'status'],
        where: { storeId },
        _count: { id: true },
      });

      // Build a nested map: { channel: { status: count } }
      const stats: Record<string, Record<string, number>> = {};
      for (const row of groups) {
        if (!stats[row.channel]) stats[row.channel] = {};
        stats[row.channel][row.status] = row._count.id;
      }

      const total = await prisma.notificationLog.count({ where: { storeId } });

      res.json({ success: true, data: { stats, total } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Public Routes — NO auth required
// ==========================================

// POST /public/:storeId/push/subscribe
// Register a push subscription (anonymous users can subscribe)
router.post(
  '/public/:storeId/push/subscribe',
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
router.post(
  '/public/:storeId/push/unsubscribe',
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

export default router;
