import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 PR D2a (Ruling CF-STOCK-1): stock operations on real workerd. The DO is single threaded, so a stock check and
// its write are one step; with NO row lock, many concurrent requests can never oversell.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (
  stub: ReturnType<typeof stubFor>,
  store: string,
  name: string,
  args: object,
  key?: string
) => (await stub.stockOp(store, name, encodeRpc(args), key)) as Answer;

async function seed(store: string, inventory: number) {
  const stub = stubFor(store);
  await op(stub, store, 'setProduct', { productId: 'nope', quantity: 0 }); // binds the store
  await runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', ?, 'Widget', 'widget', 1000, ?, 'active')`,
      store,
      inventory
    );
  });
  return stub;
}
const stockOf = (stub: ReturnType<typeof stubFor>) =>
  runInDurableObject(
    stub,
    (_i, state) =>
      state.storage.sql.exec(`SELECT inventory FROM products WHERE id = 'p1'`).one()
        .inventory as number
  );

describe('StoreDO.stockOp', () => {
  it('100 concurrent removals against 40 in stock: exactly 40 succeed, none oversell, stock ends at 0', async () => {
    const stub = await seed('stock-race', 40);
    const answers = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        op(stub, 'stock-race', 'adjustProduct', {
          productId: 'p1',
          quantity: -1,
          type: 'sale',
          reference: `o${i}`,
        })
      )
    );
    const ok = answers.filter(a => a.ok);
    const refused = answers.filter(a => !a.ok) as Array<{ ok: false; code: string }>;
    expect(ok).toHaveLength(40);
    expect(refused).toHaveLength(60);
    expect(new Set(refused.map(r => r.code))).toEqual(new Set(['INSUFFICIENT_STOCK']));
    expect(await stockOf(stub)).toBe(0);
    const hist = await runInDurableObject(
      stub,
      (_i, s) => s.storage.sql.exec('SELECT count(*) AS n FROM inventory_history').one().n
    );
    expect(hist).toBe(40); // one history row per applied removal, none for a refused one
  });

  it('the same key fired 20 times concurrently applies once; the other 19 get the first answer', async () => {
    const stub = await seed('stock-replay', 10);
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(
          stub,
          'stock-replay',
          'adjustProduct',
          { productId: 'p1', quantity: -3, type: 'sale' },
          'order-77:p1:sale'
        )
      )
    );
    expect(answers.every(a => a.ok)).toBe(true);
    expect(new Set(answers.map(a => (a as { json: string }).json)).size).toBe(1);
    expect(await stockOf(stub)).toBe(7);
  });

  it('a refusal is an answer with the Postgres code and status, and is bound to ONE store', async () => {
    const stub = await seed('stock-bound', 5);
    expect(
      await op(stub, 'stock-bound', 'adjustProduct', {
        productId: 'p1',
        quantity: -9,
        type: 'sale',
      })
    ).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_STOCK',
      status: 400,
    });
    expect(
      await op(stub, 'someone-else', 'adjustProduct', {
        productId: 'p1',
        quantity: -1,
        type: 'sale',
      })
    ).toMatchObject({
      ok: false,
      code: 'STORE_MISMATCH',
    });
    expect(await op(stub, 'stock-bound', 'dropEverything', {})).toMatchObject({
      ok: false,
      code: 'STOCK_OP_NOT_ALLOWED',
    });
    expect(
      decodeRpc<{ newStock: number }>(
        (
          (await op(stub, 'stock-bound', 'setProduct', { productId: 'p1', quantity: 12 })) as {
            json: string;
          }
        ).json
      ).newStock
    ).toBe(12);
  });
});
