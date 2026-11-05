/**
 * Customer erasure/export reach Customer Intelligence on the Postgres path, SCOPED to the requester's own
 * orders in their own store (a buyer key is a hash of a typed phone: it is not proof of identity), with
 * tombstones against in-flight events. Customer-facing orders never carry CI columns.
 */
import { describe, expect, it } from 'vitest';
import { FakeR2 } from '../helpers/fake-r2';
import { eraseCiOutcomes } from '../../apps/api/src/lib/inngest/functions/account-erased-propagation';
import { exportCiOutcomes } from '../../apps/api/src/lib/ci/export';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { redactOrderForCustomer } from '../../apps/api/src/services/gold-rate/public';
import {
  ciBuyerIndexKey,
  ciOrderTombstoneKey,
  ciBuyerTombstoneKey,
  ciDlqKey,
} from '../../apps/api/src/lib/ci/layout';
import { ciSinceDay } from '../../apps/api/src/lib/ci/layout';
import { replayCiDlq } from '../../apps/api/src/lib/ci/replay';
import { handleCiEventsBatch } from '../../apps/api/src/lib/ci/sink';
import { buildEnvelope } from '../../apps/api/src/lib/ci/port';
import { gunzipText, gzipText } from '../../apps/api/src/cf/erasure/surfaces';

const KEY = 'ab' + 'c'.repeat(62); // the phone both the victim and the attacker typed
const S1 = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';
const S2 = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const MINE = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6a1';
const MINE_TOO = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6a2';
const THEIRS_SAME_STORE = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6a3';
const OTHER_STORE = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6a4';
const P1 = `outcomes/v1/store=${S1}/dt=2026-11-03/P1.ndjson.gz`;
const P2 = `outcomes/v1/store=${S2}/dt=2026-11-03/P2.ndjson.gz`;

const row = (storeId: string, orderId: string, buyerKey: string | null = KEY) => ({
  eventId: orderId,
  storeId,
  orderId,
  buyerKey,
  type: 'order.placed',
});

async function seed(r2: FakeR2) {
  const put = async (p: string, rows: unknown[]) =>
    r2.put(p, await gzipText(rows.map(r => JSON.stringify(r)).join('\n') + '\n'));
  await put(P1, [row(S1, MINE), row(S1, MINE_TOO), row(S1, THEIRS_SAME_STORE)]);
  await put(P2, [row(S2, OTHER_STORE)]);
  await r2.put(ciBuyerIndexKey(KEY), JSON.stringify({ partitions: [P1, P2] }));
}
const scope = { storeId: S1, orderIds: [MINE, MINE_TOO], buyerKeys: [KEY] };
const ids = async (r2: FakeR2, p: string) =>
  (await gunzipText(await (await r2.get(p))!.arrayBuffer()))
    .trim()
    .split('\n')
    .map(l => JSON.parse(l).orderId);

