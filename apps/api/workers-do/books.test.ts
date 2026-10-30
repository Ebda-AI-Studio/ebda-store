import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 R7 (Ruling CF-R7-1): the accounting and scan stock flows on real workerd. Postgres serialises these with row
// locks (the PO row, the products being received, the draft being posted, the sequence upsert). The DO is single threaded and
// each flow is one section, so with NO lock concurrent requests still cannot double-post, over-receive or reuse a number.
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
const val = <T>(a: Answer): T => decodeRpc<T>((a as { json: string }).json);
const sql = <T = Record<string, unknown>>(
  stub: ReturnType<typeof stubFor>,
  text: string,
  ...p: unknown[]
) =>
  runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(text, ...p).toArray() as unknown as T[]
  );

async function seed(store: string) {
  const stub = stubFor(store);
  await op(stub, store, 'setProduct', { productId: 'nope', quantity: 0 }); // binds the store
  await runInDurableObject(stub, (_i, state) => {
    const x = (q: string, ...p: unknown[]) => state.storage.sql.exec(q, ...p);
    x(`INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES (?, 1)`, store);
    for (const [id, code, type] of [
      ['a1200', '1200', 'asset'],
      ['a3000', '3000', 'equity'],
      ['a2000', '2000', 'liability'],
    ])
      x(
        `INSERT INTO accounts (id, store_id, code, name_en, type, is_system) VALUES (?, ?, ?, ?, ?, 1)`,
        id,
        store,
        code,
        code,
        type
      );
    x(`INSERT INTO suppliers (id, store_id, name) VALUES ('sup1', ?, 'Sup')`, store);
    x(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, cost_price, status) VALUES ('p1', ?, 'Widget', 'widget', 1000, 10, 100, 'active')`,
      store
    );
  });
  return stub;
}

describe('accounting flows on the DO, no row lock', () => {
  it('20 concurrent posts of ONE draft: exactly one applies, the other 19 are ALREADY_POSTED, stock and history move once', async () => {
    const stub = await seed('books-post');
    const d = val<{ id: string }>(
      await op(stub, 'books-post', 'createStockAdjustment', {
        type: 'found',
        items: [{ productId: 'p1', newQty: 25 }],
      })
    );
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => op(stub, 'books-post', 'postStockAdjustment', { id: d.id }))
    );
    expect(answers.filter(a => a.ok)).toHaveLength(1);
    const refused = answers.filter(a => !a.ok) as Array<{ code: string; status: number }>;
    expect(refused).toHaveLength(19);
    expect(new Set(refused.map(r => `${r.code}/${r.status}`))).toEqual(
      new Set(['ALREADY_POSTED/409'])
    );
    expect((await sql(stub, `SELECT inventory FROM products WHERE id = 'p1'`))[0]).toEqual({
      inventory: 25,
    });
    expect((await sql(stub, `SELECT count(*) AS n FROM inventory_history`))[0]).toEqual({ n: 1 });
  });

  it('30 concurrent receives of 1 unit against a PO of 10: exactly 10 apply, stock +10, the PO ends received', async () => {
    const stub = await seed('books-receive');
    const po = val<{ id: string }>(
      await op(stub, 'books-receive', 'createPurchaseOrder', {
        supplierId: 'sup1',
        items: [{ productId: 'p1', qty: 10, unitCost: 100 }],
      })
    );
    const item = (await sql<{ id: string }>(stub, `SELECT id FROM purchase_order_items`))[0].id;
    const answers = await Promise.all(
      Array.from({ length: 30 }, () =>
        op(stub, 'books-receive', 'receivePurchaseOrder', {
          poId: po.id,
          receipts: [{ poItemId: item, qtyReceived: 1 }],
        })
      )
    );
    expect(answers.filter(a => a.ok)).toHaveLength(10);
    const codes = new Set((answers.filter(a => !a.ok) as Array<{ code: string }>).map(r => r.code));
    // once complete the PO is no longer receivable; before that the quantity guard answers
    expect([...codes].every(c => c === 'PO_NOT_RECEIVABLE' || c === 'RECEIVE_EXCEEDS_QTY')).toBe(
      true
    );
    expect((await sql(stub, `SELECT inventory FROM products WHERE id = 'p1'`))[0]).toEqual({
      inventory: 20,
    });
    expect((await sql(stub, `SELECT status FROM purchase_orders`))[0]).toEqual({
      status: 'received',
    });
    expect((await sql(stub, `SELECT qty_received FROM purchase_order_items`))[0]).toEqual({
      qty_received: 10,
    });
  });

  it('40 concurrent PO drafts and adjustments get 40 distinct, gap-free numbers each', async () => {
    const stub = await seed('books-numbers');
    await Promise.all([
      ...Array.from({ length: 40 }, () =>
        op(stub, 'books-numbers', 'createPurchaseOrder', {
          supplierId: 'sup1',
          items: [{ productId: 'p1', qty: 1, unitCost: 1 }],
        })
      ),
      ...Array.from({ length: 40 }, () =>
        op(stub, 'books-numbers', 'createStockAdjustment', {
          type: 'found',
          items: [{ productId: 'p1', newQty: 11 }],
        })
      ),
    ]);
    const nums = await sql<{ n: string }>(stub, `SELECT po_number AS n FROM purchase_orders`);
    expect(new Set(nums.map(r => r.n)).size).toBe(40);
    const adj = await sql<{ n: string }>(
      stub,
      `SELECT adjustment_number AS n FROM stock_adjustments`
    );
    expect(new Set(adj.map(r => r.n)).size).toBe(40);
    expect((await sql(stub, `SELECT next FROM sequences WHERE kind = 'po'`))[0]).toEqual({
      next: 41,
    });
  });

  it('10 concurrent CSV imports with ONE import key create one adjustment', async () => {
    const stub = await seed('books-import');
    await Promise.all(
      Array.from({ length: 10 }, () =>
        op(stub, 'books-import', 'createStockAdjustment', {
          type: 'cycle_count',
          importKey: 'csv-import-1',
          items: [{ productId: 'p1', newQty: 3 }],
        })
      )
    );
    expect((await sql(stub, `SELECT count(*) AS n FROM stock_adjustments`))[0]).toEqual({ n: 1 });
  });

  it('10 concurrent opening balances post ONE journal', async () => {
    const stub = await seed('books-opening');
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => op(stub, 'books-opening', 'openingBalance', {}))
    );
    expect(answers.filter(a => a.ok && val<{ posted: boolean }>(a).posted)).toHaveLength(1);
    expect(
      (
        await sql(
          stub,
          `SELECT count(*) AS n FROM journal_entries WHERE source = 'opening_balance'`
        )
      )[0]
    ).toEqual({ n: 1 });
  });

  it('a count session reconciled 10 times concurrently adjusts the stock once', async () => {
    const stub = await seed('books-count');
    const s = val<{ id: string }>(await op(stub, 'books-count', 'openCountSession', {}));
    await op(stub, 'books-count', 'submitCountLine', {
      sessionId: s.id,
      productId: 'p1',
      countedQty: 4,
    });
    await op(stub, 'books-count', 'closeCountSession', { sessionId: s.id });
    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        op(stub, 'books-count', 'reconcileCountSession', { sessionId: s.id })
      )
    );
    expect(answers.filter(a => a.ok)).toHaveLength(1);
    expect((await sql(stub, `SELECT inventory FROM products WHERE id = 'p1'`))[0]).toEqual({
      inventory: 4,
    });
    expect((await sql(stub, `SELECT count(*) AS n FROM stock_adjustments`))[0]).toEqual({ n: 1 });
  });
});
