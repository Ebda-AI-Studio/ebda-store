import { invalidateStoreProductCaches } from '../lib/public-cache';
import { Prisma, withStore } from '@ebda/database';
import { FeatureKey, FEATURE_KEYS_ARRAY, PLAN_BASELINE, type StorePlan } from '@ebda/shared';
import { redis } from './redis.service';
import { bustStoreCaches } from './store.service';
import logger from '../lib/logger';
import { retryOnWriteConflict } from '../lib/db-retry';
import { syncSubscriptionFromLegacyPlan } from './plan-sync';
import { getAutomationFlags } from './plan-entitlements';
import { readStorePlan } from '../lib/store-plan';
import { storeUpdate } from '../lib/repo-factory';

// Versioned namespace (2026-09-25, customer wallet D1). The release that wired
// behaviour to the previously hidden `customer_wallet` key also resets a stale
// enabled override for it to false (migration 20260925150000_customer_wallet).
// A map cached by the previous release would keep that `true` alive for up to
// CACHE_TTL after the reset, switching the wallet on for a live store; a new
// namespace guarantees the first read after deploy is resolved from the DB.
// One cold miss per store.
//
// `v3`, not `v2`: the email-campaigns release (PR #1939) bumps the same prefix
// to `features:store:v2:` for the same reason, and whichever of the two merges
// second must still land on a namespace the other never wrote. Any future
// release that repeats this shape bumps to the next unused version.
const CACHE_PREFIX = 'features:store:v3:';
const CACHE_TTL = 300; // 5 minutes

// Prisma's connection-level failures: P1001 "Can't reach database server",
// P1002 "timed out", P1017 "Server has closed the connection." On Neon's
// pooler these are transient — a dropped idle connection or a compute blip —
// and EBDA-API-2D / 2E were each a single one of them 500ing
// `GET /public/store/resolve` from inside `readFromDb`. One retry on a FRESH
// transaction (`withStore` opens its own when there is no ambient one, so a dead connection is not
// reused) absorbs them. Deliberately NOT a stale-value fallback: this map gates
// paid features, so a second failure still throws (fail closed) instead of
// serving a map that might say ON for something that was turned off.
const CONNECTION_FAILURE_CODES = ['P1001', 'P1002', 'P1017'];
const DB_READ_RETRY = {
  retries: 1,
  baseDelayMs: 100,
  extraRetryCodes: CONNECTION_FAILURE_CODES,
};

// Issue 1991: during a SUSTAINED outage the retry above doubled the connection
// attempts on the hottest read (store resolve, every add-to-cart) exactly when
// the database is struggling. After a read whose retry also failed on a
// connection error, retries are suspended for this window: every read still
// makes its ONE attempt (so recovery is seen at once — no fail-fast sentinel
// that would keep failing after the database is back), it just stops paying
// for a second one. Process-wide, not per store: the outage is.
const RETRY_SUSPEND_AFTER_OUTAGE_MS = 5_000;

function isConnectionFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; errorCode?: unknown };
  return [e.code, e.errorCode].some(
    c => typeof c === 'string' && CONNECTION_FAILURE_CODES.includes(c)
  );
}

class FeatureService {
  /**
   * In-process single-flight registry, keyed by storeId. When a store's
   * feature map is a cold miss on both the Redis cache AND this map, the
   * FIRST caller's `readFromDb()` + `writeToCache()` runs while every
   * concurrent caller for the SAME store awaits the same promise instead
   * of each issuing its own `Store` + `StoreFeature` DB read. Mirrors the
   * `inFlight` pattern in `lib/public-cache.ts` — this service predates
   * that helper and didn't reuse it, which left the one genuinely hot,
   * uncoalesced call site (`cart.service.ts`'s add-to-cart backorder
   * check) exposed to a TTL-boundary herd (M1, see
   * docs/audits/2026-07-13-cache-stampede.md).
   */
  private inFlight = new Map<string, Promise<Record<FeatureKey, boolean>>>();

  /** When a read last failed on a connection error AFTER its retry (issue 1991). */
  private connectionOutageAt = 0;

  // ==========================================
  // Cache Helpers
  // ==========================================

  private cacheKey(storeId: string): string {
    return `${CACHE_PREFIX}${storeId}`;
  }

