/**
 * Loads the aggregates the hints read: the store's own 90-day window and the opted-in cohort, from R2.
 * Staleness class BOUNDED-stale: the files change once a day, so each is cached in-process for 5 minutes
 * (a hint can be at most 5 minutes behind a fresh run, on top of the 7-day freshness rule in
 * thresholds.ts). Nothing here is permissions or money. A missing binding or object is `null`, which the
 * hint functions render as "not enough data yet".
 */
import { cfBindings } from '../../../cf/bindings';
import { BoundedMap } from '../../bounded-map';
import logger from '../../logger';
import type { CiBucket } from '../erase';
import { ciCohortLatestKey, ciStoreWindowKey } from '../layout';
import type { Cohort, StoreWindow } from '../aggregate/run';
import type { HintData } from './thresholds';

const TTL_MS = 5 * 60_000;
const cache = new BoundedMap<string, { at: number; value: unknown }>(512);

/** Test seam. */
export const clearHintDataCache = () => cache.clear();

async function readJson<T>(ci: CiBucket, key: string, now: number): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value as T | null;
  let value: T | null = null;
  try {
    const o = await ci.get(key);
    value = o ? (JSON.parse(await o.text()) as T) : null;
  } catch (err) {
    logger.warn({ err, key }, '[ci-hints] could not read an aggregate');
    return null; // not cached: the next call retries
  }
  cache.set(key, { at: now, value });
  return value;
}

export async function loadHintData(
  storeId: string,
  now: Date = new Date(),
  ci: CiBucket | undefined = cfBindings()?.CI_BUCKET as unknown as CiBucket | undefined
): Promise<HintData> {
  if (!ci) return { window: null, cohort: null, now };
  const [window, cohort] = await Promise.all([
    readJson<StoreWindow>(ci, ciStoreWindowKey(storeId), now.getTime()),
    readJson<Cohort>(ci, ciCohortLatestKey, now.getTime()),
  ]);
  // A window is read by the key of the requesting store; refuse one that names another (tenant resolver throws).
  if (window && window.storeId !== storeId)
    throw new Error('CI window does not belong to this store');
  return { window, cohort, now };
}
