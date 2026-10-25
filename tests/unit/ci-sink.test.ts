/**
 * The CI sink end to end on in-memory R2 / KV / Analytics Engine, then the REAL G10 erasure surface
 * over what it wrote: the layout the writer produces is exactly the layout `ciSurface` erases/exports.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: h.alert }));

import {
  handleCiEventsBatch,
  toAnalyticsPoint,
  ciBuyerIndexKey,
} from '../../apps/api/src/lib/ci/sink';
import { buildEnvelope } from '../../apps/api/src/lib/ci/port';
import type { CiOutcomeInput } from '../../apps/api/src/lib/ci/envelope';
import { FakeR2 } from '../helpers/fake-r2';
import { ciSurface, gunzipText } from '../../apps/api/src/cf/erasure/surfaces';

const S1 = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';
const S2 = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const O = (n: number) => `0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6a${n}`;
const KEY_A = 'ab' + 'c'.repeat(62);
const KEY_B = 'cd' + 'e'.repeat(62);

class FakeKv {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
}
const msg = (body: unknown, id = Math.random().toString(36)) => ({
  id,
  body,
  attempts: 1,
  ack: vi.fn(),
  retry: vi.fn(),
});
const batch = (messages: ReturnType<typeof msg>[], queue = 'ebda-ci-events') => ({
  queue,
  messages,
});

async function env(
  over: Partial<CiOutcomeInput> & { type?: never } = {},
  recorded = new Date('2026-11-03T12:00:00Z')
) {
  const base: CiOutcomeInput = {
    type: 'order.placed',
    seed: `o:${over.orderId ?? O(1)}`,
    occurredAt: new Date('2026-11-03T11:00:00Z'),
    storeId: S1,
    orderId: O(1),
    buyerKey: KEY_A,
    xstore: false,
    data: {
      totalMinor: 1000,
      currency: 'EGP',
      paymentMethod: 'cod',
      channel: 'web',
      itemCount: 1,
      areaKey: 'EG-C',
      isFirstOrderForBuyerInStore: true,
    },
  };
  return buildEnvelope({ ...base, ...over } as CiOutcomeInput, 'store', recorded);
}

let r2: FakeR2, kv: FakeKv, ae: { writeDataPoint: ReturnType<typeof vi.fn> };
const E = () => ({ CI_BUCKET: r2 as never, CI_OUTCOMES: ae as never, KV_CACHE: kv as never });
beforeEach(() => {
  r2 = new FakeR2();
  kv = new FakeKv();
  ae = { writeDataPoint: vi.fn() };
  h.alert.mockReset().mockResolvedValue('sent');
});

describe('sink', () => {
  it('writes one gzip NDJSON partition per (store, day), the buyer index, and one AE point per event WITHOUT buyer key or order id', async () => {
    const a = await env();
    const b = await env({ orderId: O(2), seed: 'o:2', buyerKey: KEY_B });
    const m = [msg(a), msg(b)];
    await handleCiEventsBatch(batch(m), E());
    const parts = r2.keys(`outcomes/v1/store=${S1}/dt=2026-11-03/`);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatch(/\/[0-9A-HJKMNP-TV-Z]{26}\.ndjson\.gz$/);
    const lines = (await gunzipText(await (await r2.get(parts[0]!))!.arrayBuffer()))
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(lines.map(l => l.eventId).sort()).toEqual([a.eventId, b.eventId].sort());
    expect(lines.every(l => 'buyerKey' in l)).toBe(true);
    for (const k of [KEY_A, KEY_B]) {
      expect(JSON.parse(await (await r2.get(ciBuyerIndexKey(k)))!.text()).partitions).toEqual([
        parts[0],
      ]);
    }
    expect(ae.writeDataPoint).toHaveBeenCalledTimes(2);
    for (const call of ae.writeDataPoint.mock.calls) {
      const s = JSON.stringify(call[0]);
      expect(s).not.toContain(KEY_A);
      expect(s).not.toContain(KEY_B);
      expect(s).not.toContain(O(1));
      expect(s).not.toContain(O(2));
    }
    m.forEach(x => expect(x.ack).toHaveBeenCalled());
  });

  it('splits by store and by recorded day', async () => {
    const x = await env();
    const y = await env({ storeId: S2, seed: 'y', orderId: O(3) });
    const z = await env({ seed: 'z', orderId: O(4) }, new Date('2026-11-04T01:00:00Z'));
    await handleCiEventsBatch(batch([msg(x), msg(y), msg(z)]), E());
    expect(r2.keys(`outcomes/v1/store=${S1}/dt=2026-11-03/`)).toHaveLength(1);
    expect(r2.keys(`outcomes/v1/store=${S2}/dt=2026-11-03/`)).toHaveLength(1);
    expect(r2.keys(`outcomes/v1/store=${S1}/dt=2026-11-04/`)).toHaveLength(1);
  });

  it('a replayed eventId is dropped (one row), and the duplicate is acked', async () => {
    const a = await env();
    await handleCiEventsBatch(batch([msg(a)]), E());
    const again = msg(a);
    await handleCiEventsBatch(batch([again]), E());
    expect(r2.keys('outcomes/')).toHaveLength(1);
    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(again.ack).toHaveBeenCalled();
  });

  it('an unreadable message retries toward the DLQ (never silently acked); a PII-shaped one too', async () => {
    const good = await env();
    const bad = msg({ v: 1, type: 'order.placed', junk: true });
    const leaky = msg({ ...good, data: { ...good.data, areaKey: 'call 01001234567' } });
    const ok = msg(good);
    await handleCiEventsBatch(batch([bad, leaky, ok]), E());
    expect(bad.retry).toHaveBeenCalled();
    expect(bad.ack).not.toHaveBeenCalled();
    expect(leaky.retry).toHaveBeenCalled();
    expect(ok.ack).toHaveBeenCalled();
    expect(r2.keys('outcomes/')).toHaveLength(1);
  });

  it('an R2 failure retries the whole group and writes no AE point / seen marker', async () => {
    r2.failPut = true;
    const a = msg(await env());
    await handleCiEventsBatch(batch([a]), E());
    expect(a.retry).toHaveBeenCalled();
    expect(a.ack).not.toHaveBeenCalled();
    expect(ae.writeDataPoint).not.toHaveBeenCalled();
    expect(kv.m.size).toBe(0);
    r2.failPut = false;
    const retry = msg(a.body);
    await handleCiEventsBatch(batch([retry]), E());
    expect(retry.ack).toHaveBeenCalled();
    expect(r2.keys(`outcomes/v1/store=${S1}/`)).toHaveLength(1);
  });

  it('the index is written before the partition: an index entry with no partition is harmless, the reverse would be unerasable', async () => {
    const order: string[] = [];
    const real = r2.put.bind(r2);
    r2.put = (async (k: string, ...r: unknown[]) => {
      order.push(k.startsWith('index/') ? 'index' : 'partition');
      return (real as never as (...a: unknown[]) => Promise<unknown>)(k, ...r);
    }) as never;
    await handleCiEventsBatch(batch([msg(await env())]), E());
    expect(order).toEqual(['index', 'partition']);
  });

  it("two buyers' index updates on the same key do not lose each other (compare-and-set)", async () => {
    const a = await env();
    const b = await env({ orderId: O(2), seed: 'o:2' }, new Date('2026-11-04T01:00:00Z'));
    await Promise.all([
      handleCiEventsBatch(batch([msg(a)]), E()),
      handleCiEventsBatch(batch([msg(b)]), E()),
    ]);
    const idx = JSON.parse(await (await r2.get(ciBuyerIndexKey(KEY_A)))!.text())
      .partitions as string[];
    expect(idx).toHaveLength(2);
  });

  it('the DLQ parks the body in R2 before acking, pages, and retries if it cannot park', async () => {
    const m = msg({ whatever: 1 }, 'dead-1');
    await handleCiEventsBatch(batch([m], 'ebda-ci-events-dlq'), E());
    expect(JSON.parse(await (await r2.get('dlq/dead-1.json'))!.text())).toEqual({ whatever: 1 });
    expect(h.alert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'ci.dead_letter' })
    );
    expect(m.ack).toHaveBeenCalled();
    r2.failPut = true;
    const m2 = msg({ x: 1 }, 'dead-2');
    await handleCiEventsBatch(batch([m2], 'ebda-ci-events-dlq'), E());
    expect(m2.retry).toHaveBeenCalled();
    expect(m2.ack).not.toHaveBeenCalled();
  });

  it('alerts once when "other" is over 20% of a carrier\'s returns', async () => {
    const mk = (i: number, code: string) =>
      env({
        type: 'shipment.returned',
        seed: `r${i}`,
        orderId: O(i % 9),
        data: {
          carrier: 'bosta',
          codMinor: 1,
          returnReasonCode: code,
          returnReasonRaw: null,
          attempts: 1,
          hoursSincePickup: 1,
        },
      } as never);
    const evs = [];
    for (let i = 0; i < 12; i++) evs.push(msg(await mk(i, i < 4 ? 'other' : 'customer_refused')));
    await handleCiEventsBatch(batch(evs), E());
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'ci.return_reason_stale' })
    );
  });
});

describe('analytics point shape (1.5)', () => {
  it('maps the documented columns', async () => {
    const e = await env({
      type: 'shipment.delivered',
      seed: 'd',
      data: { carrier: 'aramex', codMinor: 5000, hoursSincePickup: 30, attempts: 2 },
    } as never);
    expect(toAnalyticsPoint(e)).toEqual({
      indexes: [S1],
      blobs: ['shipment.delivered', 'store', 'aramex', '', '', '', '0', '1'],
      doubles: [5000, 30, 2, e.occurredAt],
    });
  });
});

describe('erasure and export over what the sink wrote (G10 ciSurface)', () => {
  async function seed() {
    const evs = [
      await env({ seed: 'a1', orderId: O(1), buyerKey: KEY_A }),
      await env({ seed: 'a2', orderId: O(2), buyerKey: KEY_A }),
      await env({ seed: 'b1', orderId: O(3), buyerKey: KEY_B }),
      await env({ seed: 's2', orderId: O(4), buyerKey: KEY_A, storeId: S2 }),
      await env({ seed: 'n1', orderId: O(5), buyerKey: null }),
    ];
    await handleCiEventsBatch(batch(evs.map(e => msg(e))), E());
    return evs;
  }
  const snapshot = async (prefix: string) =>
    Object.fromEntries(
      await Promise.all(r2.keys(prefix).map(async k => [k, (await r2.get(k))!.etag]))
    );

  it("a customer erase removes exactly that buyer's rows across stores, leaves the others, drops the index", async () => {
    await seed();
    const res = await ciSurface(r2 as never).eraseSubject({
      kind: 'customer',
      requestId: 'r',
      buyerKey: KEY_A,
    });
    expect(res).toMatchObject({ erased: 3, remaining: 0 });
    expect(await r2.get(ciBuyerIndexKey(KEY_A))).toBeNull();
    const left: string[] = [];
    for (const k of r2.keys('outcomes/'))
      for (const l of (await gunzipText(await (await r2.get(k))!.arrayBuffer())).trim().split('\n'))
        left.push(JSON.parse(l).buyerKey);
    expect(left.sort()).toEqual([KEY_B, null].sort());
    expect(await r2.get(ciBuyerIndexKey(KEY_B))).not.toBeNull();
  });

  it("a customer export returns that buyer's envelopes only", async () => {
    await seed();
    const part = await ciSurface(r2 as never).exportSubject({
      kind: 'customer',
      requestId: 'r',
      buyerKey: KEY_A,
    });
    expect(part.records).toBe(3);
    expect(
      part.ndjson
        .split('\n')
        .filter(Boolean)
        .every(l => JSON.parse(l).buyerKey === KEY_A)
    ).toBe(true);
  });

  it("a merchant erase deletes that store's prefix and leaves another store's partitions byte-identical", async () => {
    await seed();
    const before = await snapshot(`outcomes/v1/store=${S2}/`);
    const res = await ciSurface(r2 as never).eraseSubject({
      kind: 'merchant',
      requestId: 'r',
      storeId: S1,
      ownerUserId: 'u',
    });
    expect(res.remaining).toBe(0);
    expect(r2.keys(`outcomes/v1/store=${S1}/`)).toHaveLength(0);
    expect(await snapshot(`outcomes/v1/store=${S2}/`)).toEqual(before);
  });
});
