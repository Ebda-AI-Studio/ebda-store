/**
 * Notification Dispatcher Service
 * Orchestrates multi-channel notification delivery (SMS, Push)
 * based on feature flags, per-event config, and available credentials.
 *
 * WhatsApp is intentionally NOT a dispatcher channel — it flows through the
 * Force AI Store ↔ WBS bridge as a separate event-driven path
 * (`apps/api/src/lib/inngest/functions/order-whatsapp-notify.ts`).
 *
 * IMPORTANT: dispatch() NEVER throws — all errors are caught and logged.
 */

import { featureService } from './feature.service';
import { notificationConfigService } from './notification-config.service';
import { smsQueue } from './sms-queue.service';
import { pushService } from './push.service';
import { redis } from './redis.service';
import { prisma } from '@force/database';
import logger from '../lib/logger';
import {
  NotificationEvent,
  NotificationData,
  SMS_TEMPLATES,
  PUSH_TEMPLATES,
  renderSmsTemplate,
} from '@force/shared';
import type { SmsConfig } from './sms.service';

// ==========================================
// Rate Limiting Constants
// ==========================================

const RATE_LIMIT_WINDOW_SECONDS = 3600; // 1 hour
const RATE_LIMIT_MAX_PER_WINDOW = 100; // 100 notifications per hour per store per channel

// ==========================================
// Notification Dispatcher
// ==========================================

interface EventConfig {
  sms: boolean;
  push: boolean;
}

class NotificationDispatcherService {
  // ==========================================
  // Rate Limiting
  // ==========================================

  /**
   * Checks and increments the rate limit counter for a store+channel pair.
   * Returns true if the request is within limits, false if rate limited.
   */
  private async checkRateLimit(storeId: string, channel: string): Promise<boolean> {
    const key = `notify:rate:${storeId}:${channel}`;
    const count = await redis.incrementRateLimit(key, RATE_LIMIT_WINDOW_SECONDS);

    if (count > RATE_LIMIT_MAX_PER_WINDOW) {
      logger.warn(
        { storeId, channel, count, limit: RATE_LIMIT_MAX_PER_WINDOW },
        '[NotificationDispatcher] Rate limit exceeded'
      );
      return false;
    }

    return true;
  }

  /**
   * Validates that a channel's credentials contain non-empty required fields.
   * Returns true if credentials appear configured, false otherwise.
   */
  private hasValidCredentials(
    config: { credentials: Record<string, unknown>; enabled: boolean } | null,
    channel: string,
    storeId: string
  ): boolean {
    if (!config || !config.enabled) {
      return false;
    }

    const creds = config.credentials;
    if (!creds || typeof creds !== 'object' || Object.keys(creds).length === 0) {
      logger.warn(
        { storeId, channel },
        '[NotificationDispatcher] Channel credentials are empty or missing — skipping'
      );
      return false;
    }

    // Check that at least one credential value is a non-empty string
    const hasNonEmptyValue = Object.values(creds).some(
      v => typeof v === 'string' && v.trim().length > 0
    );

    if (!hasNonEmptyValue) {
      logger.warn(
        { storeId, channel },
        '[NotificationDispatcher] All credential values are empty — skipping'
      );
      return false;
    }

    return true;
  }

  // ==========================================
  // Public API
  // ==========================================

  /**
   * Dispatches a notification event to all enabled, configured channels.
   * Fire-and-forget — NEVER throws.
   */
  async dispatch(storeId: string, event: NotificationEvent, data: NotificationData): Promise<void> {
    try {
      await this._dispatch(storeId, event, data);
    } catch (err) {
      // Belt-and-suspenders: _dispatch should catch internally, but guard here too
      logger.error(
        { err, storeId, event },
        '[NotificationDispatcher] Unexpected error in dispatch'
      );
    }
  }

  /**
   * Returns event config for a store+event pair.
   * If no row exists, defaults all channels to true (all on by default).
   */
  async getEventConfig(storeId: string, event: NotificationEvent): Promise<EventConfig> {
    try {
      const row = await prisma.notificationEventConfig.findUnique({
        where: { storeId_event: { storeId, event } },
        select: { sms: true, push: true },
      });

      if (!row) {
        return { sms: true, push: true };
      }

      return { sms: row.sms, push: row.push };
    } catch (err) {
      logger.warn(
        { err, storeId, event },
        '[NotificationDispatcher] Failed to fetch event config, defaulting all on'
      );
      return { sms: true, push: true };
    }
  }

