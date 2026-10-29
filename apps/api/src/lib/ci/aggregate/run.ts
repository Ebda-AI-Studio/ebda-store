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
): Promise<{ file: StoreDay; skipped: number }> {
  const { events, skipped } = await readStoreDayEvents(ci, storeId, day);
  const file = foldStoreDay(storeId, day, events);
  await ci.put(ciStoreDayAggKey(storeId, day), json(file));
  return { file, skipped };
}

export async function rebuildWindow(
  ci: CiBucket,
  storeId: string,
  asOf: string
): Promise<StoreWindow> {
  const own = emptyCells();
  const shared = emptyCells();
  for (let i = 0; i < CI_AGG_WINDOW_DAYS; i++) {
    const obj = await ci.get(ciStoreDayAggKey(storeId, addDays(asOf, -i)));
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

/** Merge the opted-in stores' `shared` windows; suppress every cell under the k-thresholds. */
export function buildCohort(windows: StoreWindow[], asOf: string): Cohort {
  const metrics = {} as Cohort['metrics'];
  for (const m of METRICS) {
    const acc = new Map<string, { cell: Cell; perStore: number[] }>();
    for (const w of windows) {
      for (const [key, c] of Object.entries(w.shared[m])) {
        const a = acc.get(key) ?? {
          cell: { n: 0, hit: 0, sum: 0, first: c.first, last: c.last },
          perStore: [],
        };
        a.cell.n += c.n;
        a.cell.hit += c.hit;
        a.cell.sum += c.sum;
        a.perStore.push(c.n);
        acc.set(key, a);
      }
    }
    const out: Record<string, PublishedCell> = {};
    for (const key of [...acc.keys()].sort()) {
      const { cell, perStore } = acc.get(key)!;
      const maxShare = Math.max(...perStore) / cell.n;
      out[key] =
        cell.n >= COHORT_MIN_N &&
        perStore.length >= COHORT_MIN_STORES &&
        maxShare <= COHORT_MAX_STORE_SHARE
          ? {
              n: cell.n,
              hit: cell.hit,
              sum: Math.round(cell.sum * 100) / 100,
              stores: perStore.length,
              maxShare: Math.round(maxShare * 1000) / 1000,
            }
          : { suppressed: true };
    }
    metrics[m] = out;
  }
  return { v: 1, asOf, windowDays: CI_AGG_WINDOW_DAYS, metrics };
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
 * The daily run. `days` are the UTC days to (re)fold, oldest first; `asOf` (the newest) is the window end.
 * A store that throws is logged and left out of the cohort for this run; the next run rebuilds it.
 */
export async function runCiAggregation(
  ci: CiBucket,
  storeIds: string[],
  days: string[]
): Promise<AggregationResult & { failed: string[] }> {
  const asOf = days.at(-1)!;
  const windows: StoreWindow[] = [];
  const failed: string[] = [];
  let skippedLines = 0;
  for (const storeId of storeIds) {
    try {
      for (const day of days) skippedLines += (await aggregateStoreDay(ci, storeId, day)).skipped;
      windows.push(await rebuildWindow(ci, storeId, asOf));
    } catch (err) {
      logger.error({ err, storeId }, '[ci-agg] store aggregation failed');
      failed.push(storeId);
    }
  }
  const cohort = buildCohort(windows, asOf);
  await publishCohort(ci, cohort);
  const cells = METRICS.flatMap(m => Object.values(cohort.metrics[m]));
  return {
    stores: windows.length,
    days,
    skippedLines,
    cohortCells: cells.length,
    suppressedCells: cells.filter(c => 'suppressed' in c).length,
    failed,
  };
}
