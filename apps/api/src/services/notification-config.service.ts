import { withStore } from '@ebda/database';
import { storeRepo, storeWriter } from '../lib/repo-factory';
import { redis } from './redis.service';
import { encryption } from './encryption.service';
import { smsService } from './sms.service';
import type { SmsConfig } from './sms.service';
import logger from '../lib/logger';
import { config as appConfig } from '../config';
import { AppError } from '../middleware/error-handler';

// ==========================================
// Notification Config Service
// Manages per-store notification channel credentials
// with encryption and Redis caching
// ==========================================

const CACHE_PREFIX = 'notification:config:';
const CACHE_TTL = 300; // 5 minutes

export interface DecryptedConfig {
  channel: string;
  provider: string;
  credentials: Record<string, unknown>;
  enabled: boolean;
}

export interface UpsertConfigData {
  provider: string;
  credentials: Record<string, unknown>;
  enabled: boolean;
}

export interface EventConfigData {
  whatsapp: boolean;
  sms: boolean;
  push: boolean;
}

class NotificationConfigService {
  // ==========================================
  // Cache Helpers
  // ==========================================

  private cacheKey(storeId: string): string {
    return `${CACHE_PREFIX}${storeId}`;
  }

  private async readFromCache(storeId: string): Promise<Record<string, DecryptedConfig> | null> {
    try {
      const cached = await redis.get<Record<string, DecryptedConfig>>(this.cacheKey(storeId), true);
      return cached;
    } catch (err) {
      logger.warn(
        { err, storeId },
        '[NotificationConfigService] Cache read failed, falling back to DB'
      );
      return null;
    }
  }

  private async writeToCache(
    storeId: string,
    configs: Record<string, DecryptedConfig>
  ): Promise<void> {
    try {
      await redis.set(this.cacheKey(storeId), configs, CACHE_TTL);
    } catch (err) {
      logger.warn({ err, storeId }, '[NotificationConfigService] Cache write failed');
    }
  }

  // ==========================================
  // DB Read
  // ==========================================

  private async readFromDb(storeId: string): Promise<Record<string, DecryptedConfig>> {
    // notification_configs is under FORCE ROW LEVEL SECURITY. This read runs
    // from BOTH request handlers (which carry tenant context) AND background
    // fan-out (order-created / abandoned-cart Inngest jobs) which do NOT — and
    // without the GUC the policy returns 0 rows, so the result would be an empty
    // (and Redis-cached) config map: storefront push/SMS silently disabled. This
    // is a trusted internal read already scoped by `where: { storeId }`, so it
    // enters the store's scope itself (withStore) to be context-independent.
    // A store on its Durable Object reads its own row set (Ruling CF-NOTIFY-1); there is no RLS inside a DO.
    const args = {
      where: { storeId },
      select: { channel: true, provider: true, credentials: true, enabled: true },
    } as const;
    const repo = await storeRepo(storeId);
    const rows =
      repo.backend === 'do'
        ? await (repo.db as any).notificationConfig.findMany(args)
        : await withStore(storeId, tx => tx.notificationConfig.findMany(args));

    const map: Record<string, DecryptedConfig> = {};

    for (const row of rows) {
      let credentials: Record<string, unknown> = {};

      if (row.credentials) {
        try {
          const decrypted = encryption.decrypt(row.credentials);
          credentials = JSON.parse(decrypted);
        } catch (err) {
          logger.warn(
            { err, storeId, channel: row.channel },
            '[NotificationConfigService] Failed to decrypt credentials'
          );
        }
      }

      map[row.channel] = {
        channel: row.channel,
        provider: row.provider,
        credentials,
        enabled: row.enabled,
      };
    }

    return map;
  }

  // ==========================================
  // Credential Masking
  // ==========================================

  /**
   * Returns a copy of credentials with sensitive values showing only last 4 chars.
   * Used for display in admin UI.
   */
  maskCredentials(credentials: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(credentials)) {
      if (typeof value === 'string' && value.length > 4) {
        masked[key] = `****${value.slice(-4)}`;
      } else {
        masked[key] = value;
      }
    }

