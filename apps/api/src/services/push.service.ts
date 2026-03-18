/**
 * Push Notification Service
 * Firebase Cloud Messaging (FCM) push notifications via firebase-admin
 */

import * as admin from 'firebase-admin';
import { prisma } from '@force/database';
import logger from '../lib/logger';
import { notificationConfigService } from './notification-config.service';

// ==========================================
// Push Service
// Manages per-store Firebase app instances and FCM delivery
// ==========================================

class PushService {
  // Cache of initialized Firebase app instances per storeId
  private apps = new Map<string, admin.app.App>();

  // ==========================================
  // Firebase App Management
  // ==========================================

  /**
   * Returns (or initializes) the Firebase app for a given store.
   * Uses 'store-{storeId}' as the app name to keep instances isolated.
   */
  private getApp(storeId: string, serviceAccount: admin.ServiceAccount): admin.app.App {
    const appName = `store-${storeId}`;

    const cached = this.apps.get(storeId);
    if (cached) {
      return cached;
    }

    // Check if the named app already exists (e.g. after hot reload)
    let app: admin.app.App;
    try {
      app = admin.app(appName);
    } catch {
      // App doesn't exist yet — initialize it
      app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }, appName);
    }

    this.apps.set(storeId, app);
    return app;
  }

  // ==========================================
  // Public API
  // ==========================================

  /**
   * Send a push notification to all subscribed devices for a store.
   * Cleans up expired/invalid registration tokens automatically.
   * Logs the result to NotificationLog.
   */
  async sendToStore(
    storeId: string,
    title: string,
    body: string,
    data?: Record<string, string>
  ): Promise<void> {
    // 1. Get push channel config (contains Firebase service account JSON)
    const config = await notificationConfigService.getConfig(storeId, 'push');

    if (!config || !config.enabled) {
      logger.debug(
        { storeId },
        '[PushService] Push config not found or disabled, skipping sendToStore'
      );
      return;
    }

    const serviceAccount = config.credentials as admin.ServiceAccount;

    // 2. Get all push subscriptions (registration tokens) for this store
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { storeId },
      select: { id: true, endpoint: true },
    });

    if (subscriptions.length === 0) {
      logger.debug({ storeId }, '[PushService] No push subscriptions for store, skipping');
      return;
    }

    // 3. Build FCM registration tokens (endpoint is the FCM token)
    const tokens = subscriptions.map(s => s.endpoint);

    // 4. Get Firebase app for this store
    const app = this.getApp(storeId, serviceAccount);

    // 5. Send multicast message
    const message: admin.messaging.MulticastMessage = {
      tokens,
      notification: { title, body },
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    let sendResponse: admin.messaging.BatchResponse;
    try {
      sendResponse = await app.messaging().sendEachForMulticast(message);
    } catch (err) {
      logger.error({ err, storeId }, '[PushService] FCM sendEachForMulticast failed');
      // Log a single failure entry
      await prisma.notificationLog
        .create({
          data: {
            storeId,
            channel: 'push',
            event: 'push_send',
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
            metadata: { tokenCount: tokens.length, title },
          },
        })
        .catch(logErr =>
          logger.error({ err: logErr }, '[PushService] Failed to write NotificationLog')
        );
      return;
    }

    // 6. Clean up invalid/expired tokens
    const expiredEndpoints: string[] = [];
    sendResponse.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error) {
        const code = resp.error.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          expiredEndpoints.push(tokens[idx]);
        } else {
          logger.warn(
            { storeId, errorCode: code, token: tokens[idx] },
            '[PushService] FCM token error'
          );
        }
      }
    });

    if (expiredEndpoints.length > 0) {
      await prisma.pushSubscription
        .deleteMany({ where: { storeId, endpoint: { in: expiredEndpoints } } })
        .catch(err =>
          logger.warn({ err, storeId }, '[PushService] Failed to clean up expired tokens')
        );

      logger.info(
        { storeId, count: expiredEndpoints.length },
        '[PushService] Cleaned up expired push subscriptions'
      );
    }

    // 7. Log result
    const successCount = sendResponse.successCount;
    const failureCount = sendResponse.failureCount;
    const status = successCount > 0 ? 'sent' : 'failed';

    await prisma.notificationLog
      .create({
        data: {
          storeId,
          channel: 'push',
          event: 'push_send',
          status,
          metadata: {
            title,
            tokenCount: tokens.length,
            successCount,
            failureCount,
          },
        },
      })
      .catch(err => logger.error({ err }, '[PushService] Failed to write NotificationLog'));

    logger.info(
      { storeId, successCount, failureCount, title },
      '[PushService] Push notification sent'
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
