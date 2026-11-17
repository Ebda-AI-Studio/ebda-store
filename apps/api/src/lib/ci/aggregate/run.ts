/**
 * CI-2 aggregation over R2 `ebda-ci` (plan 3.1, Ruling CI-9). Reads a store's raw partitions for one UTC
 * day, writes the store's day file, rebuilds its 90-day window, then merges the windows of the stores
 * that opted in (`xstore`) into the cross-store cohort, suppressing every cell under the k-thresholds.
 *
 * Idempotent: every output is a pure function of the inputs with a stable key order, so a replay of the
 * same days rewrites identical bytes. Nothing reads or writes a buyer key (cells.ts never looks at one);
 * the cohort files carry no store id.
 */
import { gunzipText } from '../../../cf/erasure/surfaces';
import logger from '../../logger';
import { parseEnvelope, type CiEnvelope } from '../envelope';
import {
  CI_AGG_WINDOW_DAYS,
  ciCohortLatestKey,
  ciMetricAggKey,
  ciPartitionPrefix,
  ciStoreActivationKey,
  ciStoreAggPrefix,
  ciStoreDayAggKey,
  ciStoreWindowKey,
} from '../layout';
import type { CiBucket } from '../erase';
import {
  METRICS,
  addDays,
  emptyCells,
  foldStoreDay,
  mergeCells,
  sortCells,
  type Cell,
  type Cells,
  type Metric,
  type StoreDay,
} from './cells';
import { assertAggregateOnly } from './guard';
import { foldActivation, type ActivationFile } from './activation-file';

/** Cross-store k-thresholds (plan 4.1). Cells under them are written as `{ suppressed: true }` only. */
export const COHORT_MIN_N = 100;
export const COHORT_MIN_STORES = 5;
export const COHORT_MAX_STORE_SHARE = 0.4;

export interface StoreWindow {
  v: 1;
  storeId: string;
  asOf: string;
  windowDays: number;
  own: Cells;
  shared: Cells;
}
export type CohortCell = { n: number; hit: number; sum: number; stores: number; maxShare: number };
export type PublishedCell = CohortCell | { suppressed: true };
export interface Cohort {
  v: 1;
  asOf: string;
  windowDays: number;
  metrics: Record<Metric, Record<string, PublishedCell>>;
}

const json = (v: unknown) => JSON.stringify(v);

