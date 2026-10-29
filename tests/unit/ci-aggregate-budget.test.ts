/**
 * CI-14: the daily aggregation fans out per store and every step stays far under a Worker's 1000
 * subrequests. Asserts a CEILING on R2 calls per store per run (full 90-day history, a new store, a dead
 * store), the hard per-store budget, the chunked cohort read, and that the job runs one step per store.
 */
import { describe, expect, it, vi } from 'vitest';

const dir = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('@ebda/database', () => ({
  storeDirectory: async () => dir.ids.map(id => ({ id })),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/services/ci-insights.service', () => ({
  saveInsights: vi.fn(async () => ({ created: 0, refreshed: 0 })),
}));
vi.mock('../../apps/api/src/services/ci-calibration.service', () => ({ runCalibration: vi.fn() }));

import { buildEnvelope } from '../../apps/api/src/lib/ci/port';
import { METRICS, addDays } from '../../apps/api/src/lib/ci/aggregate/cells';
import {
  CiBudgetExceeded,
  COHORT_READ_CHUNK,
  MAX_R2_CALLS_PER_STORE,
  aggregateStore,
  budgeted,
  publishCohortFor,
} from '../../apps/api/src/lib/ci/aggregate/run';
import { runDailyCiAggregation } from '../../apps/api/src/lib/inngest/functions/ci-aggregation';
import {
  ciCohortLatestKey,
  ciPartitionPrefix,
  ciStoreDayAggKey,
} from '../../apps/api/src/lib/ci/layout';
import { gzipText } from '../../apps/api/src/cf/erasure/surfaces';
import { FakeR2 } from '../helpers/fake-r2';

const NOW = new Date('2026-11-10T04:00:00Z'); // yesterday = 2026-11-09, days = [11-08, 11-09]
const DAYS = ['2026-11-08', '2026-11-09'];
const sid = (i: number) => `0d8ea0f4-5a47-4c7d-9a49-${String(i).padStart(12, '0')}`;
let seq = 0;

/** A recording R2: counts every call that reaches the bucket. */
class CountingR2 extends FakeR2 {
  calls = 0;
  async get(k: string) {
    this.calls++;
    return super.get(k);
  }
  async put(k: string, v: string | Uint8Array | ArrayBuffer, o?: never) {
    this.calls++;
    return super.put(k, v, o);
  }
  async list(o?: { prefix?: string }) {
    this.calls++;
    return super.list(o);
  }
}

async function batch(r2: FakeR2, store: string, day: string, objects: number) {
  for (let b = 0; b < objects; b++) {
    const lines: string[] = [];
    for (let i = 0; i < 4; i++) {
      const orderId = `5c1d3a22-7b41-4d0e-9b53-${String(++seq).padStart(12, '0')}`;
      const env = await buildEnvelope(
        {
          type: 'shipment.delivered',
          seed: `${orderId}:${day}`,
          occurredAt: new Date(`${day}T10:00:00Z`),
          storeId: store,
          orderId,
          buyerKey: null,
          xstore: true,
          data: {
            carrier: 'bosta',
            codMinor: 30_000,
            hoursSincePickup: 20,
            attempts: 1,
            areaKey: 'EG-C-nasr-city',
          },
        },
        'store',
        new Date(`${day}T10:00:00Z`)
      );
      lines.push(JSON.stringify(env));
    }
    await r2.put(
      `${ciPartitionPrefix(store, day)}b${b}.ndjson.gz`,
      await gzipText(lines.join('\n') + '\n')
    );
  }
}
/** 88 older day files (what a store with a full window already has) + the fresh partitions of the run's 2 days. */
async function fullHistoryStore(r2: FakeR2, store: string) {
  for (let i = 2; i < 90; i++) {
    await r2.put(
      ciStoreDayAggKey(store, addDays('2026-11-09', -i)),
      JSON.stringify({ v: 1, storeId: store, day: 'x', own: {}, shared: {} })
    );
  }
  for (const d of DAYS) await batch(r2, store, d, 3);
}