describe('scoped erase', () => {
  it("removes ONLY the account's orders in its store; another person under the same key and another store survive", async () => {
    const r2 = new FakeR2();
    await seed(r2);
    expect(await eraseCiOutcomes('req', scope, undefined, r2 as never)).toEqual({ erased: 2 });
    expect(await ids(r2, P1)).toEqual([THEIRS_SAME_STORE]);
    expect(await ids(r2, P2)).toEqual([OTHER_STORE]);
    // the key is still indexed for the rows that remain (P1 other person, P2 other store)
    expect(JSON.parse(await (await r2.get(ciBuyerIndexKey(KEY)))!.text()).partitions).toEqual([
      P1,
      P2,
    ]);
    // idempotent
    expect(await eraseCiOutcomes('req', scope, undefined, r2 as never)).toEqual({ erased: 0 });
  });

  it('drops a partition and its index entry when nothing of the key is left in it', async () => {
    const r2 = new FakeR2();
    await seed(r2);
    await eraseCiOutcomes(
      'req',
      { ...scope, orderIds: [MINE, MINE_TOO, THEIRS_SAME_STORE] },
      undefined,
      r2 as never
    );
    expect(await r2.get(P1)).toBeNull();
    expect(JSON.parse(await (await r2.get(ciBuyerIndexKey(KEY)))!.text()).partitions).toEqual([P2]);
    // emptied entries are rewritten (compare-and-set), never deleted: a delete cannot be conditional
    await eraseCiOutcomes(
      'req',
      { storeId: S2, orderIds: [OTHER_STORE], buyerKeys: [KEY] },
      undefined,
      r2 as never
    );
    expect(JSON.parse(await (await r2.get(ciBuyerIndexKey(KEY)))!.text()).partitions).toEqual([]);
  });

  it("writes order tombstones first; a buyer-key erase runs only for a PROVEN key and only in the proof's store", async () => {
    const r2 = new FakeR2();
    await seed(r2);
    await eraseCiOutcomes('req', scope, undefined, r2 as never);
    expect(await r2.get(ciOrderTombstoneKey(MINE))).not.toBeNull();
    expect(await r2.get(ciBuyerTombstoneKey(S1, KEY))).toBeNull();
    await eraseCiOutcomes('req', scope, { storeId: S1, buyerKeys: [KEY] }, r2 as never);
    // store 1: every row under the proven key is gone (including the other person's), store 2 is untouched
    expect(await r2.get(P1)).toBeNull();
    expect(await ids(r2, P2)).toEqual([OTHER_STORE]);
    expect(await r2.get(ciBuyerTombstoneKey(S1, KEY))).not.toBeNull();
    expect(await r2.get(ciBuyerTombstoneKey(S2, KEY))).toBeNull(); // no global tombstone from a single-store proof
    expect(JSON.parse(await (await r2.get(ciBuyerIndexKey(KEY)))!.text()).partitions).toEqual([P2]);
  });

  it("a single-store proof does not de-key or drop another store's in-flight events", async () => {
    const r2 = new FakeR2();
    await r2.put(ciBuyerTombstoneKey(S1, KEY), '1');
    const mk = (storeId: string, orderId: string) =>
      buildEnvelope({
        type: 'order.placed',
        seed: `o:${orderId}`,
        occurredAt: new Date(),
        storeId,
        orderId,
        buyerKey: KEY,
        xstore: false,
        data: {
          totalMinor: 1,
          currency: 'EGP',
          paymentMethod: 'cod',
          channel: 'web',
          itemCount: 1,
          areaKey: null,
          isFirstOrderForBuyerInStore: null,
        },
      });
    const m = (body: unknown) => ({
      id: Math.random().toString(),
      body,
      attempts: 1,
      ack: () => undefined,
      retry: () => undefined,
    });
    await handleCiEventsBatch(
      {
        queue: 'ebda-ci-events',
        messages: [m(await mk(S1, THEIRS_SAME_STORE)), m(await mk(S2, OTHER_STORE))],
      },
      {
        CI_BUCKET: r2 as never,
        KV_CACHE: { get: async () => null, put: async () => undefined } as never,
        CI_OUTCOMES: { writeDataPoint: () => undefined } as never,
      }
    );
    const keyOf = async (store: string) =>
      JSON.parse(
        (
          await gunzipText(
            await (await r2.get(r2.keys(`outcomes/v1/store=${store}/`)[0]!))!.arrayBuffer()
          )
        ).trim()
      ).buyerKey;
    expect(await keyOf(S1)).toBeNull();
    expect(await keyOf(S2)).toBe(KEY);
  });

  it('throws when a row survives (retry + page); nothing to do = no-op; no bucket: Node ok, Worker fails', async () => {
    const r2 = new FakeR2();
    await seed(r2);
    r2.put = (async (k: string, ...a: unknown[]) =>
      k.startsWith('outcomes/') || k.startsWith('index/')
        ? {}
        : (FakeR2.prototype.put as never as (...x: unknown[]) => Promise<unknown>).call(
            r2,
            k,
            ...a
          )) as never;
    await expect(eraseCiOutcomes('req', scope, undefined, r2 as never)).rejects.toThrow(
      /left 2 row/
    );
    expect(await eraseCiOutcomes('r', undefined)).toEqual({ erased: 0 });
    clearCfBindings();
    expect(await eraseCiOutcomes('r', scope, undefined, undefined)).toEqual({ erased: 0 });
    setCfBindings({});
    await expect(eraseCiOutcomes('r', scope, undefined, undefined)).rejects.toThrow(/CI_BUCKET/);
    clearCfBindings();
  });
});

