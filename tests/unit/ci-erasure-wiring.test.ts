/** Customer erasure/export reach Customer Intelligence on the Postgres path; customer-facing orders never carry CI columns. */
import { describe, expect, it } from 'vitest';
import { FakeR2 } from '../helpers/fake-r2';
import { eraseCiOutcomes } from '../../apps/api/src/lib/inngest/functions/account-erased-propagation';
import { exportCiOutcomes } from '../../apps/api/src/lib/ci/export';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { redactOrderForCustomer } from '../../apps/api/src/services/gold-rate/public';
import { ciBuyerIndexKey } from '../../apps/api/src/lib/ci/sink';
import { gzipText } from '../../apps/api/src/cf/erasure/surfaces';

const KEY = 'ab' + 'c'.repeat(62);
const OTHER = 'cd' + 'e'.repeat(62);

async function seed(r2: FakeR2) {
  const part = 'outcomes/v1/store=s1/dt=2026-11-03/P.ndjson.gz';
  const rows = [
    { eventId: '1', buyerKey: KEY, type: 'order.placed' },
    { eventId: '2', buyerKey: OTHER, type: 'order.placed' },
  ];
  await r2.put(part, await gzipText(rows.map(r => JSON.stringify(r)).join('\n') + '\n'));
  await r2.put(ciBuyerIndexKey(KEY), JSON.stringify({ partitions: [part] }));
  await r2.put(ciBuyerIndexKey(OTHER), JSON.stringify({ partitions: [part] }));
  return part;
}

describe('eraseCiOutcomes / exportCiOutcomes', () => {
  it('erases every given key, keeps other buyers, and reports the count', async () => {
    const r2 = new FakeR2();
    await seed(r2);
    expect(await eraseCiOutcomes('req', [KEY], r2 as never)).toEqual({ erased: 1 });
    expect(await r2.get(ciBuyerIndexKey(KEY))).toBeNull();
    expect(await r2.get(ciBuyerIndexKey(OTHER))).not.toBeNull();
    // idempotent: a retry of the same erasure is a clean no-op
    expect(await eraseCiOutcomes('req', [KEY], r2 as never)).toEqual({ erased: 0 });
  });

  it('throws (so the job retries and pages) when a row survives the erase', async () => {
    const r2 = new FakeR2();
    await seed(r2);
    const realPut = r2.put.bind(r2);
    r2.put = (async (k: string, ...a: unknown[]) =>
      k.startsWith('outcomes/')
        ? {}
        : (realPut as never as (...x: unknown[]) => Promise<unknown>)(k, ...a)) as never; // a dropped write
    r2.delete = (async () => undefined) as never;
    await expect(eraseCiOutcomes('req', [KEY], r2 as never)).rejects.toThrow(/left 1 row/);
  });

  it('no keys = nothing to do; no bucket: fine in Node, a failure inside a Worker', async () => {
    expect(await eraseCiOutcomes('r', [])).toEqual({ erased: 0 });
    clearCfBindings();
    expect(await eraseCiOutcomes('r', [KEY], undefined)).toEqual({ erased: 0 });
    setCfBindings({ HYPERDRIVE: { connectionString: '' } });
    await expect(eraseCiOutcomes('r', [KEY], undefined)).rejects.toThrow(/CI_BUCKET/);
    clearCfBindings();
  });

  it("exports the buyer's rows only", async () => {
    const r2 = new FakeR2();
    await seed(r2);
    const rows = (await exportCiOutcomes([KEY, KEY], r2 as never)) as Array<{ buyerKey: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.buyerKey).toBe(KEY);
    expect(await exportCiOutcomes([], r2 as never)).toEqual([]);
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
    const withItem = redactOrderForCustomer({
      id: 'o',
      buyerKey: KEY,
      items: [{ costPrice: 5, name: 'x' }],
    }) as never as { items: unknown[]; buyerKey?: string };
    expect(withItem.buyerKey).toBeUndefined();
    expect(withItem.items).toEqual([{ name: 'x', goldSnapshot: null }]);
  });
});