describe('R2 calls per store per run (ceiling)', () => {
  it('a store with a FULL 90-day history stays under 110 calls, far below the 400 budget and the 1000 limit', async () => {
    const r2 = new CountingR2();
    await fullHistoryStore(r2, sid(1));
    r2.calls = 0;
    const out = await aggregateStore(r2 as never, sid(1), DAYS);
    // 2 days x (1 list + 3 batch gets + 1 put) + 1 list + 90 day-file gets + 1 window put = 102
    expect(r2.calls).toBe(out.r2Calls);
    expect(out.r2Calls).toBeLessThanOrEqual(110);
    expect(out.r2Calls).toBeLessThan(MAX_R2_CALLS_PER_STORE);
  });

  it('a NEW store costs about 10, not about 100 (only the day files that exist are read)', async () => {
    const r2 = new CountingR2();
    for (const d of DAYS) await batch(r2, sid(2), d, 1);
    r2.calls = 0;
    const out = await aggregateStore(r2 as never, sid(2), DAYS);
    expect(out.r2Calls).toBeLessThanOrEqual(12);
  });

  it('a store with no data at all costs a handful of calls', async () => {
    const r2 = new CountingR2();
    const out = await aggregateStore(r2 as never, sid(3), DAYS);
    expect(out.r2Calls).toBeLessThanOrEqual(8);
  });

  it('the budget guard fails the store loudly past its limit instead of letting the Worker die', async () => {
    const r2 = new CountingR2();
    const b = budgeted(r2 as never, 3);
    await b.ci.list({ prefix: 'a' });
    await b.ci.list({ prefix: 'b' });
    await b.ci.list({ prefix: 'c' });
    await expect(b.ci.list({ prefix: 'd' })).rejects.toBeInstanceOf(CiBudgetExceeded);
    expect(r2.calls).toBe(3); // the 4th never reached R2
  });
});

describe('cohort read is chunked', () => {
  it('reads at most `chunk` windows per step and gives the same cohort as one big read', async () => {
    const r2 = new CountingR2();
    for (let i = 10; i < 17; i++) {
      await batch(r2, sid(i), '2026-11-09', 1);
      await aggregateStore(r2 as never, sid(i), ['2026-11-09']);
    }
    const stores = Array.from({ length: 7 }, (_, i) => sid(10 + i));
    const big = await publishCohortFor(r2 as never, stores, '2026-11-09', 1000);
    const bigBytes = new TextDecoder().decode(r2.objs.get(ciCohortLatestKey)!.body);
    r2.calls = 0;
    const small = await publishCohortFor(r2 as never, stores, '2026-11-09', 2);
    expect(r2.calls).toBe(7 + METRICS.length + 1); // 7 window reads + one file per metric + latest.json
    expect(JSON.stringify(small)).toBe(JSON.stringify(big));
    expect(new TextDecoder().decode(r2.objs.get(ciCohortLatestKey)!.body)).toBe(bigBytes);
    expect(COHORT_READ_CHUNK).toBeLessThanOrEqual(400);
  });
});

describe('runDailyCiAggregation fan-out', () => {
  it('runs ONE step per store (each within the budget), then chunked cohort reads, then publish', async () => {
    const r2 = new CountingR2();
    dir.ids = Array.from({ length: 6 }, (_, i) => sid(30 + i));
    for (const s of dir.ids) for (const d of DAYS) await batch(r2, s, d, 2);
    const steps: Array<{ id: string; calls: number }> = [];
    const step = async <T>(id: string, fn: () => Promise<T>) => {
      const before = r2.calls;
      const out = await fn();
      steps.push({ id, calls: r2.calls - before });
      return out;
    };
    const res = await runDailyCiAggregation(NOW, r2 as never, step);
    expect(res).toMatchObject({ skipped: false, stores: 6, failed: [] });

    const storeSteps = steps.filter(s => s.id.startsWith('store-'));
    expect(storeSteps.map(s => s.id)).toEqual(dir.ids.map(id => `store-${id}`));
    for (const s of steps) expect(s.calls, s.id).toBeLessThan(MAX_R2_CALLS_PER_STORE);
    expect(steps.map(s => s.id)).toEqual([
      'list-stores',
      ...storeSteps.map(s => s.id),
      'cohort-read-0',
      'cohort-publish',
      'insights',
    ]);
  });

  it('a failing store is reported and left out; the run still publishes', async () => {
    const r2 = new CountingR2();
    const good = sid(40);
    const bad = sid(41);
    dir.ids = [bad, good];
    await batch(r2, good, '2026-11-09', 1);
    const realList = r2.list.bind(r2);
    r2.list = async (o?: { prefix?: string }) => {
      if (o?.prefix?.includes(bad)) throw new Error('boom');
      return realList(o);
    };
    const res = await runDailyCiAggregation(NOW, r2 as never);
    expect(res).toMatchObject({ skipped: false, stores: 1, failed: [bad] });
    expect(r2.keys(ciCohortLatestKey)).toHaveLength(1);
  });
});
