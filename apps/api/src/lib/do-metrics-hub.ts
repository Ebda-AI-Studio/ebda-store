/**
 * Operator metrics across stores (Ruling DO-METRICS-1, option A): one allow-listed metric NAME is asked of every live store's Durable
 * Object (`doMetric`, packages/repo/src/do/do-metrics.ts) and only NUMBERS come back: a count per store and the total. The fan-out reuses
 * the platform hub (cap 500 stores, concurrency 8); a store that errors or exceeds the per-store timeout is reported in `failed`, never
 * fatal and never silently zero. Cache: BOUNDED-stale class, 60 s per metric set (residual window 60 s, an operator view, no money or
 * permission decision reads it); a kill switch (`DO_METRICS_ENABLED=false`) turns the whole path off.
 */
import { storeMoney } from './repo-factory';
import { hubFanout, hubFanoutStoreIds } from './platform-hub';

/**
 * The store-level metric names and docs, mirrored from packages/repo/src/do/do-metrics.ts (the API does not import @ebda/repo; the
 * StoreRepo interfaces are hand-copied in repo-factory.ts). tests/unit/do-metrics-hub.test.ts keeps the two EQUAL.
 */
export const STORE_METRIC_DOCS = {
  journal_unbalanced: 'Posted journal entries where total debit differs from total credit.',
  journal_unrepaired_in_window:
    "Paid orders (paid 10 min to 72 h ago) with no 'order' sale journal entry: the hourly repair will post them.",
  journal_unrepaired_stale:
    "Paid orders (paid over 72 h ago, after the store's first journal entry) with no 'order' sale entry: needs a person.",
  push_subscriptions_active:
    'Rows in push_subscriptions (devices that can currently receive a push).',
} as const;
export type DoMetricName = keyof typeof STORE_METRIC_DOCS;
export const DO_METRIC_NAMES = Object.keys(STORE_METRIC_DOCS) as DoMetricName[];

export const DO_METRICS_CACHE_MS = 60_000;
export const DO_METRICS_STORE_TIMEOUT_MS = 2_000;

/** Metrics that are not one SQL statement per store: computed here from a store metric, still numbers only. */
export const DERIVED_METRICS = {
  stores_with_push_enabled: {
    from: 'push_subscriptions_active' as DoMetricName,
    doc: 'Stores with at least one active push subscription.',
  },
} as const;
export type DerivedMetricName = keyof typeof DERIVED_METRICS;
export const ALL_METRIC_NAMES: string[] = [...DO_METRIC_NAMES, ...Object.keys(DERIVED_METRICS)];

export interface MetricResult {
  name: string;
  doc: string;
  total: number;
  /** One number per store that answered; `storeId` is an id, never a name or a person. */
  stores: Array<{ storeId: string; n: number }>;
  failed: string[];
  truncated: boolean;
  generatedAt: string;
}

const cache = new Map<string, { at: number; value: MetricResult }>();
export const clearDoMetricsCache = () => cache.clear();

export function doMetricsEnabled(): boolean {
  return process.env.DO_METRICS_ENABLED !== 'false';
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      v => (clearTimeout(t), resolve(v)),
      e => (clearTimeout(t), reject(e))
    );
  });

async function storeMetric(name: DoMetricName, now: () => number) {
  const { ids, truncated } = await hubFanoutStoreIds();
  const failed: string[] = [];
  const parts = await hubFanout(
    ids,
    async storeId => {
      const money = await storeMoney(storeId);
      // null = the store is not served by a Durable Object (Postgres): no DO data to count, reported as failed, never as zero.
      if (!money) throw new Error('not on a durable object');
      return (await withTimeout(money.doMetric({ name }), DO_METRICS_STORE_TIMEOUT_MS)).n;
    },
    storeId => void failed.push(storeId)
  );
  return {
    stores: parts.map(p => ({ storeId: p.storeId, n: p.value })),
    failed,
    truncated,
    at: now(),
  };
}

export async function readMetric(
  name: string,
  now: () => number = Date.now
): Promise<MetricResult> {
  const derived = Object.prototype.hasOwnProperty.call(DERIVED_METRICS, name)
    ? DERIVED_METRICS[name as DerivedMetricName]
    : undefined;
  const source = (derived ? derived.from : name) as DoMetricName;
  if (!derived && !Object.prototype.hasOwnProperty.call(STORE_METRIC_DOCS, name))
    throw new Error('unknown metric');
  const hit = cache.get(name);
  if (hit && now() - hit.at < DO_METRICS_CACHE_MS) return hit.value;
  const r = await storeMetric(source, now);
  const stores = derived
    ? r.stores.map(s => ({ storeId: s.storeId, n: s.n > 0 ? 1 : 0 }))
    : r.stores;
  const value: MetricResult = {
    name,
    doc: derived ? derived.doc : STORE_METRIC_DOCS[source],
    total: stores.reduce((a, s) => a + s.n, 0),
    stores: stores.filter(s => s.n > 0),
    failed: r.failed,
    truncated: r.truncated,
    generatedAt: new Date(r.at).toISOString(),
  };
  cache.set(name, { at: r.at, value });
  return value;
}
