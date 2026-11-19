/**
 * Is this store a showroom (`stores.is_demo`)? One read, shared by the two places that must stay silent for a demo:
 * `EmailService.sendMerchantNotice` (no merchant mail to a demo store's owner) and `sendAlert` (no store-scoped alert for a demo).
 * A demo takes no orders and has no merchant to notify; its owner is the operator's own address (2026-11-05: the Dahab showroom
 * mailed "selling paused" to Ahmad).
 *
 * Staleness class: BOUNDED-stale. `isDemo` is set at provisioning and never flipped at runtime, so a 5-minute per-isolate cache
 * is safe (worst case after an operator flips it by hand: 5 minutes of the old behaviour). It fails OPEN to "not a demo" on a
 * read error, so a real merchant never loses a notice because the lookup threw.
 */
import { storeRepo } from './repo-factory';
import { withStore } from '@ebda/database';
import logger from './logger';

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { demo: boolean; at: number }>();

export function clearDemoStoreCache(): void {
  cache.clear();
}

export async function isDemoStore(storeId: string): Promise<boolean> {
  const hit = cache.get(storeId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.demo;
  try {
    const query = { where: { id: storeId }, select: { isDemo: true } } as const;
    const repo = await storeRepo(storeId);
    const row =
      repo.backend === 'do'
        ? await repo.db.store.findUnique(query)
        : await withStore(storeId, tx => tx.store.findUnique(query));
    const demo = row?.isDemo === true;
    cache.set(storeId, { demo, at: Date.now() });
    return demo;
  } catch (err) {
    logger.warn({ err, storeId }, 'isDemoStore: lookup failed, treating as a real store');
    return false;
  }
}

/** Seeded showroom orders carry this order-number prefix (DEMO-<n>); they are 0.00 "Delivered" fixtures, never trading. */
const DEMO_ORDER_PREFIX = 'DEMO-';

/**
 * Ruling STOREQA-2: the one rule for "does this order count in a platform KPI / recent-orders card" - it belongs to the store
 * and is not a seeded DEMO- order. Showroom STORES are skipped by the caller via `isDemoStore`. Data is never deleted, only excluded.
 */
export function platformKpiOrderWhere(storeId: string) {
  return { storeId, NOT: { orderNumber: { startsWith: DEMO_ORDER_PREFIX } } } as const;
}
