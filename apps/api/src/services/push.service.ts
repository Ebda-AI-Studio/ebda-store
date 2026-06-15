/**
 * Push Notification Service
 * Standards-based Web Push (W3C Push API / RFC 8030) via the `web-push` library.
 *
 * VAPID keys are platform-wide (not per-store) and configured via env vars
 * (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT).
 */

import webpush from 'web-push';
import { prisma, withRlsBypass } from '@force/database';
import logger from '../lib/logger';
import { config } from '../config';
import { notificationConfigService } from './notification-config.service';

// ==========================================
// VAPID initialization (one-time, at module load)
// ==========================================

let vapidConfigured = false;
let vapidWarnLogged = false;

if (config.vapidPublicKey && config.vapidPrivateKey) {
  try {
    webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
    vapidConfigured = true;
  } catch (err) {
    logger.error({ err }, '[PushService] Failed to set VAPID details');
  }
} else {
  logger.warn(
    '[PushService] VAPID keys not configured — push notifications will be disabled. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.'
  );
  vapidWarnLogged = true;
}

// ==========================================
// Push Service
// ==========================================

class PushService {
  /**
   * Send a web-push notification to all subscribed devices for a store.
   * Cleans up expired (410 Gone / 404) subscriptions automatically.
   * Logs the result to NotificationLog.
   */
  async sendToStore(
    storeId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    // 1. VAPID must be configured platform-wide
    if (!vapidConfigured) {
      if (!vapidWarnLogged) {
        logger.warn('[PushService] VAPID keys not configured, skipping push send');
        vapidWarnLogged = true;
      }
      return;
    }

    // 2. Check the store's push channel is enabled (ignore credentials — VAPID is platform-wide)
    const channelConfig = await notificationConfigService.getConfig(storeId, 'push');
    if (!channelConfig || !channelConfig.enabled) {
      logger.debug(
        { storeId },
        '[PushService] Push channel not found or disabled, skipping sendToStore'
      );
      return;
    }

    // 3. Get all push subscriptions for this store.
    // push_subscriptions is under FORCE ROW LEVEL SECURITY. sendToStore is
    // called from background fan-out (order-created / abandoned-cart Inngest
    // jobs) with NO tenant GUC, where the policy would return 0 rows → "no
    // subscriptions, skipping" → storefront order push silently broken. Trusted
    // internal read already scoped by `where: { storeId }`, so use withRlsBypass.
    // Only the DB read is wrapped — the webpush network sends below stay OUTSIDE
    // any transaction so we never hold a Neon connection open across HTTP I/O.
    const subscriptions = await withRlsBypass(tx =>
      tx.pushSubscription.findMany({
        where: { storeId },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      })
    );

    if (subscriptions.length === 0) {
      logger.debug({ storeId }, '[PushService] No push subscriptions for store, skipping');
      return;
    }

    // 4. Build payload
    const payload = JSON.stringify({ title, body, data: data ?? {} });

    // 5. Send in parallel via Promise.allSettled
    const results = await Promise.allSettled(
      subscriptions.map(sub =>
        webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload
        )
      )
    );

    // 6. Tally results and collect expired endpoints (410 Gone / 404 Not Found)
    let successCount = 0;
    let failureCount = 0;
    const expiredEndpoints: string[] = [];

    results.forEach((result, idx) => {
      const sub = subscriptions[idx];
      if (result.status === 'fulfilled') {
        successCount += 1;
        return;
      }

      failureCount += 1;
      const err = result.reason as { statusCode?: number; body?: string; message?: string };
      const statusCode = err?.statusCode;

      if (statusCode === 410 || statusCode === 404) {
        expiredEndpoints.push(sub.endpoint);
      } else {
        logger.warn(
          { storeId, statusCode, endpoint: sub.endpoint, err: err?.message ?? err },
          '[PushService] Web push delivery failed'
        );
      }
    });

    // 7. Clean up expired subscriptions (RLS-bypass: same FORCE-RLS table, called
    // from non-tenant-context fan-out — without bypass the delete would match 0 rows).
    if (expiredEndpoints.length > 0) {
      await withRlsBypass(tx =>
        tx.pushSubscription.deleteMany({
          where: { storeId, endpoint: { in: expiredEndpoints } },
        })
      ).catch(err =>
        logger.warn({ err, storeId }, '[PushService] Failed to clean up expired push subscriptions')
      );

      logger.info(
        { storeId, count: expiredEndpoints.length },
        '[PushService] Cleaned up expired push subscriptions'
      );
    }

    // 8. Log result — shape matches previous FCM implementation so the admin notifications page still works
    const status = successCount > 0 ? 'sent' : 'failed';

    // notification_logs is under FORCE-RLS too — bypass so the write succeeds
    // from non-tenant-context fan-out.
    await withRlsBypass(tx =>
      tx.notificationLog.create({
        data: {
          storeId,
          channel: 'push',
          event: 'push_send',
          status,
          metadata: {
            title,
            tokenCount: subscriptions.length,
            successCount,
            failureCount,
          },
        },
      })
    ).catch(err => logger.error({ err }, '[PushService] Failed to write NotificationLog'));

    logger.info(
      { storeId, successCount, failureCount, title },
      '[PushService] Web push notification sent'
    );
  }

  /**
   * Subscribe a device to push notifications for a store.
   * Upserts on (storeId, endpoint) — idempotent.
   */
  async subscribe(
    storeId: string,
    subscription: {
      endpoint: string;
      p256dh: string;
      auth: string;
      deviceInfo?: string;
    },
    customerId?: string
  ): Promise<void> {
    await prisma.pushSubscription.upsert({
      where: { storeId_endpoint: { storeId, endpoint: subscription.endpoint } },
      create: {
        storeId,
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        deviceInfo: subscription.deviceInfo,
        customerId: customerId ?? null,
      },
      update: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        deviceInfo: subscription.deviceInfo,
        customerId: customerId ?? null,
      },
    });

    logger.info({ storeId, customerId }, '[PushService] Push subscription upserted');
  }

  /**
   * Unsubscribe a device by its endpoint.
   */
  async unsubscribe(endpoint: string): Promise<void> {
    await prisma.pushSubscription.deleteMany({ where: { endpoint } });
    logger.info({ endpoint }, '[PushService] Push subscription removed');
  }

  /**
   * Count active push subscriptions for a store.
   */
  async getSubscriberCount(storeId: string): Promise<number> {
    return prisma.pushSubscription.count({ where: { storeId } });
  }
}

// Singleton instance
export const pushService = new PushService();
