/**
 * INFRA-CF-1 R7 (Ruling CF-R7-4): bypass tests for the StoreDO write RPC guard. Each case has two halves: the OLD behaviour
 * (the static `checkMutation` check alone, then the write on an UNGUARDED client, which is exactly what `runWrites` did) lets
 * the write through and the rows land; the NEW `runWrites` refuses it as an answer and writes nothing.
 *
 * Classes (found in the FWB twin's DO write RPC, checked here against Ebda's):
 *  1. a parser differential: the guard read the args with its own key scan, the executor reads them by relation. A write to a
 *     money/stock model that the scan does not name (a stock table reached through a writable parent) or that sits past the
 *     scan's depth cut-off was never validated.
 *  2. connect: linking to (re-parenting) a row of a money model through a nested `connect` was not checked at all.
 *  3. placeholders: Ebda's wire has NO `$ref` / placeholder resolution (args are literal, decoded once before `runWrites`);
 *     the guard now runs inside the executor on the values it actually writes, so there is no pre-resolution window.
 */
import { describe, expect, it } from 'vitest';
import { createPrismaLite } from '../src/prisma-lite/client';
import { decodeRpc } from '../src/rpc/codec';
import {
  checkMutation,
  ensureIdempotencySchema,
  runWrites,
  type DoMutation,
} from '../src/rpc/writes';
import { META, openSqlite } from './diff-harness';
import { nodeSqlRunner } from './node-sql';

const S = 'store-a';
function rig() {
  const db = openSqlite();
  const sql = nodeSqlRunner(db);
  ensureIdempotencySchema(sql);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: S }) as never;
  db.exec(`
    INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', '${S}', 'P', 'p', 100, 5, 'active');
    INSERT INTO product_variants (id, product_id, title, price, inventory) VALUES ('v1', 'p1', 'M', 100, 3);
    INSERT INTO orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address) VALUES ('o1', '${S}', '1', 1, 1, '{}', '{}');
    INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p2', '${S}', 'Q', 'q', 100, 5, 'active');
    INSERT INTO order_items (id, order_id, product_id, product_name, price, quantity, total) VALUES ('oi1', 'o1', 'p2', 'Q', 1, 1, 1);
  `);
  const n = (t: string) =>
    (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n;
  /** What `runWrites` did before CF-R7-4: the static check, then the ops on an unguarded client. */
  const old = async (m: DoMutation) => {
    const bad = checkMutation(m);
    if (bad) return bad;
    for (const q of m.ops) {
      const d = (lite as any)[q.model[0].toLowerCase() + q.model.slice(1)];
      await d[q.op](q.args);
    }
    return { ok: true as const };
  };
  return { db, sql, lite, n, old, run: (m: DoMutation) => runWrites(lite, sql, m) };
}
const refused = (r: unknown, code: string) => expect(r).toMatchObject({ ok: false, code });

describe('class 1: a stock/money write the key scan never named', () => {
  const m: DoMutation = {
    ops: [
      {
        model: 'Product',
        op: 'update',
        args: {
          where: { id: 'p1' },
          data: {
            // a stock table (warehouse_stock) and the stock ledger (inventory_history), reached through a writable parent
            warehouseStock: { create: { storeId: S, warehouseId: 'w', quantity: 999 } },
            inventoryHistory: {
              create: {
                storeId: S,
                type: 'manual_add',
                quantity: 999,
                previousStock: 0,
                newStock: 999,
              },
            },
          },
        },
      },
    ],
  };
  it('old: passes the static check and the rows land', async () => {
    const r = rig();
    r.db.exec(`INSERT INTO warehouses (id, store_id, name, code) VALUES ('w', '${S}', 'W', 'W')`);
    expect(checkMutation(m)).toBeUndefined();
    await r.old(m);
    expect(r.n('inventory_history')).toBe(1);
    expect(r.n('warehouse_stock')).toBe(1);
  });
  it('new: refused as MODEL_NOT_WRITABLE, nothing written', async () => {
    const r = rig();
    r.db.exec(`INSERT INTO warehouses (id, store_id, name, code) VALUES ('w', '${S}', 'W', 'W')`);
    refused(await r.run(m), 'MODEL_NOT_WRITABLE');
    expect(r.n('inventory_history')).toBe(0);
    expect(r.n('warehouse_stock')).toBe(0);
  });

  it('a stock column reached through a NON-product parent (a cart line creating a product) is refused', async () => {
    const r = rig();
    const viaCart: DoMutation = {
      ops: [
        {
          model: 'CartItem',
          op: 'create',
          args: {
            data: {
              cart: { create: { storeId: S, sessionId: 's1' } },
              product: {
                create: {
                  storeId: S,
                  name: 'X',
                  slug: 'x',
                  price: 1,
                  inventory: 777,
                  status: 'active',
                },
              },
              quantity: 1,
            },
          },
        },
      ],
    };
    expect(checkMutation(viaCart)).toBeUndefined(); // old: CartItem has no stock columns, so nothing was looked at
    refused(await r.run(viaCart), 'STOCK_WRITE_REFUSED');
    expect(r.db.prepare("SELECT count(*) AS n FROM products WHERE slug = 'x'").get()).toEqual({
      n: 0,
    });
  });

  it('a value nested deeper than the old scan looked is refused (the cut-off failed OPEN)', () => {
    // old touchesStock stopped at depth 6 and answered "no stock column here"
    const oldTouchesStock = (cols: string[], v: unknown, depth = 0): boolean => {
      if (v === null || typeof v !== 'object' || depth > 6) return false;
      if (Array.isArray(v)) return v.some(x => oldTouchesStock(cols, x, depth + 1));
      return Object.entries(v as object).some(
        ([k, x]) =>
          x !== undefined &&
          (cols.includes(k) || (typeof x === 'object' && oldTouchesStock(cols, x, depth + 1)))
      );
    };
    let deep: any = { inventory: 9 };
    for (let i = 0; i < 8; i++) deep = { x: deep };
    expect(oldTouchesStock(['inventory'], deep)).toBe(false);
    const bad = checkMutation({
      ops: [
        {
          model: 'Product',
          op: 'update',
          args: { where: { id: 'p1' }, data: { description: deep } },
        },
      ],
    });
    expect(bad).toMatchObject({ ok: false, code: 'STOCK_WRITE_REFUSED' });
  });

  it('bare-form and unknown nested operations fail closed (no second parser to disagree with)', async () => {
    const r = rig();
    for (const nested of [
      { variants: { update: { inventory: 9 } } }, // bare: no { where, data }
      { variants: { updateMany: { data: { inventory: 9 } } } },
      { variants: { bogus: { price: 1 } } },
    ]) {
      const out = await r.run({
        ops: [{ model: 'Product', op: 'update', args: { where: { id: 'p1' }, data: nested } }],
      });
      expect(out.ok).toBe(false);
    }
    expect(r.db.prepare("SELECT inventory FROM product_variants WHERE id = 'v1'").get()).toEqual({
      inventory: 3,
    });
  });
});