async function listAll(ci: CiBucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await ci.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Every parseable envelope in a store's partitions for a day. An unparseable line is skipped and counted, never fatal. */
export async function readStoreDayEvents(
  ci: CiBucket,
  storeId: string,
  day: string
): Promise<{ events: CiEnvelope[]; skipped: number }> {
  const events: CiEnvelope[] = [];
  let skipped = 0;
  for (const key of await listAll(ci, ciPartitionPrefix(storeId, day))) {
    if (!key.endsWith('.ndjson.gz')) continue;
    const obj = await ci.get(key);
    if (!obj) continue;
    for (const line of (await gunzipText(await obj.arrayBuffer())).split('\n')) {
      if (!line) continue;
      try {
        events.push(parseEnvelope(JSON.parse(line)));
      } catch {
        skipped += 1;
      }
    }
  }
  return { events, skipped };
}

export async function aggregateStoreDay(
  ci: CiBucket,
  storeId: string,
  day: string
): Promise<{ file: StoreDay; skipped: number; events: CiEnvelope[] }> {
  const { events, skipped } = await readStoreDayEvents(ci, storeId, day);
  const file = foldStoreDay(storeId, day, events);
  await ci.put(ciStoreDayAggKey(storeId, day), json(file));
  return { file, skipped, events };
}

/** Folds the days' events into the store's activation file: 1 get + 1 put, and no put when nothing changed. */
async function updateActivation(
  ci: CiBucket,
  storeId: string,
  events: CiEnvelope[]
): Promise<void> {
  if (events.length === 0) return;
  const key = ciStoreActivationKey(storeId);
  const obj = await ci.get(key);
  const prev = obj ? (JSON.parse(await obj.text()) as ActivationFile) : null;
  const next = json(foldActivation(prev, storeId, events));
  if (!prev || json(prev) !== next) await ci.put(key, next);
}

export async function rebuildWindow(
  ci: CiBucket,
  storeId: string,
  asOf: string
): Promise<StoreWindow> {
  const own = emptyCells();
  const shared = emptyCells();
  // ONE list of the store's aggregate prefix, then a get for each day file that really exists in the
  // window: a store with 3 days of history costs 4 reads, not 91 (Ruling CI-14).
  const have = new Set(await listAll(ci, ciStoreAggPrefix(storeId)));
  for (let i = 0; i < CI_AGG_WINDOW_DAYS; i++) {
    const key = ciStoreDayAggKey(storeId, addDays(asOf, -i));
    if (!have.has(key)) continue;
    const obj = await ci.get(key);
    if (!obj) continue;
    const d = JSON.parse(await obj.text()) as StoreDay;
    mergeCells(own, d.own);
    mergeCells(shared, d.shared);
  }
  const w: StoreWindow = {
    v: 1,
    storeId,
    asOf,
    windowDays: CI_AGG_WINDOW_DAYS,
    own: sortCells(own),
    shared: sortCells(shared),
  };
  await ci.put(ciStoreWindowKey(storeId), json(w));
  return w;
}

/**
 * The cohort fold, split so it can run in chunks (Ruling CI-14): `accumulateWindows` is the part that
 * touches R2 (one get per store window) and returns a plain, JSON-safe partial; `mergeAccs` adds partials;
 * `finalizeCohort` applies the k-thresholds. `buildCohort` is all three on windows already in memory.
 */
export type CohortAcc = Record<
  string,
  Record<string, { n: number; hit: number; sum: number; perStore: number[] }>
>;

export function accumulateWindows(windows: StoreWindow[]): CohortAcc {
  const acc: CohortAcc = {};
  for (const m of METRICS) {
    const byKey: CohortAcc[string] = (acc[m] = {});
    for (const w of windows) {
      for (const [key, c] of Object.entries(w.shared[m] ?? {})) {
        const a = (byKey[key] ??= { n: 0, hit: 0, sum: 0, perStore: [] });
        a.n += c.n;
        a.hit += c.hit;
        a.sum += c.sum;
        a.perStore.push(c.n);
      }
    }
  }
  return acc;
}

export function mergeAccs(parts: CohortAcc[]): CohortAcc {
  const out: CohortAcc = {};
  for (const m of METRICS) {
    const byKey: CohortAcc[string] = (out[m] = {});
    for (const part of parts) {
      for (const [key, c] of Object.entries(part[m] ?? {})) {
        const a = (byKey[key] ??= { n: 0, hit: 0, sum: 0, perStore: [] });
        a.n += c.n;
        a.hit += c.hit;
        a.sum += c.sum;
        a.perStore.push(...c.perStore);
      }
    }
  }
  return out;
}

/** One get per store (missing = a store with no window yet, skipped). At most `windowIds.length` R2 reads. */
export async function readWindowsAcc(ci: CiBucket, storeIds: string[]): Promise<CohortAcc> {
  const windows: StoreWindow[] = [];
  for (const id of storeIds) {
    const obj = await ci.get(ciStoreWindowKey(id));
    if (obj) windows.push(JSON.parse(await obj.text()) as StoreWindow);
  }
  return accumulateWindows(windows);
}

/** Apply the k-thresholds to an accumulated cohort; every cell under them is `{ suppressed: true }` only. */
export function finalizeCohort(acc: CohortAcc, asOf: string): Cohort {
  const metrics = {} as Cohort['metrics'];
  for (const m of METRICS) {
    const out: Record<string, PublishedCell> = {};
    const byKey = acc[m] ?? {};
    for (const key of Object.keys(byKey).sort()) {
      const { n, hit, sum, perStore } = byKey[key]!;
      const maxShare = Math.max(...perStore) / n;
      out[key] =
        n >= COHORT_MIN_N &&
        perStore.length >= COHORT_MIN_STORES &&
        maxShare <= COHORT_MAX_STORE_SHARE
          ? {
              n,
              hit,
              sum: Math.round(sum * 100) / 100,
              stores: perStore.length,
              maxShare: Math.round(maxShare * 1000) / 1000,
            }
          : { suppressed: true };
    }
    metrics[m] = out;
  }
  return { v: 1, asOf, windowDays: CI_AGG_WINDOW_DAYS, metrics };
}

/** Merge the opted-in stores' `shared` windows; suppress every cell under the k-thresholds. */
export function buildCohort(windows: StoreWindow[], asOf: string): Cohort {
  return finalizeCohort(accumulateWindows(windows), asOf);
}

export async function publishCohort(ci: CiBucket, cohort: Cohort): Promise<void> {
  assertAggregateOnly(cohort);
  for (const m of METRICS) {
    await ci.put(
      ciMetricAggKey(m, cohort.asOf),
      json({
        v: 1,
        metric: m,
        asOf: cohort.asOf,
        windowDays: cohort.windowDays,
        cells: cohort.metrics[m],
      })
    );
  }
  await ci.put(ciCohortLatestKey, json(cohort));
}

export interface AggregationResult {
  stores: number;
  days: string[];
  skippedLines: number;
  cohortCells: number;
  suppressedCells: number;
}

/**
 * R2 calls one store may make in one run (Ruling CI-14). A Worker invocation allows 1000 subrequests, so
 * the daily job runs ONE STORE PER STEP and every step is held to this budget. Typical cost: 2 days x
 * (1 list + the batch objects + 1 put) + 1 list + the day files that exist (<= 90) + 1 put, about 100 at
 * full history and about 10 for a new store.
 */
export const MAX_R2_CALLS_PER_STORE = 400;
export class CiBudgetExceeded extends Error {}

/** Counts every call and throws past `limit`, so a runaway store fails loudly instead of killing the Worker. */
export function budgeted(
  ci: CiBucket,
  limit = MAX_R2_CALLS_PER_STORE
): { ci: CiBucket; calls: () => number } {
  let calls = 0;
  const hit = () => {
    if (++calls > limit) throw new CiBudgetExceeded(`more than ${limit} R2 calls for one store`);
  };
  const wrapped = {
    get: async (...a: Parameters<CiBucket['get']>) => {
      hit();
      return ci.get(...a);
    },
    put: async (...a: Parameters<CiBucket['put']>) => {
      hit();
      return ci.put(...a);
    },
    list: async (...a: Parameters<CiBucket['list']>) => {
      hit();
      return ci.list(...a);
    },
    delete: async (...a: Parameters<CiBucket['delete']>) => {
      hit();
      return ci.delete(...a);
    },
  } as unknown as CiBucket;
  return { ci: wrapped, calls: () => calls };
}

/** One store, one run: fold `days` into day files, rebuild its window. Throws if the store fails. */
export async function aggregateStore(
  ci: CiBucket,
  storeId: string,
  days: string[]
): Promise<{ skippedLines: number; r2Calls: number }> {
  const b = budgeted(ci);
  let skippedLines = 0;
  const events: CiEnvelope[] = [];
  for (const day of days) {
    const r = await aggregateStoreDay(b.ci, storeId, day);
    skippedLines += r.skipped;
    events.push(...r.events);
  }
  await updateActivation(b.ci, storeId, events);
  await rebuildWindow(b.ci, storeId, days.at(-1)!);
  return { skippedLines, r2Calls: b.calls() };
}

/** The cohort from the stores' windows, read in chunks of `chunk` (<= `chunk` R2 reads each), then published. */
export async function publishCohortFor(
  ci: CiBucket,
  storeIds: string[],
  asOf: string,
  chunk = COHORT_READ_CHUNK
): Promise<Cohort> {
  const parts: CohortAcc[] = [];
  for (let i = 0; i < storeIds.length; i += chunk) {
    parts.push(await readWindowsAcc(ci, storeIds.slice(i, i + chunk)));
  }
  const cohort = finalizeCohort(mergeAccs(parts), asOf);
  await publishCohort(ci, cohort);
  return cohort;
}
/** Windows read per cohort step: well under the 1000-subrequest limit. */
export const COHORT_READ_CHUNK = 400;

/**
 * The daily run in one process (tests, scripts). `days` are the UTC days to (re)fold, oldest first; `asOf`
 * (the newest) is the window end. A store that throws is logged and left out of the cohort for this run; the
 * next run rebuilds it. The Inngest job calls `aggregateStore` / `publishCohortFor` itself, one step each.
 */
export async function runCiAggregation(
  ci: CiBucket,
  storeIds: string[],
  days: string[]
): Promise<AggregationResult & { failed: string[] }> {
  const asOf = days.at(-1)!;
  const done: string[] = [];
  const failed: string[] = [];
  let skippedLines = 0;
  for (const storeId of storeIds) {
    try {
      skippedLines += (await aggregateStore(ci, storeId, days)).skippedLines;
      done.push(storeId);
    } catch (err) {
      logger.error({ err, storeId }, '[ci-agg] store aggregation failed');
      failed.push(storeId);
    }
  }
  const cohort = await publishCohortFor(ci, done, asOf);
  const cells = METRICS.flatMap(m => Object.values(cohort.metrics[m]));
  return {
    stores: done.length,
    days,
    skippedLines,
    cohortCells: cells.length,
    suppressedCells: cells.filter(c => 'suppressed' in c).length,
    failed,
  };
}
