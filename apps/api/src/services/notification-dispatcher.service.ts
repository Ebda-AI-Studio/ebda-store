/**
 * Notification Dispatcher Service
 * Orchestrates multi-channel notification delivery (SMS, Push)
 * based on feature flags, per-event config, and available credentials.
 *
 * WhatsApp is intentionally NOT a dispatcher channel (it is the separate
 * Ebda Chat product).
 *
 * IMPORTANT: dispatch() NEVER throws — all errors are caught and logged.
 */

import { storeMayMessageCustomers } from '../lib/store-operational';
import { featureService } from './feature.service';
import { notificationConfigService } from './notification-config.service';
import { smsQueue } from './sms-queue.service';
import { pushService } from './push.service';
import { redis } from './redis.service';
import { prisma, withStore } from '@ebda/database';
import { storeRepo } from '../lib/repo-factory';
import logger from '../lib/logger';
import { isStoreGoneError } from '../lib/jobs/store-gone';
import { config } from '../config';
import { SmsConsentService } from './sms-consent.service';
import { signSmsOptOutToken } from '../lib/sms-consent';
import { smsSegments } from '../lib/sms-segments';
import { BoundedMap } from '../lib/bounded-map';
import {
  NotificationEvent,
  NotificationData,
  SMS_TEMPLATES,
  PUSH_TEMPLATES,
  renderSmsTemplate,
  resolveDefaultLanguage,
  storefrontOrigin,
} from '@ebda/shared';
import type { SmsConfig } from './sms.service';

// ==========================================
// Rate Limiting Constants
// ==========================================

const RATE_LIMIT_WINDOW_SECONDS = 3600; // 1 hour
const RATE_LIMIT_MAX_PER_WINDOW = 100; // 100 notifications per hour per store per channel

// ==========================================
// Event Classification
// ==========================================

/**
 * Events classified as PROMOTIONAL — sent only to a phone with an active
 * SMS-marketing consent row in `sms_marketing_consents` (issue 206; the gate
 * in `_dispatch` reads it via `SmsConsentService.findActiveForPhone`).
 *
 * Transactional events (order_confirmed, order_shipped, order_delivered,
 * order_cancelled, refund_processed, payment_success) are NOT in this set
 * and send whenever the channel is configured — no consent read.
 */