describe('class 2: connect / connectOrCreate to a model the DO does not own', () => {
  const m: DoMutation = {
    ops: [
      {
        model: 'Product',
        op: 'update',
        // re-parent a money row (an order line) onto this product
        args: { where: { id: 'p1' }, data: { orderItems: { connect: { id: 'oi1' } } } },
      },
    ],
  };
  it('old: the order line is re-pointed at another product', async () => {
    const r = rig();
    expect(checkMutation(m)).toBeUndefined();
    await r.old(m);
    expect(r.db.prepare("SELECT product_id FROM order_items WHERE id = 'oi1'").get()).toEqual({
      product_id: 'p1',
    });
  });
  it('new: refused as MODEL_NOT_WRITABLE and the order line is untouched', async () => {
    const r = rig();
    refused(await r.run(m), 'MODEL_NOT_WRITABLE');
    expect(r.db.prepare("SELECT product_id FROM order_items WHERE id = 'oi1'").get()).toEqual({
      product_id: 'p2',
    });
  });
  it('a nested disconnect / set / delete of a non-writable model is refused too', async () => {
    const r = rig();
    for (const nested of [
      { orderItems: { disconnect: { id: 'oi1' } } },
      { orderItems: { deleteMany: {} } },
      { orderItems: { updateMany: { data: { price: 1 } } } },
    ]) {
      const out = await r.run({
        ops: [{ model: 'Product', op: 'update', args: { where: { id: 'p2' }, data: nested } }],
      });
      expect(out).toMatchObject({ ok: false });
    }
    expect(r.n('order_items')).toBe(1);
  });
  it('control: a nested connect to a WRITABLE model (a variant option to its variant) still works', async () => {
    const r = rig();
    const out = await r.run({
      ops: [
        {
          model: 'ProductOption',
          op: 'create',
          args: { data: { product: { connect: { id: 'p1' } }, name: 'Size', position: 0 } },
        },
      ],
    });
    expect(out.ok).toBe(true);
    expect(decodeRpc<any[]>((out as { json: string }).json)[0].name).toBe('Size');
  });
});

describe('class 3: placeholders and resolution order', () => {
  it('the wire has no $ref resolution: a $ref-shaped value is a literal and cannot stand in for a stock write', async () => {
    const r = rig();
    for (const data of [{ inventory: { $ref: 'x' } }, { $ref: 'p1' }]) {
      const out = await r.run({
        ops: [{ model: 'Product', op: 'update', args: { where: { id: 'p1' }, data } }],
      });
      expect(out.ok).toBe(false);
    }
    expect(r.db.prepare("SELECT inventory FROM products WHERE id = 'p1'").get()).toEqual({
      inventory: 5,
    });
  });
  it('the guard runs inside the executor on the values it writes: a client that cannot bind it is refused, never run unguarded', async () => {
    const r = rig();
    const bare = { product: {} } as never; // no $guarded
    const out = await runWrites(bare, r.sql, {
      ops: [{ model: 'Product', op: 'update', args: { where: { id: 'p1' }, data: { name: 'n' } } }],
    });
    refused(out, 'NO_WRITE_GUARD');
  });
});