  private async readFromCache(storeId: string): Promise<Record<FeatureKey, boolean> | null> {
    // In test environments, always read from DB. Integration tests write
    // StoreFeature rows directly via Prisma (bypassing the service's
    // invalidateCache call), so the Redis cache can hold stale values
    // across test cases within the same describe block. Skipping the
    // cache here keeps integration test assertions deterministic while
    // preserving the 300-second TTL in production.
    if (process.env.NODE_ENV === 'test') return null;
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
    rows: Array<{ featureKey: string; enabled: boolean }>,
    flags?: {
      abandonedCartAutomation: boolean;
      whatsappAutomation: boolean;
      brandingRemoval: boolean;
      apiAccess: boolean;
      wholesalePricing: boolean;
      mcpAccess: boolean;
      featureTier: StorePlan;
    } | null
  ): Record<FeatureKey, boolean> {
    // Start with all false.
    const map = Object.fromEntries(FEATURE_KEYS_ARRAY.map(key => [key, false])) as Record<
      FeatureKey,
      boolean
    >;
    // Layer 1: PLAN_BASELINE — what the plan includes by default. Keyed on the EFFECTIVE plan's tier from the
    // entitlements (a canceled subscription = free), not on `stores.plan`: that column is a directory mirror that a
    // canceled Growth store kept on `professional`, which left the whole Growth baseline on (#835, money-abuse S3).
    // `stores.plan` only decides when there is no plan decision at all (unknown store).
    const baseline = PLAN_BASELINE[flags?.featureTier ?? plan] ?? [];
    for (const key of baseline) {
      if (FEATURE_KEYS_ARRAY.includes(key as FeatureKey)) {
        map[key as FeatureKey] = true;
      }
    }
    // Layer 1.5: the plans engine's flags (SP5 automation + locked-pricing branding/API). They decide the
    // feature keys the engine names, both ways — a plan that turns the flag
    // on enables the feature, one that turns it off disables it — and sit
    // UNDER the per-store overrides so super-admin can still grant/revoke.
    if (flags) {
      map.abandoned_cart = flags.abandonedCartAutomation;
      // `whatsapp` (WhatsApp Business API integration) is deliberately NOT
      // derived from `flags.whatsappAutomation`: it is flagged OFF for every
      // plan (Ruling WHATSAPP-OFF-1, 2026-10-14) and only a StoreFeature
      // override (Layer 2) can turn it on. The plan limit itself stays in the
      // plans data for when the WhatsApp product launches.
      // Locked pricing (2026-10-05): branding removal -> Growth+Business;
      // merchant-admin MCP (keys, read tools, write tools) -> Growth + Business
      // (2026-10-14, decoupled from `apiAccess`; see planIncludesMerchantMcp).
      map.remove_branding = flags.brandingRemoval;
      // B2B wholesale pricing (Ruling B2B-1): Business + comped, decided by the plan limit.
      map['b2b.wholesale'] = flags.wholesalePricing;
      map.merchant_mcp = flags.mcpAccess;
      // The merchant's own write switch is `store.settings.mcpWriteEnabled`
      // (mcp/merchant-write.ts); a StoreFeature override still wins both ways.
      map.merchant_mcp_write = flags.mcpAccess;
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
    // store_features is under FORCE ROW LEVEL SECURITY. This map is read from
    // BOTH request handlers (with tenant context) AND background fan-out
    // (order-created / abandoned-cart Inngest jobs) which have no tenant GUC —
    // and without it the per-store override rows return empty, so a feature
    // enabled/disabled by override would be mis-resolved (and the wrong value
    // Redis-cached). Everything is read inside one store-scope tx.
    const [store, rows, flags] = await withStore(storeId, async tx => {
      const [storeRow, featureRows] = await Promise.all([
        readStorePlan(tx, storeId),
        tx.storeFeature.findMany({
          where: { storeId },
          select: { featureKey: true, enabled: true },
        }),
      ]);
      // The plans engine's automation flags, read in the SAME store-scope tx (one
      // connection; a transient failure retries and fails closed together).
      const planFlags = storeRow
        ? await getAutomationFlags(storeId, tx, { legacyPlan: storeRow.plan })
        : null;
      return [storeRow, featureRows, planFlags] as const;
    });
    // If the store doesn't exist, return all-false (safe default; callers
    // already handle missing stores at the route level via requireStoreAccess).
    if (!store) {
      return Object.fromEntries(FEATURE_KEYS_ARRAY.map(key => [key, false])) as Record<
        FeatureKey,
        boolean
      >;
    }
    return this.rowsToMap(store.plan as StorePlan, rows, flags);
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
      // B2B: the public product payload lists the public price tiers only while `b2b.wholesale` is on, so any change to the
      // resolved feature map (plan change, plan-limit edit, override) must also drop the cached public product payloads.
      await invalidateStoreProductCaches(storeId);
      logger.debug({ storeId }, '[FeatureService] Cache invalidated');
    } catch (err) {
      logger.warn({ err, storeId }, '[FeatureService] Cache invalidation failed (non-fatal)');
    }
  }

