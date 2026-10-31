/**
 * CI-2 aggregation: the fold reproduces a hand-computed fixture to the cell, a replay is byte-identical,
 * the cohort suppresses on both sides of every k-threshold, and nothing personal reaches an output.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));

import { buildEnvelope } from '../../apps/api/src/lib/ci/port';
import { CiEnvelope, type CiOutcomeInput } from '../../apps/api/src/lib/ci/envelope';
import {
  amountBucket,
  areaLevels,
  foldStoreDay,
  type Cells,
} from '../../apps/api/src/lib/ci/aggregate/cells';
import {
  buildCohort,
  rebuildWindow,
  runCiAggregation,
  aggregateStoreDay,
  type StoreWindow,
} from '../../apps/api/src/lib/ci/aggregate/run';
import {
  ciCohortLatestKey,
  ciPartitionPrefix,
  ciStoreDayAggKey,
} from '../../apps/api/src/lib/ci/layout';
import { ciSurface, gzipText } from '../../apps/api/src/cf/erasure/surfaces';
import { FakeR2 } from '../helpers/fake-r2';

const S1 = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';
const REC = new Date('2026-11-03T12:00:00Z');
let n = 0;
const oid = () => `0d8ea0f4-5a47-4c7d-9a49-${String(++n).padStart(12, '0')}`;

async function ev(
  storeId: string,
  type: 'delivered' | 'returned' | 'cod_confirmed' | 'cod_unconfirmed',
  o: {
    carrier?: string;
    area?: string | null;
    cod?: number;
    hours?: number | null;
    xstore?: boolean;
    at?: Date;
  } = {}
): Promise<CiEnvelope> {
  const orderId = oid();
  const base = {
    seed: orderId,
    occurredAt: REC,
    storeId,
    orderId,
    buyerKey: 'ab' + 'c'.repeat(62),
    xstore: o.xstore ?? false,
  };
  const area = o.area === undefined ? 'EG-C-nasr-city' : o.area;
  const input: CiOutcomeInput =
    type === 'delivered'
      ? {
          ...base,
          type: 'shipment.delivered',
          data: {
            carrier: o.carrier ?? 'bosta',
            codMinor: o.cod ?? 30_000,
            hoursSincePickup: o.hours === undefined ? 20 : o.hours,
            attempts: 1,
            areaKey: area,
          },
        }
      : type === 'returned'
        ? {
            ...base,
            type: 'shipment.returned',
            data: {
              carrier: o.carrier ?? 'bosta',
              codMinor: o.cod ?? 30_000,
              returnReasonCode: 'other',
              returnReasonRaw: null,
              attempts: 2,
              hoursSincePickup: 30,
              areaKey: area,
            },
          }
        : {
            ...base,
            type: type === 'cod_confirmed' ? 'order.cod_confirmed' : 'order.cod_unconfirmed',
            data: { confirmedVia: 'call', minutesToConfirm: 10, areaKey: area },
          };
  return buildEnvelope(input, 'store', o.at ?? REC);
}

describe('areaLevels / amountBucket', () => {
  it('rolls a district up to its governorate', () => {
    expect(areaLevels('EG-C-nasr-city')).toEqual(['EG-C-nasr-city', 'EG-C']);
    expect(areaLevels('EG-C')).toEqual(['EG-C']);
    expect(areaLevels(null)).toEqual([]);
  });
  it('buckets on both sides of every edge', () => {
    expect(
      [19_999, 20_000, 49_999, 50_000, 99_999, 100_000, 199_999, 200_000].map(amountBucket)
    ).toEqual(['b0', 'b1', 'b1', 'b2', 'b2', 'b3', 'b3', 'b4']);
  });
});

describe('foldStoreDay (hand-computed fixture)', () => {
  it('3 delivered + 1 returned for bosta nasr-city, one shared', async () => {
    const events = [
      await ev(S1, 'delivered', { hours: 10 }),
      await ev(S1, 'delivered', { hours: 20, xstore: true }),
      await ev(S1, 'delivered', { hours: null }),
      await ev(S1, 'returned', { xstore: true }),
      await ev(S1, 'cod_confirmed'),
      await ev(S1, 'cod_unconfirmed'),
    ];
    const d = foldStoreDay(S1, '2026-11-03', events);
    expect(d.own.return_rate['bosta|EG-C-nasr-city']).toEqual({
      n: 4,
      hit: 1,
      sum: 0,
      first: '2026-11-03',
      last: '2026-11-03',
    });
    expect(d.own.return_rate['*|EG-C']!.n).toBe(4);
    expect(d.own.return_rate['*|*']!.n).toBe(4);
    // hours only from deliveries that carried it: (10 + 20) over 2
    expect(d.own.delivery_hours['bosta|EG-C-nasr-city']).toMatchObject({ n: 2, sum: 30 });
    expect(d.own.cod_confirmation['EG-C-nasr-city']).toMatchObject({ n: 2, hit: 1 });
    expect(d.own.cod_return_by_amount['b1']).toMatchObject({ n: 4, hit: 1 });
    // shared = only the two xstore events
    expect(d.shared.return_rate['bosta|EG-C-nasr-city']).toMatchObject({ n: 2, hit: 1 });
    expect(d.shared.cod_confirmation).toEqual({});
  });

  it('dedupes on eventId and ignores another store or day', async () => {
    const e = await ev(S1, 'delivered');
    const other = await ev('7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'delivered');
    const d = foldStoreDay(S1, '2026-11-03', [e, e, other]);
    expect(d.own.return_rate['*|*']!.n).toBe(1);
    expect(foldStoreDay(S1, '2026-11-02', [e]).own.return_rate).toEqual({});
  });

  it('an event with no area counts only under any-area', async () => {
    const d = foldStoreDay(S1, '2026-11-03', [await ev(S1, 'delivered', { area: null })]);
    expect(Object.keys(d.own.return_rate).sort()).toEqual(['*|*', 'bosta|*']);
  });

  it('the output has no buyer key or order id anywhere', async () => {
    const d = foldStoreDay(S1, '2026-11-03', [await ev(S1, 'returned', { xstore: true })]);
    const text = JSON.stringify(d);
    expect(text).not.toMatch(/abcccc/);
    expect(text).not.toMatch(/0d8ea0f4/);
  });
});

const win = (
  storeId: string,
  cells: Partial<Record<keyof Cells, Record<string, number>>>
): StoreWindow => {
  const shared = {
    return_rate: {},
    delivery_hours: {},
    cod_confirmation: {},
    cod_return_by_amount: {},
  } as Cells;
  for (const [m, byKey] of Object.entries(cells)) {
    for (const [k, count] of Object.entries(byKey!)) {
      (shared as Record<string, Record<string, unknown>>)[m]![k] = {
        n: count,
        hit: 1,
        sum: 0,
        first: '2026-11-01',
        last: '2026-11-03',
      };
    }
  }
  return { v: 1, storeId, asOf: '2026-11-03', windowDays: 90, own: shared, shared };
};
const K = 'bosta|EG-C';
const many = (counts: number[]) =>
  counts.map((c, i) => win(`store-${i}`, { return_rate: { [K]: c } }));

describe('buildCohort suppression (both sides of every boundary)', () => {
  const cell = (counts: number[]) => buildCohort(many(counts), '2026-11-03').metrics.return_rate[K];
  it('n: 99 suppressed, 100 published', () => {
    expect(cell([20, 20, 20, 20, 19])).toEqual({ suppressed: true });
    expect(cell([20, 20, 20, 20, 20])).toMatchObject({ n: 100, stores: 5, maxShare: 0.2 });
  });
  it('stores: 4 suppressed, 5 published', () => {
    expect(cell([25, 25, 25, 25])).toEqual({ suppressed: true });
    expect(cell([20, 20, 20, 20, 20])).not.toHaveProperty('suppressed');
  });
  it('share: 41% suppressed, exactly 40% published', () => {
    expect(cell([41, 15, 15, 15, 14])).toEqual({ suppressed: true });
    expect(cell([40, 15, 15, 15, 15])).toMatchObject({ n: 100, maxShare: 0.4 });
  });
  it('a suppressed cell carries nothing but the flag, and no store id is published', () => {
    const c = buildCohort(many([1, 1]), '2026-11-03');
    expect(c.metrics.return_rate[K]).toEqual({ suppressed: true });
    expect(JSON.stringify(buildCohort(many([20, 20, 20, 20, 20]), '2026-11-03'))).not.toMatch(
      /store-/
    );
  });
});

describe('runCiAggregation on in-memory R2', () => {
  async function seed(r2: FakeR2, storeId: string, day: string, events: CiEnvelope[], name = 'a') {
    await r2.put(
      `${ciPartitionPrefix(storeId, day)}${name}.ndjson.gz`,
      await gzipText(events.map(e => JSON.stringify(e)).join('\n') + '\n')
    );
  }

  it('writes day, window and cohort files; a replay is byte-identical', async () => {
    const r2 = new FakeR2();
    const evs: CiEnvelope[] = [];
    for (let s = 0; s < 5; s++) {
      const store = `0d8ea0f4-5a47-4c7d-9a49-00000000010${s}`;
      const list = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          ev(store, i % 5 === 0 ? 'returned' : 'delivered', { xstore: true })
        )
      );
      await seed(r2, store, '2026-11-03', list);
      evs.push(...list);
    }
    const stores = [...new Set(evs.map(e => e.storeId))];
    const first = await runCiAggregation(r2 as never, stores, ['2026-11-02', '2026-11-03']);
    expect(first).toMatchObject({ stores: 5, failed: [] });
    const snap = new Map([...r2.objs].map(([k, v]) => [k, new TextDecoder().decode(v.body)]));
    const cohort = JSON.parse(snap.get(ciCohortLatestKey)!);
    expect(cohort.metrics.return_rate['bosta|EG-C-nasr-city']).toMatchObject({
      n: 100,
      hit: 20,
      stores: 5,
    });
    await runCiAggregation(r2 as never, stores, ['2026-11-02', '2026-11-03']);
    for (const [k, v] of r2.objs) {
      if (k.startsWith('outcomes/')) continue;
      expect(new TextDecoder().decode(v.body), k).toBe(snap.get(k));
    }
  });

  it('a store that fails is left out and reported, the rest still publish', async () => {
    const r2 = new FakeR2();
    const good = '0d8ea0f4-5a47-4c7d-9a49-000000000201';
    await seed(r2, good, '2026-11-03', [await ev(good, 'delivered', { xstore: true })]);
    const realList = r2.list.bind(r2);
    r2.list = async (o?: { prefix?: string }) => {
      if (o?.prefix?.includes('BAD')) throw new Error('boom');
      return realList(o);
    };
    const res = await runCiAggregation(r2 as never, ['BAD', good], ['2026-11-03']);
    expect(res.failed).toEqual(['BAD']);
    expect(res.stores).toBe(1);
    expect(r2.keys(ciCohortLatestKey)).toHaveLength(1);
  });

  it('window = merge of the day files; a missing day is skipped', async () => {
    const r2 = new FakeR2();
    await seed(r2, S1, '2026-11-02', [
      await ev(S1, 'delivered', { at: new Date('2026-11-02T09:00:00Z') }),
    ]);
    await seed(r2, S1, '2026-11-03', [await ev(S1, 'returned')]);
    await aggregateStoreDay(r2 as never, S1, '2026-11-02');
    await aggregateStoreDay(r2 as never, S1, '2026-11-03');
    const w = await rebuildWindow(r2 as never, S1, '2026-11-03');
    expect(w.own.return_rate['*|*']).toMatchObject({ n: 2, hit: 1 });
    expect(r2.keys(ciStoreDayAggKey(S1, '2026-11-02'))).toHaveLength(1);
  });

  it('a corrupt line is skipped and counted, not fatal', async () => {
    const r2 = new FakeR2();
    await r2.put(
      `${ciPartitionPrefix(S1, '2026-11-03')}x.ndjson.gz`,
      await gzipText(`not json\n${JSON.stringify(await ev(S1, 'delivered'))}\n`)
    );
    const { file, skipped } = await aggregateStoreDay(r2 as never, S1, '2026-11-03');
    expect(skipped).toBe(1);
    expect(file.own.return_rate['*|*']!.n).toBe(1);
  });
});

describe('merchant erasure covers the aggregates', () => {
  it("deletes the store's day + window files and leaves other stores' byte-identical", async () => {
    const r2 = new FakeR2();
    const other = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    for (const st of [S1, other]) {
      await r2.put(
        `${ciPartitionPrefix(st, '2026-11-03')}a.ndjson.gz`,
        await gzipText(JSON.stringify(await ev(st, 'delivered', { xstore: true })) + '\n')
      );
    }
    await runCiAggregation(r2 as never, [S1, other], ['2026-11-03']);
    const before = new TextDecoder().decode(
      r2.objs.get(`aggregates/v1/store=${other}/window.json`)!.body
    );
    const r = await ciSurface(r2 as never).eraseSubject({ kind: 'merchant', storeId: S1 } as never);
    expect(r.remaining).toBe(0);
    expect(r2.keys(`aggregates/v1/store=${S1}/`)).toEqual([]);
    expect(
      new TextDecoder().decode(r2.objs.get(`aggregates/v1/store=${other}/window.json`)!.body)
    ).toBe(before);
  });
});
