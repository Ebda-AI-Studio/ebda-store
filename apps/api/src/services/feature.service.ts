import { prisma, Prisma, withMoneyTx } from '@force/database';
import { FeatureKey, FEATURE_KEYS_ARRAY, PLAN_BASELINE, type StorePlan } from '@force/shared';
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

  /**
   * Build the full feature map for a store, resolving:
   *   1. Start with PLAN_BASELINE[plan] features enabled (defaults to false otherwise).
   *   2. Apply StoreFeature row overrides: enabled=true ADDS, enabled=false REMOVES.
   *
   * Pure transform; takes plan + rows so it can be reused with the
   * transaction client during write paths (defends against Neon
   * read-replica staleness — see updateStoreFeatures).
   *
   * Plan-change behavior: super-admin overrides PRESERVED across upgrade
   * AND downgrade. Plan changes never touch StoreFeature rows. See
   * docs/superpowers/plans/2026-05-27-feature-tiering-and-access-control.md.
   */
  private rowsToMap(
    plan: StorePlan,
    rows: Array<{ featureKey: string; enabled: boolean }>
  ): Record<FeatureKey, boolean> {
    // Start with all false.
    const map = Object.fromEntries(FEATURE_KEYS_ARRAY.map(key => [key, false])) as Record<
      FeatureKey,
      boolean
    >;
    // Layer 1: PLAN_BASELINE — what the plan includes by default.
    const baseline = PLAN_BASELINE[plan] ?? [];
    for (const key of baseline) {
      if (FEATURE_KEYS_ARRAY.includes(key as FeatureKey)) {
        map[key as FeatureKey] = true;
      }
    }
    // Layer 2: per-store overrides on top.
    for (const row of rows) {
      if (FEATURE_KEYS_ARRAY.includes(row.featureKey as FeatureKey)) {
        map[row.featureKey as FeatureKey] = row.enabled;
      }
    }
    return map;
  }

  private async readFromDb(storeId: string): Promise<Record<FeatureKey, boolean>> {
    const [store, rows] = await Promise.all([
      prisma.store.findUnique({ where: { id: storeId }, select: { plan: true } }),
      prisma.storeFeature.findMany({
        where: { storeId },
        select: { featureKey: true, enabled: true },
      }),
    ]);
    // If the store doesn't exist, return all-false (safe default; callers
    // already handle missing stores at the route level via requireStoreAccess).
    if (!store) {
      return Object.fromEntries(FEATURE_KEYS_ARRAY.map(key => [key, false])) as Record<
        FeatureKey,
        boolean
      >;
    }
    return this.rowsToMap(store.plan as StorePlan, rows);
  }

  /**
   * Invalidate the cached feature map for a store. Call AFTER any change
   * to `Store.plan` (which doesn't touch StoreFeature rows but does
   * change the resolved map). Best-effort — if Redis is down, the next
   * cache miss reads from DB anyway.
   */
  async invalidateCache(storeId: string): Promise<void> {
    try {
      await redis.delete(this.cacheKey(storeId));
      logger.debug({ storeId }, '[FeatureService] Cache invalidated');
    } catch (err) {
      logger.warn({ err, storeId }, '[FeatureService] Cache invalidation failed (non-fatal)');
    }
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

    // Run upserts AND the post-write read in a single interactive
    // transaction. Reading via the same `tx` client guarantees the
    // SELECT goes to the primary that just absorbed the writes —
    // avoids the Neon read-replica staleness window where the cache
    // would otherwise be repopulated with the pre-write row state.
    const freshFeatures = await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
      for (const [featureKey, enabled] of Object.entries(updates)) {
        await tx.storeFeature.upsert({
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
        });
      }
      // Read plan + override rows via the SAME tx so the resolved map
      // reflects the writes we just made.
      const store = await tx.store.findUnique({
        where: { id: storeId },
        select: { plan: true },
      });
      const rows = await tx.storeFeature.findMany({
        where: { storeId },
        select: { featureKey: true, enabled: true },
      });
      return this.rowsToMap((store?.plan ?? 'free') as StorePlan, rows);
    });

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

  /**
   * Removes a StoreFeature override row, so the feature falls back to
   * the PLAN_BASELINE value. Used by the super-admin "Reset to plan
   * defaults" button + the per-row "Clear override" action.
   */
  async clearFeatureOverride(
    storeId: string,
    featureKey: FeatureKey
  ): Promise<Record<FeatureKey, boolean>> {
    await prisma.storeFeature
      .delete({ where: { storeId_featureKey: { storeId, featureKey } } })
      .catch(() => {
        // Row didn't exist — already at baseline. No-op.
      });
    await this.invalidateCache(storeId);
    return this.getStoreFeatures(storeId);
  }

  /**
   * Deletes ALL StoreFeature override rows for the store, resetting
   * every feature to its plan baseline. Super-admin nuclear button.
   */
  async resetAllOverrides(storeId: string): Promise<Record<FeatureKey, boolean>> {
    await prisma.storeFeature.deleteMany({ where: { storeId } });
    await this.invalidateCache(storeId);
    logger.info({ storeId }, '[FeatureService] All overrides cleared (reset to plan baseline)');
    return this.getStoreFeatures(storeId);
  }

  /**
   * Changes the store's plan. Per the 2026-05-27 architectural decision,
   * this does NOT touch StoreFeature rows — every existing override is
   * preserved across upgrade and downgrade. Returns the freshly resolved
   * feature map.
   */
  async setStorePlan(
    storeId: string,
    plan: StorePlan,
    userId: string
  ): Promise<Record<FeatureKey, boolean>> {
    await prisma.store.update({
      where: { id: storeId },
      data: { plan, updatedAt: new Date() },
    });
    await this.invalidateCache(storeId);
    logger.info(
      { storeId, plan, userId },
      '[FeatureService] Store plan changed (overrides preserved)'
    );
    return this.getStoreFeatures(storeId);
  }
}

// Singleton instance — matches pattern of other services
export const featureService = new FeatureService();