describe('scoped export', () => {
  it("returns only the requester's own orders in this store, never another person's or another store's rows", async () => {
    const r2 = new FakeR2();
    await seed(r2);
    const rows = (await exportCiOutcomes(scope, r2 as never)) as Array<{ orderId: string }>;
    expect(rows.map(r => r.orderId).sort()).toEqual([MINE, MINE_TOO].sort());
    expect(await exportCiOutcomes({ ...scope, orderIds: [] }, r2 as never)).toEqual([]);
    // an attacker who typed the victim's phone on THEIR order sees nothing of the victim's other stores
    const attacker = (await exportCiOutcomes(
      { storeId: S1, orderIds: ['0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6ff'], buyerKeys: [KEY] },
      r2 as never
    )) as unknown[];
    expect(attacker).toEqual([]);
  });
});

describe('in-flight events after an erase (tombstones)', () => {
  it('drops an event for an erased order and de-keys an event for an erased buyer', async () => {
    const r2 = new FakeR2();
    const kv = { get: async () => null, put: async () => undefined };
    const mk = (orderId: string, buyerKey: string | null) =>
      buildEnvelope({
        type: 'order.placed',
        seed: `o:${orderId}`,
        occurredAt: new Date(),
        storeId: S1,
        orderId,
        buyerKey,
        xstore: false,
        data: {
          totalMinor: 1,
          currency: 'EGP',
          paymentMethod: 'cod',
          channel: 'web',
          itemCount: 1,
          areaKey: null,
          isFirstOrderForBuyerInStore: null,
        },
      });
    await r2.put(ciOrderTombstoneKey(MINE), '1');
    await r2.put(ciBuyerTombstoneKey(S1, KEY), '1');
    const m = (body: unknown) => ({
      id: Math.random().toString(),
      body,
      attempts: 1,
      ack: () => undefined,
      retry: () => undefined,
    });
    await handleCiEventsBatch(
      {
        queue: 'ebda-ci-events',
        messages: [m(await mk(MINE, KEY)), m(await mk(THEIRS_SAME_STORE, KEY))],
      },
      {
        CI_BUCKET: r2 as never,
        KV_CACHE: kv as never,
        CI_OUTCOMES: { writeDataPoint: () => undefined } as never,
      }
    );
    const parts = r2.keys(`outcomes/v1/store=${S1}/`);
    expect(parts).toHaveLength(1);
    const written = (await gunzipText(await (await r2.get(parts[0]!))!.arrayBuffer()))
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(written.map(w => w.orderId)).toEqual([THEIRS_SAME_STORE]); // the erased order's event is gone
    expect(written[0].buyerKey).toBeNull(); // the erased buyer's key is not re-written
    expect(await r2.get(ciBuyerIndexKey(KEY))).toBeNull(); // and no index entry re-created
  });
});

describe('redactOrderForCustomer', () => {
  it('strips buyerKey and areaKey with or without items', () => {
    expect(redactOrderForCustomer({ id: 'o', buyerKey: KEY, areaKey: 'EG-C', items: [] })).toEqual({
      id: 'o',
      items: [],
    });
    expect(redactOrderForCustomer({ id: 'o', buyerKey: KEY, areaKey: 'EG-C' } as never)).toEqual({
      id: 'o',
    });
  });
});

