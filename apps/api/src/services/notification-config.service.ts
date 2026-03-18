import { prisma } from '@force/database';
import { redis } from './redis.service';
import { encryption } from './encryption.service';
import logger from '../lib/logger';

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
    const rows = await prisma.notificationConfig.findMany({
      where: { storeId },
      select: { channel: true, provider: true, credentials: true, enabled: true },
    });

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
    const encryptedCredentials = encryption.encrypt(JSON.stringify(data.credentials));

    await prisma.notificationConfig.upsert({
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
    await prisma.notificationConfig.deleteMany({
      where: { storeId, channel },
    });

    // Re-read from DB and SET cache
    const freshConfigs = await this.readFromDb(storeId);
    await this.writeToCache(storeId, freshConfigs);

    logger.info({ storeId, channel }, '[NotificationConfigService] Config deleted');
  }

  /**
   * Placeholder for testing provider connectivity.
   * Actual provider testing will be added when WhatsApp/SMS services are created.
   */
  async testConnection(storeId: string, channel: string): Promise<{ success: boolean }> {
    logger.debug(
      { storeId, channel },
      '[NotificationConfigService] testConnection called (placeholder)'
    );
    return { success: true };
  }

  /**
   * Returns all NotificationEventConfig rows for a store.
   * If no row exists for an event, defaults all channels to true.
   */
  async getEventConfigs(storeId: string): Promise<Record<string, EventConfigData>> {
    const rows = await prisma.notificationEventConfig.findMany({
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
    const row = await prisma.notificationEventConfig.upsert({
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