    return masked;
  }

  /**
   * Merge incoming credentials over the currently-stored (decrypted) values,
   * preserving any field whose incoming value is still the `****` mask
   * sentinel. Stops a "Save" with an untouched, masked credential from
   * overwriting the real stored secret with mask text.
   */
  private async preserveMaskedCredentials(
    storeId: string,
    channel: string,
    incoming: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    let stored: Record<string, unknown> | null = null;
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(incoming)) {
      // A masked value always contains the `****` sentinel emitted by
      // `maskCredentials`. Lazily load the stored config only when needed.
      if (typeof value === 'string' && value.includes('****')) {
        if (stored === null) {
          // Straight from Prisma, NEVER through getConfig's 300s Redis cache.
          // This is the merge base for a secret we are about to overwrite, so
          // it must be current truth: a cached base is stale by up to the TTL
          // (silently reverting a credential just changed on another replica),
          // and a cache entry that fails to decrypt reads as "no credentials"
          // and erases the secret outright. Same defect fixed the same way in
          // shipping-carrier.service.ts.
          const repo = await storeRepo(storeId);
          const current = await (repo.db as any).notificationConfig.findFirst({
            where: { storeId, channel },
            select: { credentials: true },
          });
          stored = {};
          if (current?.credentials) {
            stored = JSON.parse(encryption.decrypt(current.credentials)) as Record<string, unknown>;
          }
        }
        const storedVal = stored[key];
        // Keep the real stored secret. If we cannot resolve one, REFUSE the
        // save: dropping the field persists a truncated credential set over a
        // working one — silent, permanent data loss the merchant never sees.
        // Failing the write is recoverable; erasing their provider secret is not.
        if (typeof storedVal === 'string' && storedVal.length > 0) {
          out[key] = storedVal;
        } else {
          // Same shape as shipping-carrier.service.ts's sibling guard — a
          // plain Error here turned into error-handler.ts's generic 500
          // "Internal server error" instead of this actionable 400.
          throw new AppError(
            400,
            'NOTIFICATION_CREDENTIALS_UNRESOLVED',
            `Re-enter the ${channel} credentials: the saved value for "${key}" could not be read, and saving now would erase it.`
          );
        }
      } else {
        out[key] = value;
      }
    }

    return out;
  }

  // ==========================================
  // Public API
  // ==========================================

  /**
   * Returns all channel configs for a store with decrypted credentials.
   * Redis cached at notification:config:{storeId} (5 min TTL).
   */
  async getStoreConfigs(storeId: string): Promise<Record<string, DecryptedConfig>> {
    // 1. Try cache
    const cached = await this.readFromCache(storeId);
    if (cached !== null) {
      return cached;
    }

    // 2. Cache miss — read from DB
    logger.debug({ storeId }, '[NotificationConfigService] Cache miss, reading from DB');
    const configs = await this.readFromDb(storeId);

    // 3. Populate cache (best-effort)
    await this.writeToCache(storeId, configs);

    return configs;
  }

  /**
   * Returns a single channel config with decrypted credentials.
   */
  async getConfig(storeId: string, channel: string): Promise<DecryptedConfig | null> {
    const configs = await this.getStoreConfigs(storeId);
    return configs[channel] ?? null;
  }

  /**
   * Upserts a notification channel config.
   * Encrypts credentials before storing. Invalidates Redis cache by re-reading from DB and SET-ing.
   */
  async upsertConfig(
    storeId: string,
    channel: string,
    data: UpsertConfigData
  ): Promise<DecryptedConfig> {
    // Masked-secret resubmit guard: the admin GET returns credentials masked
    // (`****1234`). If the admin saves a channel without editing a credential,
    // that masked value comes back on the PUT — persisting it would overwrite
    // the real secret (e.g. Unifonic appSid) with mask text. Treat any value
    // still carrying the `****` sentinel as "unchanged" and keep the stored
    // credential instead.
    const mergedCredentials = await this.preserveMaskedCredentials(
      storeId,
      channel,
      data.credentials
    );
    const encryptedCredentials = encryption.encrypt(JSON.stringify(mergedCredentials));

    await (
      await storeWriter(storeId)
    ).notificationConfig.upsert({
      where: { storeId_channel: { storeId, channel } },
      create: {
        storeId,
        channel,
        provider: data.provider,
        credentials: encryptedCredentials,
        enabled: data.enabled,
      },
      update: {
        provider: data.provider,
        credentials: encryptedCredentials,
        enabled: data.enabled,
      },
    });

    // Re-read from DB and SET cache (not DELETE) to avoid Neon replica staleness
    const freshConfigs = await this.readFromDb(storeId);
    await this.writeToCache(storeId, freshConfigs);

    logger.info({ storeId, channel }, '[NotificationConfigService] Config upserted');

    return freshConfigs[channel];
  }

  /**
   * Removes a notification channel config and invalidates cache.
   */
  async deleteConfig(storeId: string, channel: string): Promise<void> {
    await (
      await storeWriter(storeId)
    ).notificationConfig.deleteMany({
      where: { storeId, channel },
    });

    // Re-read from DB and SET cache
    const freshConfigs = await this.readFromDb(storeId);
    await this.writeToCache(storeId, freshConfigs);

    logger.info({ storeId, channel }, '[NotificationConfigService] Config deleted');
  }

  /**
   * Tests real provider connectivity for a notification channel.
   *
   * SMS: calls the Unifonic Account/info read-only endpoint with the stored
   *      credentials — no SMS is sent. Returns {success: false, message} with
   *      a sanitized error (no credential values) when creds are missing or
   *      rejected by the provider.
   *
   * Push: checks the platform VAPID keys and that at least one device is subscribed.
   *
   * Any other channel (whatsapp, unknown): {success: false, message: 'not testable'} - never a fake success.
   */
  async testConnection(
    storeId: string,
    channel: string
  ): Promise<{ success: boolean; message?: string }> {
    logger.debug({ storeId, channel }, '[NotificationConfigService] testConnection called');

    if (channel === 'sms') {
      const config = await this.getConfig(storeId, 'sms');

      if (!config || !config.enabled) {
        return { success: false, message: 'SMS channel is not configured or is disabled.' };
      }

      const creds = config.credentials as Partial<SmsConfig>;
      if (!creds.appSid || !creds.senderId) {
        return {
          success: false,
          message: 'SMS credentials are incomplete (appSid or senderId missing).',
        };
      }

      const result = await smsService.verifyCredentials({
        appSid: creds.appSid,
        senderId: creds.senderId,
      });

      if (!result.ok) {
        return { success: false, message: result.reason ?? 'SMS provider verification failed.' };
      }

      return { success: true };
    }

    // Push: web-push uses the platform's VAPID keys (no per-store credentials), so the honest test is
    // "can this platform send, and is there a device to send to". No notification is sent to a shopper.
    if (channel === 'push' || channel === 'push_notifications') {
      if (!appConfig.vapidPublicKey || !appConfig.vapidPrivateKey) {
        return {
          success: false,
          message: 'Push is not configured on the platform (VAPID keys are missing).',
        };
      }
      const devices = await (
        await storeRepo(storeId)
      ).db.pushSubscription.count({ where: { storeId } });
      if (devices === 0) {
        return {
          success: false,
          message:
            'Push is set up, but no device is subscribed yet, so there is nothing to deliver to.',
        };
      }
      return { success: true, message: `Push is ready: ${devices} subscribed device(s).` };
    }

    // WhatsApp is a separate product, and any other channel has no provider test: never a fake success.
    logger.debug({ storeId, channel }, '[NotificationConfigService] testConnection: not testable');
    return { success: false, message: `The ${channel} channel is not testable from here.` };
  }

  /**
   * Returns all NotificationEventConfig rows for a store.
   * If no row exists for an event, defaults all channels to true.
   */
  async getEventConfigs(storeId: string): Promise<Record<string, EventConfigData>> {
    const rows = await (
      await storeRepo(storeId)
    ).db.notificationEventConfig.findMany({
      where: { storeId },
      select: { event: true, whatsapp: true, sms: true, push: true },
    });

    const map: Record<string, EventConfigData> = {};

    for (const row of rows) {
      map[row.event] = {
        whatsapp: row.whatsapp,
        sms: row.sms,
        push: row.push,
      };
    }

    return map;
  }

  /**
   * Upserts a notification event config row.
   */
  async upsertEventConfig(
    storeId: string,
    event: string,
    config: EventConfigData
  ): Promise<EventConfigData> {
    const row = await (
      await storeWriter(storeId)
    ).notificationEventConfig.upsert({
      where: { storeId_event: { storeId, event } },
      create: {
        storeId,
        event,
        whatsapp: config.whatsapp,
        sms: config.sms,
        push: config.push,
      },
      update: {
        whatsapp: config.whatsapp,
        sms: config.sms,
        push: config.push,
      },
    });

    logger.info({ storeId, event }, '[NotificationConfigService] Event config upserted');

    return {
      whatsapp: row.whatsapp,
      sms: row.sms,
      push: row.push,
    };
  }
}

// Singleton instance — matches pattern of other services
export const notificationConfigService = new NotificationConfigService();
