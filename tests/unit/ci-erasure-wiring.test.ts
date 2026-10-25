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
} from '../../apps/api/src/lib/ci/layout';
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
    expect(await eraseCiOutcomes('req', scope, [], r2 as never)).toEqual({ erased: 2 });
    expect(await ids(r2, P1)).toEqual([THEIRS_SAME_STORE]);
    expect(await ids(r2, P2)).toEqual([OTHER_STORE]);
    // the key is still indexed for the rows that remain (P1 other person, P2 other store)
    expect(JSON.parse(await (await r2.get(ciBuyerIndexKey(KEY)))!.text()).partitions).toEqual([
      P1,
      P2,
    ]);
    // idempotent
    expect(await eraseCiOutcomes('req', scope, [], r2 as never)).toEqual({ erased: 0 });
  });

  it('drops a partition and its index entry when nothing of the key is left in it', async () => {
    const r2 = new FakeR2();
    await seed(r2);
    await eraseCiOutcomes(
      'req',
      { ...scope, orderIds: [MINE, MINE_TOO, THEIRS_SAME_STORE] },
      [],
      r2 as never
    );
    expect(await r2.get(P1)).toBeNull();
    expect(JSON.parse(await (await r2.get(ciBuyerIndexKey(KEY)))!.text()).partitions).toEqual([P2]);
  });

  it('writes order tombstones first; a buyer-key-wide erase happens only for a PROVEN key', async () => {
    const r2 = new FakeR2();
    await seed(r2);
    await eraseCiOutcomes('req', scope, [], r2 as never);
    expect(await r2.get(ciOrderTombstoneKey(MINE))).not.toBeNull();
    expect(await r2.get(ciBuyerTombstoneKey(KEY))).toBeNull();
    await eraseCiOutcomes('req', scope, [KEY], r2 as never); // proven phone: every store, every order
    expect(await r2.get(ciBuyerTombstoneKey(KEY))).not.toBeNull();
    expect(await r2.get(ciBuyerIndexKey(KEY))).toBeNull();
    expect(r2.keys('outcomes/')).toHaveLength(0);
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
    await expect(eraseCiOutcomes('req', scope, [], r2 as never)).rejects.toThrow(/left 2 row/);
    expect(await eraseCiOutcomes('r', undefined)).toEqual({ erased: 0 });
    clearCfBindings();
    expect(await eraseCiOutcomes('r', scope, [], undefined)).toEqual({ erased: 0 });
    setCfBindings({ HYPERDRIVE: { connectionString: '' } });
    await expect(eraseCiOutcomes('r', scope, [], undefined)).rejects.toThrow(/CI_BUCKET/);
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
    await r2.put(ciBuyerTombstoneKey(KEY), '1');
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
