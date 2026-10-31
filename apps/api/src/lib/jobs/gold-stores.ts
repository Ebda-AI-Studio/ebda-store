/**
 * Which stores the two gold-rate crons look at, for either backend (INFRA-CF-1, Ruling CF-JOBS-4).
 * Postgres stores keep the SECURITY DEFINER functions (`goldFeedStores` / `goldRateWatch`, minus any store the job scope hides).
 * A store on its Durable Object is read from its own tables on its alarm: the alarm run is scoped to that one store.
 */
import { dropHiddenStores, withStore } from '@ebda/database';
import { goldFeedStores, goldRateWatch } from '../definer';
import { storeRepo } from '../repo-factory';
import { alarmStoreId } from './store-scope';

type Ev = { data?: unknown } | undefined;

/** Warn window: the same 240 minutes the definer subtracts from the store's max age. */
const WARN_WINDOW_MIN = 240;
const DEFAULT_MAX_AGE_MIN = 1560;

/** `Store` is a platform row: the definer only returns active, non-deleted stores. */
async function storeIsActive(storeId: string): Promise<boolean> {
  const s = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { status: true, deletedAt: true } })
  );
  return !!s && s.deletedAt === null && String(s.status) === 'active';
}

export async function goldFeedStoresFor(
  event: Ev
): Promise<Array<{ storeId: string; premiumBps: number }>> {
  const only = alarmStoreId(event);
  if (only) {
    const repo = await storeRepo(only);
    if (repo.backend === 'do') {
      const g = await repo.db.goldRateSettings.findUnique({
        where: { storeId: only },
        select: { enabled: true, feedEnabled: true, feedPremiumBps: true },
      });
      if (!g || !g.enabled || !g.feedEnabled || !(await storeIsActive(only))) return [];
      return [{ storeId: only, premiumBps: g.feedPremiumBps }];
    }
  }
  const rows = dropHiddenStores(await goldFeedStores(), r => r.storeId, 'goldFeedStores');
  return only ? rows.filter(r => r.storeId === only) : rows;
}

export async function goldRateWatchFor(
  event: Ev,
  now: Date = new Date()
): Promise<
  Array<{ storeId: string; karat: number; rateId: string; appliedAt: Date; maxAgeMinutes: number }>
> {
  const only = alarmStoreId(event);
  if (only) {
    const repo = await storeRepo(only);
    if (repo.backend === 'do') {
      const db = repo.db;
      const settings = await db.goldRateSettings.findUnique({
        where: { storeId: only },
        select: { maxAgeMinutes: true },
      });
      const maxAge = settings?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MIN;
      const since = new Date(now.getTime() - Math.max(maxAge - WARN_WINDOW_MIN, 0) * 60_000);
      const current = await db.goldRateCurrent.findMany({
        where: { storeId: only, appliedAt: { lte: since } },
        orderBy: { karat: 'asc' },
      });
      if (current.length === 0 || !(await storeIsActive(only))) return [];
      const out = [];
      for (const c of current) {
        // the store sells at least one gold-priced piece of this karat (a variant may carry its own karat)
        const sells = await db.product.findFirst({
          where: {
            storeId: only,
            pricingMode: 'gold_rate',
            deletedAt: null,
            status: 'active',
            OR: [
              { goldKarat: c.karat },
              {
                variants: {
                  some: {
                    goldKarat: c.karat,
                    OR: [{ pricingMode: null }, { pricingMode: { not: 'fixed' } }],
                  },
                },
              },
            ],
          },
          select: { id: true },
        });
        if (sells)
          out.push({
            storeId: only,
            karat: c.karat,
            rateId: c.rateId,
            appliedAt: c.appliedAt,
            maxAgeMinutes: maxAge,
          });
      }
      return out;
    }
  }
  const rows = dropHiddenStores(await goldRateWatch(), r => r.storeId, 'goldRateWatch');
  return only ? rows.filter(r => r.storeId === only) : rows;
}