  /**
   * Bust the PUBLIC-facing store cache (`public:store:*`) after any change
   * that affects the resolved feature map. `enabledFeatures` is embedded in
   * the `/public/stores/:slugOrId` and `/public/store/resolve` payloads,
   * which are cached independently (120s TTL) of this service's own
   * `features:store:*` cache — `invalidateCache` above only busts the
   * latter. Without this, a super-admin feature toggle meant to be a <=300s
   * rollback lever could take up to that OTHER cache's TTL to reach
   * llms.txt / the storefront (audit-followup #1668). Best-effort, mirrors
   * `bustStoreCaches`'s own error handling: a Redis outage here must not
   * fail the admin write that already committed.
   */
  private async bustPublicStoreCache(storeId: string): Promise<void> {
    try {
      // `stores` is under RLS (R-EBDA-005): read in the store's own scope.
      const store = await withStore(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: { slug: true, domain: true },
        })
      );
      if (!store) return;
      await bustStoreCaches(storeId, store.slug, store.domain);
    } catch (err) {
      logger.warn({ err, storeId }, '[FeatureService] Public cache bust failed (non-fatal)');
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

    // 2. Cache miss — single-flight the DB read + cache populate so
    // concurrent callers for the SAME store share one `readFromDb()` call
    // (2 queries) instead of each running their own. A late waiter that
    // arrives after the fetch resolved re-reads the now-warm cache on its
    // next call.
    const existing = this.inFlight.get(storeId);
    if (existing) return existing;

    const pending = (async () => {
      logger.debug({ storeId }, '[FeatureService] Cache miss, reading from DB');
      const inOutage = Date.now() - this.connectionOutageAt < RETRY_SUSPEND_AFTER_OUTAGE_MS;
      let features: Record<FeatureKey, boolean>;
      try {
        features = await retryOnWriteConflict(() => this.readFromDb(storeId), {
          ...DB_READ_RETRY,
          retries: inOutage ? 0 : DB_READ_RETRY.retries,
          label: 'feature.readFromDb',
        });
      } catch (err) {
        // Still fails CLOSED (RULINGS SN-4) — this only stops the next reads
        // from paying for a retry while the outage lasts.
        if (isConnectionFailure(err)) this.connectionOutageAt = Date.now();
        throw err;
      }
      this.connectionOutageAt = 0;

      // 3. Populate cache (best-effort)
      await this.writeToCache(storeId, features);

      return features;
    })();

    this.inFlight.set(storeId, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(storeId);
    }
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
    // ONE store-scope section (a real transaction on Postgres; on the Worker the lazy scope routes `storeFeature` to the platform
    // D1). NOT `withMoneyTx(prisma, ...)`: that opens a Postgres interactive transaction, which no longer exists on the Worker
    // (POSTGRES_REMOVED: every toggle of a feature, incl. the customer-intelligence hints switch, answered 500).
    // On the platform D1 a multi-key update is NOT one transaction: if it throws after some keys were written the cached map no
    // longer matches the rows, so the cache key is dropped on failure (the next read rebuilds it from the rows).
    let freshFeatures: Record<FeatureKey, boolean>;
    try {
      freshFeatures = await withStore(storeId, async (tx: Prisma.TransactionClient) => {
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
        // Read plan + override rows through the SAME tx so the resolved map reflects the writes just made. The plan comes from
        // the store's own backend (a Durable Object store's record is its DO), as in `readFromDb`.
        const store = await readStorePlan(tx, storeId);
        const rows = await tx.storeFeature.findMany({
          where: { storeId },
          select: { featureKey: true, enabled: true },
        });
        const flags = await getAutomationFlags(storeId, tx, { legacyPlan: store?.plan ?? 'free' });
        return this.rowsToMap((store?.plan ?? 'free') as StorePlan, rows, flags);
      });
    } catch (err) {
      await this.invalidateCache(storeId);
      // the public storefront payload embeds `enabledFeatures`: drop it too, or it shows the old flags until its TTL
      await this.bustPublicStoreCache(storeId);
      throw err;
    }

    await this.writeToCache(storeId, freshFeatures);
    await this.bustPublicStoreCache(storeId);

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
    // Super-admin route, no ambient store scope: bind the target store (the caller already
    // passed requireStoreAccess) so the tenant guard and RLS see it.
    await withStore(storeId, tx =>
      tx.storeFeature
        .delete({ where: { storeId_featureKey: { storeId, featureKey } } })
        .catch(() => {
          // Row didn't exist — already at baseline. No-op.
        })
    );
    await this.invalidateCache(storeId);
    await this.bustPublicStoreCache(storeId);
    return this.getStoreFeatures(storeId);
  }

  /**
   * Deletes ALL StoreFeature override rows for the store, resetting
   * every feature to its plan baseline. Super-admin nuclear button.
   */
  async resetAllOverrides(storeId: string): Promise<Record<FeatureKey, boolean>> {
    await withStore(storeId, tx => tx.storeFeature.deleteMany({ where: { storeId } }));
    await this.invalidateCache(storeId);
    await this.bustPublicStoreCache(storeId);
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
    await withStore(storeId, tx =>
      storeUpdate(tx, {
        where: { id: storeId },
        data: { plan, updatedAt: new Date() },
      })
    );
    // Keep the subscription (limits) on the plan the enum now names (SP5).
    await withStore(storeId, tx => syncSubscriptionFromLegacyPlan(tx, storeId, plan));
    await this.invalidateCache(storeId);
    await this.bustPublicStoreCache(storeId);
    logger.info(
      { storeId, plan, userId },
      '[FeatureService] Store plan changed (overrides preserved)'
    );
    return this.getStoreFeatures(storeId);
  }
}

// Singleton instance — matches pattern of other services
export const featureService = new FeatureService();