describe('races the index cannot see (second pass lists the store prefix)', () => {
  it('an index entry written before its partition lands is KEPT; the prefix pass then removes the row the index never led to', async () => {
    const r2 = new FakeR2();
    const late = `outcomes/v1/store=${S1}/dt=2026-11-04/LATE.ndjson.gz`;
    await r2.put(ciBuyerIndexKey(KEY), JSON.stringify({ partitions: [late] })); // index first, partition not there yet
    await eraseCiOutcomes('req', scope, undefined, r2 as never);
    expect(JSON.parse(await (await r2.get(ciBuyerIndexKey(KEY)))!.text()).partitions).toEqual([
      late,
    ]); // not dropped
    // the sink's partition then lands, and the entry was lost / never indexed under this key either
    await r2.put(late, await gzipText(JSON.stringify(row(S1, MINE, null)) + '\n'));
    await r2.put(ciBuyerIndexKey(KEY), JSON.stringify({ partitions: [] }));
    expect(await eraseCiOutcomes('req', scope, undefined, r2 as never)).toEqual({ erased: 0 }); // index pass is blind to it
    expect(await eraseCiOutcomes('req', scope, undefined, r2 as never, 'prefix')).toEqual({
      erased: 1,
    }); // prefix pass finds it, even with a null key
    expect(await r2.get(late)).toBeNull();
  });
});

describe('parked dead letters', () => {
  const park = (r2: FakeR2, id: string, body: unknown, parkedAt = Date.now()) =>
    r2.put(ciDlqKey(id), JSON.stringify({ parkedAt, body }));

  it('erasure deletes the in-scope bodies and leaves the others', async () => {
    const r2 = new FakeR2();
    await park(r2, 'a', row(S1, MINE));
    await park(r2, 'b', row(S1, THEIRS_SAME_STORE));
    await park(r2, 'c', row(S2, OTHER_STORE));
    await eraseCiOutcomes('req', scope, undefined, r2 as never);
    expect(r2.keys('dlq/').sort()).toEqual([ciDlqKey('b'), ciDlqKey('c')]);
    await eraseCiOutcomes('req', scope, { storeId: S1, buyerKeys: [KEY] }, r2 as never);
    expect(r2.keys('dlq/')).toEqual([ciDlqKey('c')]); // proven key: store 1 bodies go, store 2 stays
  });

  async function validBody(orderId: string, storeId = S1) {
    return buildEnvelope({
      type: 'order.placed',
      seed: `o:${orderId}`,
      occurredAt: new Date(),
      storeId,
      orderId,
      buyerKey: KEY,
      xstore: false,
      data: {
        totalMinor: 1,
        currency: 'EGP',
        paymentMethod: 'cod',
        channel: 'web',
        itemCount: 1,
        areaKey: null,
        isFirstOrderForBuyerInStore: null,
      },
    });
  }

  it('replay re-queues a fresh body, and refuses one older than the tombstone TTL or one that was erased', async () => {
    const r2 = new FakeR2();
    const sent: unknown[] = [];
    const queue = { send: async (b: unknown) => void sent.push(b) };
    const now = Date.now();
    await park(r2, 'fresh', await validBody(THEIRS_SAME_STORE, S2), now - 86_400_000);
    await park(r2, 'old', await validBody(OTHER_STORE, S2), now - 31 * 86_400_000);
    await park(r2, 'erased', await validBody(MINE));
    await r2.put(ciOrderTombstoneKey(MINE), '1');
    await park(r2, 'proven', await validBody('0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6a9'));
    await r2.put(ciBuyerTombstoneKey(S1, KEY), '1');
    const res = await replayCiDlq(r2 as never, queue as never, now);
    expect(res).toEqual({ replayed: 1, refusedOld: 1, refusedErased: 2, unreadable: 0 });
    expect(sent).toHaveLength(1);
    expect(r2.keys('dlq/')).toHaveLength(0); // replayed and refused bodies are not kept
  });
});