export const PROMOTIONAL_SMS_EVENTS: ReadonlySet<NotificationEvent> = new Set([
  'cart_abandoned_step1',
  'cart_abandoned_step2',
  'cart_abandoned_step3',
  'back_in_stock',
] as const);

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
    channelConfig: { credentials: Record<string, unknown>; enabled: boolean } | null,
    channel: string,
    storeId: string
  ): boolean {
    if (!channelConfig || !channelConfig.enabled) {
      return false;
    }

    const creds = channelConfig.credentials;
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
   * Can this store send promotional SMS at all? True only when the `sms`
   * feature is on, an SMS provider is configured with usable credentials,
   * and at least one promotional event has SMS enabled. The storefront
   * renders the SMS-marketing opt-in ONLY when this is true (issue 206), so
   * a store that has not set SMS marketing up shows no new UI. Never throws:
   * any failure reads as "not available" (the checkbox stays hidden).
   */
  async isSmsMarketingAvailable(storeId: string): Promise<boolean> {
    try {
      if (!(await featureService.isFeatureEnabled(storeId, 'sms'))) return false;
      const smsConfig = await notificationConfigService.getConfig(storeId, 'sms');
      if (!this.hasValidCredentials(smsConfig, 'sms', storeId)) return false;
      for (const event of PROMOTIONAL_SMS_EVENTS) {
        if ((await this.getEventConfig(storeId, event)).sms) return true;
      }
      return false;
    } catch (err) {
      logger.warn(
        { err, storeId },
        '[NotificationDispatcher] SMS-marketing availability check failed'
      );
      return false;
    }
  }

  /**
   * Returns event config for a store+event pair.
   * If no row exists, defaults all channels to true (all on by default).
   */
  async getEventConfig(storeId: string, event: NotificationEvent): Promise<EventConfig> {
    try {
      // notification_event_configs is under FORCE-RLS; dispatch() runs from
      // background fan-out with no tenant GUC, where findUnique would return
      // null → we'd silently fall back to all-on. Trusted internal read scoped
      // by the storeId+event unique key, so it enters the store's scope itself
      // (withStore) for a context-independent read (defaults stay all-on only
      // when the row genuinely doesn't exist).
      // A store on its Durable Object keeps its switches there (Ruling CF-NOTIFY-1): the same repo the admin writes through.
      const args = { where: { storeId, event }, select: { sms: true, push: true } } as const;
      const repo = await storeRepo(storeId);
      const row =
        repo.backend === 'do'
          ? await (repo.db as any).notificationEventConfig.findFirst(args)
          : await withStore(storeId, tx =>
              tx.notificationEventConfig.findUnique({
                where: { storeId_event: { storeId, event } },
                select: { sms: true, push: true },
              })
            );

      if (!row) {
        return { sms: true, push: true };
      }

      return { sms: row.sms, push: row.push };
    } catch (err) {
      // A DO store whose switches cannot be read fails CLOSED: defaulting "all on" would message customers a merchant turned
      // off. Postgres keeps its documented default (a missing row means all on).
      const onDo = await storeRepo(storeId).then(
        r => r.backend === 'do',
        () => true
      );
      logger.warn(
        { err, storeId, event, failClosed: onDo },
        '[NotificationDispatcher] Failed to fetch event config'
      );
      return onDo ? { sms: false, push: false } : { sms: true, push: true };
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
    // Ruling SUSPEND-OUT-1: every channel here reaches a CUSTOMER (shopper SMS, storefront push), so a store that is not
    // `active` sends none of it. The refund notice is the one kept: the money already went back to the customer.
    if (
      event !== 'refund_processed' &&
      !(await storeMayMessageCustomers(storeId, `dispatch:${event}`))
    ) {
      return;
    }
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
    // Promotional events (cart_abandoned_*, back_in_stock) require explicit
    // opt-in consent from the customer. Transactional events (order_confirmed,
    // order_shipped, order_delivered, order_cancelled, refund_processed) send
    // whenever the channel is configured — no opt-in gate.
    const isPromotionalSmsEvent = PROMOTIONAL_SMS_EVENTS.has(event);
    let consentId: string | null = null;
    if (!smsEnabled) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] SMS skipped: feature_disabled');
    } else if (!eventConfig.sms) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] SMS skipped: event_disabled');
    } else if (!this.hasValidCredentials(smsConfig, 'sms', storeId)) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] SMS skipped: not_configured');
    } else if (!data.customerPhone) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] SMS skipped: no_phone');
    } else if (
      isPromotionalSmsEvent &&
      !(consentId =
        (await SmsConsentService.findActiveForPhone(storeId, data.customerPhone))?.id ?? null)
    ) {
      // Issue 206: consent is the per-store row for this phone, not a flag the
      // caller passes in (no producer ever set one, so every promotional SMS
      // was skipped). No granted row → no send.
      logger.debug(
        { storeId, event },
        '[NotificationDispatcher] SMS skipped: promotional_no_consent'
      );
    } else if (!(await this.checkRateLimit(storeId, 'sms'))) {
      logger.debug({ storeId, event }, '[NotificationDispatcher] SMS skipped: rate_limited');
    } else {
      try {
        const smsTemplate = SMS_TEMPLATES[event];
        const locale = await resolveShopperLocale(storeId, data.locale);
        let messageText = renderSmsTemplate(smsTemplate[locale], data, locale);
        // Every promotional SMS carries its own opt-out link (issue 206).
        if (consentId) {
          messageText += ` ${SMS_OPT_OUT_LABEL[locale]}: ${await smsOptOutUrl(storeId, consentId)}`;
        }
        const smsCredentials = smsConfig!.credentials as unknown as SmsConfig;

        await smsQueue.enqueue({
          storeId,
          event,
          recipientPhone: data.customerPhone,
          messageText,
          config: smsCredentials,
          // `dedupeKey` when the producer has no per-recipient order number:
          // back-in-stock passes '' as orderNumber, which collapsed every
          // back-in-stock SMS of a store onto ONE key (only the first ever sent).
          idempotencyKey: `sms_${storeId}_${event}_${data.dedupeKey ?? data.orderNumber}`,
        });

        // Billed segments, so the cost of a template or of the opt-out link
        // is a number in the logs rather than a surprise on the bill (issue 2426).
        const { segments, encoding } = smsSegments(messageText);
        logger.info({ storeId, event, segments, encoding }, '[NotificationDispatcher] SMS queued');
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
        const locale = await resolveShopperLocale(storeId, data.locale);
        const title = pushTemplate.title[locale];
        const body = renderPushBody(pushTemplate.body[locale], data, locale);

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
 * The language a shopper's SMS / push is written in: the order's or customer's stored locale
 * (`data.locale`), else the store's `settings.defaultLanguage`, else the region default (`ar`
 * for Egypt). Never throws: a failed store read falls back to the region default.
 */
export async function resolveShopperLocale(storeId: string, stored: unknown): Promise<'en' | 'ar'> {
  if (stored === 'en' || stored === 'ar') return stored;
  try {
    // NZ-SMS-READS-1: a store on its Durable Object keeps `settings` there (the Worker has no Postgres): read it through the
    // same repo the storefront uses, else the shopper's SMS/push silently fell back to the region default.
    const query = { where: { id: storeId }, select: { settings: true } } as const;
    const repo = await storeRepo(storeId);
    const store =
      repo.backend === 'do'
        ? await (repo.db as any).store.findUnique(query)
        : await withStore(storeId, tx => tx.store.findUnique(query));
    return resolveDefaultLanguage(
      (store?.settings as { defaultLanguage?: string } | null)?.defaultLanguage
    );
  } catch (err) {
    logger.warn({ err, storeId }, '[NotificationDispatcher] locale lookup failed, region default');
    return resolveDefaultLanguage(undefined);
  }
}

const SMS_OPT_OUT_LABEL = { en: 'Stop offers', ar: 'إيقاف العروض' } as const;

/**
 * Storefront base per store, cached in memory so a fan-out (one back-in-stock
 * sweep is one dispatch per subscriber) reads the store once, not once per
 * recipient (issue 2426).
 *
 * The cache holds the in-flight PROMISE, not the resolved value (issue 2434):
 * the back-in-stock loop calls `dispatch` for every subscriber WITHOUT awaiting
 * between them, so every recipient reaches this function before the first read
 * resolves. A value cache misses for all N; a promise cache lets recipients 2..N
 * join recipient 1's read. An entry is dropped if its read rejects or the store
 * does not exist, so neither a failure nor a missing store is cached.
 *
 * Staleness class: BOUNDED-stale, 120s per API instance. The residual is a
 * store that changes its custom domain: for up to 120s its new promotional
 * SMS carry an opt-out link on the old domain. The token itself is
 * store-independent, so the link still works wherever that domain is served.
 */
const OPT_OUT_BASE_TTL_MS = 120_000;
const optOutBaseCache = new BoundedMap<string, { base: Promise<string>; expiresAt: number }>(2000);

async function readStorefrontBase(storeId: string): Promise<{ base: string; found: boolean }> {
  // `stores` is under RLS (R-EBDA-005): read in the store's own scope.
  // NZ-SMS-READS-1: the DO store row on the Worker (no Postgres there). A store that is gone (404 / 410) is "not found":
  // the platform URL, never cached; any other failure still throws so the dispatch fails loudly and is retried.
  const query = { where: { id: storeId }, select: { domain: true, slug: true } } as const;
  let store: { domain: string | null; slug: string } | null;
  try {
    const repo = await storeRepo(storeId);
    store =
      repo.backend === 'do'
        ? await (repo.db as any).store.findUnique(query)
        : await withStore(storeId, tx => tx.store.findUnique(query));
  } catch (err) {
    if (!isStoreGoneError(err)) throw err;
    store = null;
  }
  const base = store ? storefrontOrigin(store) : config.webUrl;
  return { base, found: !!store };
}

function storefrontBase(storeId: string): Promise<string> {
  const hit = optOutBaseCache.get(storeId);
  if (hit && hit.expiresAt > Date.now()) return hit.base;
  const entry = { expiresAt: Date.now() + OPT_OUT_BASE_TTL_MS } as {
    base: Promise<string>;
    expiresAt: number;
  };
  const evict = () => {
    if (optOutBaseCache.get(storeId) === entry) optOutBaseCache.delete(storeId);
  };
  entry.base = readStorefrontBase(storeId).then(({ base, found }) => {
    if (!found) evict();
    return base;
  });
  entry.base.catch(evict);
  optOutBaseCache.set(storeId, entry);
  return entry.base;
}

/** Test hook: the cached storefront-base read, for asserting how many store reads a fan-out costs. */
export const __storefrontBaseForTests = storefrontBase;

/** Test hook: forget cached storefront bases. */
export function __clearOptOutBaseCacheForTests(): void {
  optOutBaseCache.clear();
}

/**
 * The storefront opt-out page for a consent row: the store's own domain when
 * it has one, else the platform storefront under its slug (the same base the
 * abandoned-cart and back-in-stock links use). The token is a fixed
 * SMS_OPT_OUT_TOKEN_V3_LENGTH (68) characters (it carries the store id since NEON-ZERO: a Durable Object store has no
 * cross-store consent lookup), so the appended ` Stop offers: <base>/sms-unsubscribe?t=<token>` costs 101 characters plus
 * the base, and nothing that varies per recipient. It was 78 (45-character token) before the store id; 92 before issue 2426.
 */
async function smsOptOutUrl(storeId: string, consentId: string): Promise<string> {
  return `${await storefrontBase(storeId)}/sms-unsubscribe?t=${signSmsOptOutToken(consentId, storeId)}`;
}

/**
 * Renders a push body template with the same variable substitution used by SMS.
 */
function renderPushBody(template: string, data: NotificationData, locale: 'en' | 'ar'): string {
  // Same placeholder set as SMS ({productName}, {storeName}, {cartTotal}, {cartItems}, ...).
  return renderSmsTemplate(template, data, locale);
}

// Singleton instance
export const notificationDispatcher = new NotificationDispatcherService();
