import { prisma } from '@force/database';
import { FeatureKey, FEATURE_KEYS_ARRAY } from '@force/shared';
import { redis } from './redis.service';
import logger from '../lib/logger';

const CACHE_PREFIX = 'features:store:';
const CACHE_TTL = 300; // 5 minutes

class FeatureService {
  // ==========================================
  // Cache Helpers
  // ==========================================

  private cacheKey(storeId: string): string {
    return `${CACHE_PREFIX}${storeId}`;
  }

  private async readFromCache(storeId: string): Promise<Record<FeatureKey, boolean> | null> {
    try {
      const cached = await redis.get<Record<FeatureKey, boolean>>(this.cacheKey(storeId), true);
      return cached;
    } catch (err) {
      logger.warn({ err, storeId }, '[FeatureService] Cache read failed, falling back to DB');
      return null;
    }
  }

  private async writeToCache(
    storeId: string,
    features: Record<FeatureKey, boolean>
  ): Promise<void> {
    try {
      await redis.set(this.cacheKey(storeId), features, CACHE_TTL);
    } catch (err) {
      logger.warn({ err, storeId }, '[FeatureService] Cache write failed');
    }
  }

  // ==========================================
  // DB Read — always returns full 21-key map
  // ==========================================

  private async readFromDb(storeId: string): Promise<Record<FeatureKey, boolean>> {
    const rows = await prisma.storeFeature.findMany({
      where: { storeId },
      select: { featureKey: true, enabled: true },
    });

    // Start with all keys defaulting to false
    const map = Object.fromEntries(FEATURE_KEYS_ARRAY.map(key => [key, false])) as Record<
      FeatureKey,
      boolean
    >;

    for (const row of rows) {
      if (FEATURE_KEYS_ARRAY.includes(row.featureKey as FeatureKey)) {
        map[row.featureKey as FeatureKey] = row.enabled;
      }
    }

    return map;
  }

  // ==========================================
  // Public API
  // ==========================================

  /**
   * Returns a full map of all 21 feature keys → boolean for the given store.
   * Checks Redis cache first; on miss reads from DB and populates cache.
   */
  async getStoreFeatures(storeId: string): Promise<Record<FeatureKey, boolean>> {
    // 1. Try cache
    const cached = await this.readFromCache(storeId);
    if (cached !== null) {
      return cached;
    }

    // 2. Cache miss — read from DB
    logger.debug({ storeId }, '[FeatureService] Cache miss, reading from DB');
    const features = await this.readFromDb(storeId);

    // 3. Populate cache (best-effort)
    await this.writeToCache(storeId, features);

    return features;
  }

  /**
   * Returns whether a single feature is enabled for the given store.
   */
  async isFeatureEnabled(storeId: string, featureKey: FeatureKey): Promise<boolean> {
    const features = await this.getStoreFeatures(storeId);
    return features[featureKey] ?? false;
  }

  /**
   * Returns only the keys of features that are currently enabled.
   * Intended for the public store endpoint.
   */
  async getEnabledFeatureKeys(storeId: string): Promise<string[]> {
    const features = await this.getStoreFeatures(storeId);
    return (Object.keys(features) as FeatureKey[]).filter(key => features[key]);
  }

  /**
   * Upserts multiple feature flags in a single transaction.
   * - Sets enabledAt = now() when enabling, null when disabling.
   * - Sets enabledBy = userId.
   * - After writing, re-reads ALL features from DB and SETs the Redis cache
   *   (avoids Neon replica staleness by not deleting then reading stale data).
   * Returns the full feature map.
   */
  async updateStoreFeatures(
    storeId: string,
    updates: Partial<Record<FeatureKey, boolean>>,
    userId: string
  ): Promise<Record<FeatureKey, boolean>> {
    const now = new Date();

    await prisma.$transaction(
      Object.entries(updates).map(([featureKey, enabled]) =>
        prisma.storeFeature.upsert({
          where: { storeId_featureKey: { storeId, featureKey } },
          create: {
            storeId,
            featureKey,
            enabled: enabled as boolean,
            enabledAt: enabled ? now : null,
            enabledBy: userId,
          },
          update: {
            enabled: enabled as boolean,
            enabledAt: enabled ? now : null,
            enabledBy: userId,
          },
        })
      )
    );

    // Re-read from DB and SET cache (not DELETE) to avoid Neon replica staleness
    const freshFeatures = await this.readFromDb(storeId);
    await this.writeToCache(storeId, freshFeatures);

    logger.info(
      { storeId, updatedKeys: Object.keys(updates) },
      '[FeatureService] Features updated'
    );

    return freshFeatures;
  }

  /**
   * Enables or disables a single feature flag. Idempotent.
   */
  async setFeature(
    storeId: string,
    featureKey: FeatureKey,
    enabled: boolean,
    userId: string
  ): Promise<Record<FeatureKey, boolean>> {
    return this.updateStoreFeatures(storeId, { [featureKey]: enabled }, userId);
  }
}

// Singleton instance — matches pattern of other services
export const featureService = new FeatureService();
