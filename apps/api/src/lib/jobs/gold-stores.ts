/**
 * Which stores the two gold-rate crons look at, for either backend (INFRA-CF-1, Ruling CF-JOBS-4).
 * Postgres stores keep the SECURITY DEFINER functions (`goldFeedStores` / `goldRateWatch`, minus any store the job scope hides).
 * A store on its Durable Object is read from its own tables on its alarm: the alarm run is scoped to that one store.
 */
import { withStoreDb } from './store-db';
import { dropHiddenStores, storeDirectory } from '@ebda/database';
import { goldFeedStores, goldRateWatch } from '../definer';
import { storeRepo } from '../repo-factory';
import { platformDb } from '../platform-directory';
import { alarmStoreId } from './store-scope';

type Ev = { data?: unknown } | undefined;

/** Warn window: the same 240 minutes the definer subtracts from the store's max age. */
const WARN_WINDOW_MIN = 240;
const DEFAULT_MAX_AGE_MIN = 1560;

/** `Store` is a platform row: the definer only returns active, non-deleted stores. */
async function storeIsActive(storeId: string): Promise<boolean> {
  const s = await withStoreDb(storeId, db =>
    db.store.findUnique({ where: { id: storeId }, select: { status: true, deletedAt: true } })
  );
  return !!s && s.deletedAt === null && String(s.status) === 'active';
}

/** `demo`: a showroom store; the feed applies to it with no opt-in and no jump gate (nobody is there to confirm a pending rate). */
type Feed = { storeId: string; premiumBps: number; demo?: boolean };
type Watch = {
  storeId: string;
  karat: number;
  rateId: string;
  appliedAt: Date;
  maxAgeMinutes: number;
};

/** One DO store's feed opt-in (empty when it has not opted in, is inactive, or is not on its DO). */
async function feedForDoStore(storeId: string): Promise<Feed[] | undefined> {
  const repo = await storeRepo(storeId);
  if (repo.backend !== 'do') return undefined;
  const g = await repo.db.goldRateSettings.findUnique({
    where: { storeId },
    select: { enabled: true, feedEnabled: true, feedPremiumBps: true },
  });
  // A demo store ALWAYS rides the automatic rate (Ruling DEMO-GOLD-2): its settings row may be missing, manual or switched off
  // (a manual rate ages out after 26 h and pauses selling on the showroom), so the feed does not wait for an opt-in.
  const demo =
    (await repo.db.store.findUnique({ where: { id: storeId }, select: { isDemo: true } }))
      ?.isDemo === true;
  if (!demo && (!g || !g.enabled || !g.feedEnabled)) return [];
  if (!(await storeIsActive(storeId))) return [];
  return [
    { storeId, premiumBps: demo ? 0 : (g?.feedPremiumBps ?? 0), ...(demo ? { demo: true } : {}) },
  ];
}

/**
 * The cron run (no alarm store) once the platform D1 is bound (Ruling NZ-PG-2): the stores come from the D1 directory
 * (hidden-store scope applied, exactly as for the definer) and each is read from its own DO; the Postgres definers are not
 * called (Postgres is gone after the cutover, a Postgres store no longer exists).
 */
async function cronStoresOnD1<T>(
  read: (storeId: string) => Promise<T[] | undefined>
): Promise<T[]> {
  const stores = await storeDirectory(s => s.status === 'active');
  const out: T[] = [];
  for (const s of stores) out.push(...((await read(s.id)) ?? []));
  return out;
}

export async function goldFeedStoresFor(event: Ev): Promise<Feed[]> {
  const only = alarmStoreId(event);
  if (only) {
    const rows = await feedForDoStore(only);
    if (rows) return rows;
  } else if (platformDb()) {
    return cronStoresOnD1(feedForDoStore);
  }
  const rows = dropHiddenStores(await goldFeedStores(), r => r.storeId, 'goldFeedStores');
  return only ? rows.filter(r => r.storeId === only) : rows;
}

/** One DO store's (karat) pairs whose applied rate is inside the warn window or past max age (undefined: not on its DO). */
async function watchForDoStore(storeId: string, now: Date): Promise<Watch[] | undefined> {
  const repo = await storeRepo(storeId);
  if (repo.backend !== 'do') return undefined;
  const db = repo.db;
  const settings = await db.goldRateSettings.findUnique({
    where: { storeId },
    select: { maxAgeMinutes: true },
  });
  const maxAge = settings?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MIN;
  const since = new Date(now.getTime() - Math.max(maxAge - WARN_WINDOW_MIN, 0) * 60_000);
  const current = await db.goldRateCurrent.findMany({
    where: { storeId, appliedAt: { lte: since } },
    orderBy: { karat: 'asc' },
  });
  if (current.length === 0 || !(await storeIsActive(storeId))) return [];
  const out: Watch[] = [];
  for (const c of current) {
    // the store sells at least one gold-priced piece of this karat (a variant may carry its own karat)
    const sells = await db.product.findFirst({
      where: {
        storeId,
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
        storeId,
        karat: c.karat,
        rateId: c.rateId,
        appliedAt: c.appliedAt,
        maxAgeMinutes: maxAge,
      });
  }
  return out;
}

export async function goldRateWatchFor(event: Ev, now: Date = new Date()): Promise<Watch[]> {
  const only = alarmStoreId(event);
  if (only) {
    const rows = await watchForDoStore(only, now);
    if (rows) return rows;
  } else if (platformDb()) {
    return cronStoresOnD1(id => watchForDoStore(id, now));
  }
  const rows = dropHiddenStores(await goldRateWatch(), r => r.storeId, 'goldRateWatch');
  return only ? rows.filter(r => r.storeId === only) : rows;
}