  // ==========================================
  // Internal Dispatch Logic
  // ==========================================

  private async _dispatch(
    storeId: string,
    event: NotificationEvent,
    data: NotificationData
  ): Promise<void> {
    // 1. Check feature flags in parallel
    const [smsEnabled, pushEnabled] = await Promise.all([
      featureService.isFeatureEnabled(storeId, 'sms'),
      featureService.isFeatureEnabled(storeId, 'push_notifications'),
    ]);

    // 2. Get per-event channel config
    const eventConfig = await this.getEventConfig(storeId, event);

    // 3. Get channel credentials
    const [smsConfig, pushConfig] = await Promise.all([
      notificationConfigService.getConfig(storeId, 'sms'),
      notificationConfigService.getConfig(storeId, 'push'),
    ]);

    // 4. Dispatch to each channel — wrapped individually so one failure doesn't block others

    // ── SMS ───────────────────────────────────────────────────────────────────
    if (!smsEnabled) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] SMS skipped: feature_disabled');
    } else if (!eventConfig.sms) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] SMS skipped: event_disabled');
    } else if (!this.hasValidCredentials(smsConfig, 'sms', storeId)) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] SMS skipped: not_configured');
    } else if (!data.customerPhone) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] SMS skipped: no_phone');
    } else if (!(await this.checkRateLimit(storeId, 'sms'))) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] SMS skipped: rate_limited');
    } else {
      try {
        const smsTemplate = SMS_TEMPLATES[event];
        // Default to English; locale selection can be extended later
        const messageText = renderSmsTemplate(smsTemplate.en, data);
        const smsCredentials = smsConfig!.credentials as unknown as SmsConfig;

        await smsQueue.enqueue({
          storeId,
          event,
          recipientPhone: data.customerPhone,
          messageText,
          config: smsCredentials,
          idempotencyKey: `sms_${storeId}_${event}_${data.orderNumber}`,
        });

        logger.info({ storeId, event }, '[NotificationDispatcher] SMS queued');
      } catch (err) {
        logger.error({ err, storeId, event }, '[NotificationDispatcher] SMS dispatch failed');
      }
    }

    // ── Push ──────────────────────────────────────────────────────────────────
    if (!pushEnabled) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] Push skipped: feature_disabled');
    } else if (!eventConfig.push) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] Push skipped: event_disabled');
    } else if (!this.hasValidCredentials(pushConfig, 'push', storeId)) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] Push skipped: not_configured');
    } else if (!(await this.checkRateLimit(storeId, 'push'))) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] Push skipped: rate_limited');
    } else {
      try {
        const pushTemplate = PUSH_TEMPLATES[event];
        // Default to English; locale selection can be extended later
        const title = pushTemplate.title.en;
        const body = renderPushBody(pushTemplate.body.en, data);

        await pushService.sendToStore(storeId, title, body, {
          event,
          orderNumber: data.orderNumber,
        });

        logger.info({ storeId, event }, '[NotificationDispatcher] Push dispatched');
      } catch (err) {
        logger.error({ err, storeId, event }, '[NotificationDispatcher] Push dispatch failed');
      }
    }
  }
}

// ==========================================
// Helpers
// ==========================================

/**
 * Renders a push body template with the same variable substitution used by SMS.
 */
function renderPushBody(template: string, data: NotificationData): string {
  return template
    .replace('{name}', data.customerName)
    .replace('#{number}', `#${data.orderNumber}`)
    .replace('{number}', data.orderNumber)
    .replace('{total}', data.total !== undefined ? data.total.toFixed(2) : '')
    .replace('{tracking}', data.trackingNumber ?? '')
    .replace('{reason}', data.reason ?? '')
    .replace('{amount}', data.amount !== undefined ? data.amount.toFixed(2) : '');
}

// Singleton instance
export const notificationDispatcher = new NotificationDispatcherService();
