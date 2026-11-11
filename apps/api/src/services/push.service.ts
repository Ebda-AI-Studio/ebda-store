/**
 * Push Notification Service
 * Standards-based Web Push (W3C Push API / RFC 8030) via the `web-push` library.
 *
 * VAPID keys are platform-wide (not per-store) and configured via env vars
 * (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT).
 */

import { analyticsWrite } from '../lib/analytics-backend';
import webpush from 'web-push';
import { currentStoreId, prisma, withStore, runInTenantContext } from '@ebda/database';
import logger from '../lib/logger';
import { config } from '../config';
import { notificationConfigService } from './notification-config.service';
import { withStoreRw } from '../lib/jobs/store-db';

/**
 * Push audiences. A single store can fan out to two distinct device sets:
 *  - 'storefront' → shopper devices (the storefront subscribe flow)
 *  - 'orders_app' → staff/admin devices running the Orders PWA
 * The tag lives on `push_subscriptions.audience` (defaulted to 'storefront'
 * so every legacy row keeps working).
 */
export type PushAudience = 'storefront' | 'orders_app';

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
    // internal read already scoped by `where: { storeId }`, so it enters the store scope with withStore.
    // Only the DB read is wrapped — the webpush network sends below stay OUTSIDE
    // any transaction so we never hold a Neon connection open across HTTP I/O.
    // `withStoreRw`: a store on its Durable Object reads (and deletes, below) `push_subscriptions` from its DO; the `prisma`
    // proxy threw PostgresRemovedError there on the Worker, so every dispatched push failed (Ruling NZ-D23).
    const subscriptions = await withStoreRw(storeId, tx =>
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
      await withStoreRw(storeId, tx =>
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
    const pushLog = {
      storeId,
      channel: 'push',
      event: 'push_send',
      status,
      metadata: { title, tokenCount: subscriptions.length, successCount, failureCount },
    };
    await analyticsWrite(
      storeId,
      w => w.notificationLog.create({ data: pushLog }),
      () => withStore(storeId, tx => tx.notificationLog.create({ data: pushLog }))
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
    customerId?: string,
    audience: PushAudience = 'storefront'
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
        audience,
      },
      update: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        deviceInfo: subscription.deviceInfo,
        customerId: customerId ?? null,
        // Re-tag on re-subscribe so a device that switched apps lands in the
        // right audience (the unique key is (storeId, endpoint), shared across
        // surfaces — but in practice each surface registers a distinct endpoint).
        audience,
      },
    });

    logger.info({ storeId, customerId, audience }, '[PushService] Push subscription upserted');
  }

  /**
   * Send a web-push notification to the Orders-PWA staff devices of a store.
   *
   * Differs from `sendToStore` in three ways:
   *  1. Targets ONLY `audience = 'orders_app'` subscriptions — staff devices
   *     that subscribed through the role-gated Orders-PWA route. Never touches
   *     shopper (`storefront`) subscriptions, so it can't double-send with the
   *     storefront push.
   *  2. Runs the subscription read inside `withStoreRw` (the DO, or a tenant-scoped Postgres read) because callers
   *     are Inngest jobs that run OUTSIDE the HTTP tenant-context middleware —
   *     `push_subscriptions` is FORCE-RLS, so without the GUC the read returns
   *     0 rows and the push silently no-ops.
   *  3. Gates on the store's `order_confirmed` push EVENT opt-in (per-store)
   *     rather than the channel-credentials check — VAPID is platform-wide and
   *     needs no per-store credentials.
   *
   * Idempotency: the SAME `data.tag` is used for a given order, so if the
   * Inngest step retries, the OS/browser collapses duplicate notifications for
   * the same tag rather than stacking N copies.
   */
  async sendToOrdersAppStaff(
    storeId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    if (!vapidConfigured) {
      if (!vapidWarnLogged) {
        logger.warn('[PushService] VAPID keys not configured, skipping orders-app push send');
        vapidWarnLogged = true;
      }
      return;
    }

    // Per-store opt-in: only fan out when the merchant has the push channel
    // enabled AND the order_confirmed event has push turned on. Absent config
    // = default ON for the orders-app (staff want new-order pings by default),
    // mirroring how the in-app NewOrderWatcher always alerts.
    const [channelConfig, eventConfigs] = await Promise.all([
      notificationConfigService.getConfig(storeId, 'push'),
      notificationConfigService.getEventConfigs(storeId),
    ]);
    if (channelConfig && channelConfig.enabled === false) {
      logger.debug({ storeId }, '[PushService] Push channel disabled, skipping orders-app push');
      return;
    }
    const eventOptIn = eventConfigs['order_confirmed'];
    if (eventOptIn && eventOptIn.push === false) {
      logger.debug(
        { storeId },
        '[PushService] order_confirmed push opted out, skipping orders-app push'
      );
      return;
    }

    // FORCE-RLS read — set the tenant GUC explicitly (Inngest has no middleware).
    // `withStoreRw`: the store's DO on the Worker (no Postgres), the tenant-scoped Postgres read otherwise (same as send()).
    const subscriptions = await withStoreRw(storeId, tx =>
      tx.pushSubscription.findMany({
        where: { storeId, audience: 'orders_app' },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      })
    );

    if (subscriptions.length === 0) {
      logger.debug({ storeId }, '[PushService] No orders-app push subscriptions, skipping');
      return;
    }

    const payload = JSON.stringify({ title, body, data: data ?? {} });

    const results = await Promise.allSettled(
      subscriptions.map(sub =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        )
      )
    );

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
      const err = result.reason as { statusCode?: number; message?: string };
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        expiredEndpoints.push(sub.endpoint);
      } else {
        logger.warn(
          { storeId, statusCode: err?.statusCode, err: err?.message ?? err },
          '[PushService] Orders-app web push delivery failed'
        );
      }
    });

    if (expiredEndpoints.length > 0) {
      await withStoreRw(storeId, tx =>
        tx.pushSubscription.deleteMany({
          where: { storeId, endpoint: { in: expiredEndpoints } },
        })
      ).catch(err =>
        logger.warn(
          { err, storeId },
          '[PushService] Failed to clean up expired orders-app subscriptions'
        )
      );
    }

    const status = successCount > 0 ? 'sent' : 'failed';
    const ordersLog = {
      storeId,
      channel: 'push',
      event: 'orders_app_new_order',
      status,
      metadata: { title, tokenCount: subscriptions.length, successCount, failureCount },
    };
    await analyticsWrite(
      storeId,
      w => w.notificationLog.create({ data: ordersLog }),
      () => runInTenantContext(storeId, () => prisma.notificationLog.create({ data: ordersLog }))
    ).catch(err =>
      logger.error({ err }, '[PushService] Failed to write orders-app NotificationLog')
    );

    logger.info(
      { storeId, successCount, failureCount },
      '[PushService] Orders-app web push notification sent'
    );
  }

  /**
   * Unsubscribe a device by its endpoint.
   */
  async unsubscribe(endpoint: string): Promise<void> {
    await prisma.pushSubscription.deleteMany({
      where: { endpoint, storeId: currentStoreId() },
    });
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