describe('second pass is its own job', () => {
  it('a sibling failure cannot skip it: it is a separate function on account/erased, not a step after the aggregate throw', async () => {
    const { readFileSync } = await import('node:fs');
    const root = `${__dirname}/../../apps/api/src/lib/inngest/functions`;
    expect(readFileSync(`${root}/account-erased-propagation.ts`, 'utf8')).not.toMatch(
      /erase-ci-outcomes-second-pass|step\.sleep/
    );
    expect(readFileSync(`${root}/ci-erasure-second-pass.ts`, 'utf8')).toMatch(
      /triggers: \[\{ event: 'account\/erased' \}\]/
    );
    expect(readFileSync(`${root}/index.ts`, 'utf8')).toContain('ciErasureSecondPassFn');
  });

  it('sleeps, then sweeps the store prefix from the first order day, finding a row the index never led to', async () => {
    const { ciErasureSecondPass } =
      await import('../../apps/api/src/lib/inngest/functions/ci-erasure-second-pass');
    const r2 = new FakeR2();
    const old = `outcomes/v1/store=${S1}/dt=2026-10-01/OLD.ndjson.gz`;
    const late = `outcomes/v1/store=${S1}/dt=2026-11-04/LATE.ndjson.gz`;
    await r2.put(old, await gzipText(JSON.stringify(row(S1, MINE, null)) + '\n')); // before the account's first order day
    await r2.put(late, await gzipText(JSON.stringify(row(S1, MINE, null)) + '\n'));
    const gets: string[] = [];
    const realGet = r2.get.bind(r2);
    r2.get = (async (k: string) => (gets.push(k), realGet(k))) as never;
    setCfBindings({ CI_BUCKET: r2 as never });
    const calls: string[] = [];
    const step = {
      sleep: async (id: string) => void calls.push(`sleep:${id}`),
      run: async <T>(id: string, fn: () => Promise<T>) => (calls.push(`run:${id}`), fn()),
    };
    const out = await ciErasureSecondPass(
      { data: { userId: 'u', ciScope: { ...scope, sinceDay: '2026-11-01' } } },
      step
    );
    clearCfBindings();
    expect(calls).toEqual(['sleep:ci-erasure-settle', 'run:erase-ci-outcomes-second-pass']);
    expect(out).toMatchObject({ erased: 1 });
    expect(await r2.get(late)).toBeNull();
    expect(gets).not.toContain(old); // a day before the first order is never fetched
    expect(await ciErasureSecondPass({ data: { userId: 'u' } }, step)).toEqual({ skipped: true });
  });
});

describe('dead letter of an erased order', () => {
  it('is acked without being parked', async () => {
    const r2 = new FakeR2();
    await r2.put(ciOrderTombstoneKey(MINE), '1');
    const acked: string[] = [];
    await handleCiEventsBatch(
      {
        queue: 'ebda-ci-events-dlq',
        messages: [
          {
            id: 'd1',
            body: row(S1, MINE),
            attempts: 1,
            ack: () => acked.push('d1'),
            retry: () => undefined,
          },
        ],
      },
      { CI_BUCKET: r2 as never }
    );
    expect(acked).toEqual(['d1']);
    expect(r2.keys('dlq/')).toHaveLength(0);
  });
});

describe('the prefix pass lower bound', () => {
  it('is the first order date minus a 2-day margin, so an event stored a day BEFORE the order date is still erased', async () => {
    expect(ciSinceDay([new Date('2026-11-03T22:30:00Z'), new Date('2026-11-05T01:00:00Z')])).toBe(
      '2026-11-01'
    );
    expect(ciSinceDay([])).toBeUndefined();
    const { ciErasureSecondPass } =
      await import('../../apps/api/src/lib/inngest/functions/ci-erasure-second-pass');
    const r2 = new FakeR2();
    const dayBefore = `outcomes/v1/store=${S1}/dt=2026-11-02/B.ndjson.gz`; // the order was created on 2026-11-03
    const tooOld = `outcomes/v1/store=${S1}/dt=2026-10-30/OLD.ndjson.gz`;
    await r2.put(dayBefore, await gzipText(JSON.stringify(row(S1, MINE, null)) + '\n'));
    await r2.put(tooOld, await gzipText(JSON.stringify(row(S1, MINE, null)) + '\n'));
    setCfBindings({ CI_BUCKET: r2 as never });
    const step = {
      sleep: async () => undefined,
      run: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    };
    const since = ciSinceDay([new Date('2026-11-03T22:30:00Z')]);
    await ciErasureSecondPass(
      { data: { userId: 'u', ciScope: { ...scope, sinceDay: since } } },
      step
    );
    clearCfBindings();
    expect(await r2.get(dayBefore)).toBeNull(); // erased
    expect(await r2.get(tooOld)).not.toBeNull(); // before the bound: never read
  });
});
