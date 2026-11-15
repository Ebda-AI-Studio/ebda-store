import { beforeAll, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { doSyncSql, encodeRpc, runSmartLayerOp, SMART_LAYER_OPS } from '@ebda-src/repo';
import { runSmartLayerStorageContract } from '@ebda/shared/smart-layer';
import { doStorage } from '../src/smart-layer/storage-do';
import { storeTables } from '../src/cf/store-do/tables';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { ensurePlatformIndex } from './platform-index';

// The engine's EXECUTABLE storage contract against the REAL StoreDO SQLite (workerd). The DO is bound to ONE store at its RPC boundary
// (StoreMismatch), so the contract's two store ids (s1, s2: the isolation cases) run through the journal operations inside the DO, where
// the `store_id` predicates are what isolates; a second block proves the bound RPC path refuses another store.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
beforeAll(ensurePlatformIndex);
let n = 0;
const fresh = () => e.STORE_DO.get(e.STORE_DO.idFromName(`sl-contract-${++n}`));
const inDo = <T>(stub: ReturnType<typeof fresh>, op: string, args: unknown[]): Promise<T> =>
  runInDurableObject(
    stub,
    (_i, state) =>
      JSON.parse(
        JSON.stringify(runSmartLayerOp(doSyncSql(state.storage as never), op, args) ?? null)
      ) as T
  );

const make = () => {
  const stub = fresh();
  return doStorage((op, args) => inDo(stub, op, args));
};
runSmartLayerStorageContract(make, {
  describe,
  it,
  expect: v => ({
    toBe: x => expect(v).toBe(x),
    toEqual: x => expect(v).toEqual(x),
    toBeNull: () => expect(v).toBeNull(),
    toBeGreaterThan: x => expect(v as number).toBeGreaterThan(x),
  }),
});

const bound = async (store: string) => {
  const stub = e.STORE_DO.get(e.STORE_DO.idFromName(store));
  await stub.moneyOp(store, 'cancel', encodeRpc({ orderId: 'nope' })); // binds the store (as the money tests do)
  return stub;
};
const turn = (storeId: string) => ({
  id: 't1',
  storeId,
  conversationId: 'c1',
  userId: 'u1',
  role: 'merchant',
  maskedText: 'hi',
  at: Date.now(),
  releaseId: 'r',
});

describe('assistant journal on the StoreDO: the bound RPC path', () => {
  it('appendTurn then loadTurns returns it, and another store id is refused at the boundary (STORE_MISMATCH 403)', async () => {
    const stub = await bound('sl-store-a');
    expect(
      (await stub.smartLayerOp('sl-store-a', 'appendTurn', JSON.stringify([turn('sl-store-a')]))).ok
    ).toBe(true);
    const read = await stub.smartLayerOp(
      'sl-store-a',
      'loadTurns',
      JSON.stringify(['sl-store-a', 'c1', 10])
    );
    expect(read.ok && (JSON.parse(read.json) as Array<{ id: string }>).map(t => t.id)).toEqual([
      't1',
    ]);
    expect(
      await stub.smartLayerOp('sl-store-b', 'loadTurns', JSON.stringify(['sl-store-b', 'c1', 10]))
    ).toMatchObject({ ok: false, code: 'STORE_MISMATCH', status: 403 });
    // and another store's own DO never holds it
    const other = await bound('sl-store-b');
    const r = await other.smartLayerOp(
      'sl-store-b',
      'loadTurns',
      JSON.stringify(['sl-store-b', 'c1', 10])
    );
    expect(r.ok && JSON.parse(r.json)).toEqual([]);
  });

  it('an unknown operation is a 400 answer, not a dynamic call; a non-list argument is refused', async () => {
    const stub = await bound('sl-store-c');
    expect(await stub.smartLayerOp('sl-store-c', 'dropEverything', '[]')).toMatchObject({
      ok: false,
      code: 'UNKNOWN_OP',
      status: 400,
    });
    expect(await stub.smartLayerOp('sl-store-c', 'loadTurns', '{"a":1}')).toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
    });
    expect(SMART_LAYER_OPS).not.toContain('dropEverything');
  });

  it('a store backup export includes sl_audit (the backup reads the live schema)', async () => {
    const stub = await bound('sl-store-d');
    await stub.smartLayerOp(
      'sl-store-d',
      'appendAudit',
      JSON.stringify([
        {
          id: 'a1',
          storeId: 'sl-store-d',
          userId: 'u',
          turnId: 't',
          at: Date.now(),
          releaseId: 'r',
          maskedPrompt: 'p',
          maskedOutput: 'o',
          rails: {},
          toolsOffered: [],
          toolCalls: [],
          outcome: 'answered',
          inputTokens: 1,
          outputTokens: 1,
          model: 'm',
        },
      ])
    );
    const tables = await runInDurableObject(stub, (_i, state) =>
      storeTables(state.storage.sql as never)
    );
    expect(tables).toEqual(expect.arrayContaining(['sl_audit', 'sl_turns', 'sl_approvals']));
  });

  it('the alarm purges rows older than 90 days and keeps newer ones', async () => {
    const stub = await bound('sl-store-e');
    const now = Date.now();
    const t = (id: string, at: number) => ({ ...turn('sl-store-e'), id, at });
    await stub.smartLayerOp(
      'sl-store-e',
      'appendTurn',
      JSON.stringify([t('old', now - 91 * 86_400_000)])
    );
    await stub.smartLayerOp('sl-store-e', 'appendTurn', JSON.stringify([t('new', now - 1000)]));
    await runInDurableObject(stub, async inst => {
      await inst.alarm();
    });
    const r = await stub.smartLayerOp(
      'sl-store-e',
      'loadTurns',
      JSON.stringify(['sl-store-e', 'c1', 10])
    );
    expect(r.ok && (JSON.parse(r.json) as Array<{ id: string }>).map(x => x.id)).toEqual(['new']);
  });
});
