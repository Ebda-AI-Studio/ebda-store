/** Ruling DO-METRICS-1: the cross-store reader returns NUMBERS only, reports failures (never silent zeros), caches 60 s, derives the push metric. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DO_METRICS } from '../../packages/repo/src/do/do-metrics';

const counts: Record<string, number | 'throw' | 'null' | 'hang'> = {};
const calls: Array<{ id: string; name: string }> = [];
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeMoney: async (id: string) => {
    if (counts[id] === 'null') return null;
    return {
      doMetric: async ({ name }: { name: string }) => {
        calls.push({ id, name });
        const c = counts[id];
        if (c === 'throw') throw new Error('do down');
        if (c === 'hang') return new Promise(() => {});
        return { n: c ?? 0 };
      },
    };
  },
}));
vi.mock('../../apps/api/src/lib/platform-hub', () => ({
  hubFanoutStoreIds: async () => ({ ids: Object.keys(counts), truncated: false }),
  hubFanout: async (
    ids: string[],
    fn: (id: string) => Promise<unknown>,
    onError?: (id: string, e: unknown) => void
  ) => {
    const out: Array<{ storeId: string; value: unknown }> = [];
    for (const id of ids) {
      try {
        out.push({ storeId: id, value: await fn(id) });
      } catch (e) {
        onError?.(id, e);
      }
    }
    return out;
  },
}));

import {
  DERIVED_METRICS,
  DO_METRIC_NAMES,
  STORE_METRIC_DOCS,
  ALL_METRIC_NAMES,
  clearDoMetricsCache,
  doMetricsEnabled,
  readMetric,
} from '../../apps/api/src/lib/do-metrics-hub';

beforeEach(() => {
  for (const k of Object.keys(counts)) delete counts[k];
  calls.length = 0;
  clearDoMetricsCache();
});

describe('hub mirror of the DO allow-list', () => {
  it('names and docs equal packages/repo do-metrics (the API cannot import @ebda/repo)', () => {
    expect([...DO_METRIC_NAMES].sort()).toEqual(Object.keys(DO_METRICS).sort());
    for (const n of DO_METRIC_NAMES) expect(STORE_METRIC_DOCS[n]).toBe(DO_METRICS[n].doc);
  });
  it('every derived metric reads a store metric that exists', () => {
    for (const d of Object.values(DERIVED_METRICS)) expect(DO_METRIC_NAMES).toContain(d.from);
    expect(ALL_METRIC_NAMES).toContain('stores_with_push_enabled');
  });
});

describe('readMetric', () => {
  it('returns a total and a number per store with a non-zero value, and nothing else', async () => {
    Object.assign(counts, { a: 3, b: 0, c: 2 });
    const r = await readMetric('journal_unbalanced');
    expect(r.total).toBe(5);
    expect(r.stores).toEqual([
      { storeId: 'a', n: 3 },
      { storeId: 'c', n: 2 },
    ]);
    expect(Object.keys(r).sort()).toEqual([
      'doc',
      'failed',
      'generatedAt',
      'name',
      'stores',
      'total',
      'truncated',
    ]);
  });
  it('a store that errors, hangs past the timeout or is not on a DO is FAILED, never counted as zero', async () => {
    vi.useFakeTimers();
    Object.assign(counts, { a: 1, b: 'throw', c: 'null', d: 'hang' });
    const p = readMetric('journal_unbalanced');
    await vi.advanceTimersByTimeAsync(2_500);
    const r = await p;
    vi.useRealTimers();
    expect(r.failed.sort()).toEqual(['b', 'c', 'd']);
    expect(r.total).toBe(1);
  });
  it('caches for 60 s: a second read within the window asks no store, one after it asks again', async () => {
    Object.assign(counts, { a: 1 });
    let t = 1_000_000;
    await readMetric('journal_unrepaired', () => t);
    t += 59_000;
    await readMetric('journal_unrepaired', () => t);
    expect(calls).toHaveLength(1);
    t += 2_000;
    await readMetric('journal_unrepaired', () => t);
    expect(calls).toHaveLength(2);
  });
  it('stores_with_push_enabled counts stores with at least one subscription, asking the store metric', async () => {
    Object.assign(counts, { a: 7, b: 0, c: 1 });
    const r = await readMetric('stores_with_push_enabled');
    expect(r.total).toBe(2);
    expect(calls.every(c => c.name === 'push_subscriptions_active')).toBe(true);
  });
  it('refuses a name that is not on the list', async () => {
    await expect(readMetric('DROP TABLE orders')).rejects.toThrow('unknown metric');
    await expect(readMetric('__proto__')).rejects.toThrow('unknown metric');
  });
  it('kill switch: DO_METRICS_ENABLED=false turns it off, anything else leaves it on', () => {
    const was = process.env.DO_METRICS_ENABLED;
    process.env.DO_METRICS_ENABLED = 'false';
    expect(doMetricsEnabled()).toBe(false);
    delete process.env.DO_METRICS_ENABLED;
    expect(doMetricsEnabled()).toBe(true);
    if (was !== undefined) process.env.DO_METRICS_ENABLED = was;
  });
});

describe('route wiring', () => {
  const route = readFileSync(
    path.resolve(__dirname, '../../apps/api/src/routes/admin-do-metrics.routes.ts'),
    'utf8'
  );
  it('is super_admin + MFA, rate limited 10 per minute, audited, and gated by the kill switch', () => {
    expect(route).toContain("authenticate, requireMfaEnrolled, authorize('super_admin')");
    expect(route).toMatch(/windowMs: 60_000,\s*max: 10,/);
    expect(route).toContain("action: 'do_metrics.read'");
    expect(route).toContain('doMetricsEnabled()');
  });
  it('is mounted before the admin catch-all', () => {
    const idx = readFileSync(path.resolve(__dirname, '../../apps/api/src/routes/index.ts'), 'utf8');
    expect(idx.indexOf('adminDoMetricsRoutes)')).toBeGreaterThan(0);
    expect(idx.indexOf("router.use('/admin', adminDoMetricsRoutes)")).toBeLessThan(
      idx.indexOf("router.use('/admin', tenantContext, adminRoutes")
    );
  });
});
