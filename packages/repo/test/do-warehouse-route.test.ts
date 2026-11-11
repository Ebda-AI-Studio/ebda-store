// WAREHOUSE-ROUTE-1: order creation routes stock lines to one warehouse, in the order's own section (real StoreDO schema).
import { describe, expect, it, vi } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { placeOrder, type CheckoutInput } from '../src/do/checkout';
import { placeAdminOrder } from '../src/do/admin-order';
import { cancelOrder } from '../src/do/refund';
import { releaseToWarehouses } from '../src/do/warehouse-route';
import { MoneyError } from '../src/do/sync-sql';

function fixture(warehouses: Array<[string, number, number]>, inventory?: number) {
  inventory ??= warehouses.length ? warehouses.reduce((n, w) => n + w[2], 0) : 10;
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const all = <T = Record<string, number>>(sql: string, ...p: unknown[]) =>
    raw.prepare(sql).all(...(p as never[])) as T[];
  x(`INSERT INTO store_config (store_id) VALUES ('s1')`);
  x(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', 's1', 'Widget', 'widget', 1500, ?, 'active')`,
    inventory
  );
  // [code, priority, qty]
  warehouses.forEach(([code, priority, qty], i) => {
    x(
      `INSERT INTO warehouses (id, store_id, name, code, priority, is_default) VALUES (?, 's1', ?, ?, ?, ?)`,
      `w-${code}`,
      code,
      code,
      priority,
      i === 0 ? 1 : 0
    );
    if (qty > 0)
      x(
        `INSERT INTO warehouse_stock (id, warehouse_id, product_id, quantity, store_id) VALUES (?, ?, 'p1', ?, 's1')`,
        `ws-${code}`,
        `w-${code}`,
        qty
      );
  });
  const base = (over: Partial<CheckoutInput> = {}, qty = 1): CheckoutInput => ({
    storeId: 's1',
    lines: [{ productId: 'p1', quantity: qty }],
    shippingAddress: { name: 'A' },
    ...over,
  });
  const agg = () =>
    all<{ inventory: number }>(`SELECT inventory FROM products WHERE id='p1'`)[0].inventory;
  const wh = () =>
    Object.fromEntries(
      all<{ code: string; quantity: number }>(
        `SELECT w.code, ws.quantity FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id`
      ).map(r => [r.code, r.quantity])
    );
  const events = (type: string) =>
    all(`SELECT 1 FROM order_events WHERE to_status = ?`, type).length;
  return { raw, db, base, agg, wh, events, all };
}
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as MoneyError).code;
  }
  return 'NO_ERROR';
};

describe('multi-warehouse routing on order creation', () => {
  it('takes the units from the routed (highest priority with enough stock) warehouse', () => {
    const f = fixture([
      ['A', 1, 4],
      ['B', 5, 6],
    ]);
    placeOrder(f.db, f.base({}, 2));
    expect(f.wh()).toEqual({ A: 4, B: 4 });
    expect(f.agg()).toBe(8);
    // B (4 left) cannot hold 5, A (4) neither: refused
    expect(code(() => placeOrder(f.db, f.base({}, 5)))).toBe('NO_SINGLE_WAREHOUSE');
  });

  it('skips a higher-priority warehouse that cannot fulfil the whole line', () => {
    const f = fixture([
      ['A', 1, 6],
      ['B', 5, 2],
    ]);
    placeOrder(f.db, f.base({}, 3));
    expect(f.wh()).toEqual({ A: 3, B: 2 });
  });

  it('refuses (409 NO_SINGLE_WAREHOUSE) when stock exists but no single warehouse holds the line; nothing changes', () => {
    const f = fixture([
      ['A', 1, 3],
      ['B', 5, 3],
    ]);
    expect(code(() => placeOrder(f.db, f.base({}, 5)))).toBe('NO_SINGLE_WAREHOUSE');
    expect(f.wh()).toEqual({ A: 3, B: 3 });
    expect(f.agg()).toBe(6);
    expect(f.all(`SELECT 1 FROM orders`).length).toBe(0);
  });

  it('never oversells: more than the total is OUT_OF_STOCK', () => {
    const f = fixture([
      ['A', 1, 3],
      ['B', 5, 3],
    ]);
    expect(code(() => placeOrder(f.db, f.base({}, 7)))).toBe('OUT_OF_STOCK');
    expect(f.agg()).toBe(6);
  });

  it('a retried create (same idempotency key) does not reserve twice', () => {
    const f = fixture([
      ['A', 1, 4],
      ['B', 5, 6],
    ]);
    const a = placeOrder(f.db, f.base({ idempotencyKey: 'idem-key-0001' }, 2));
    const b = placeOrder(f.db, f.base({ idempotencyKey: 'idem-key-0001' }, 2));
    expect(b.orderId).toBe(a.orderId);
    expect(f.wh()).toEqual({ A: 4, B: 4 });
    expect(f.agg()).toBe(8);
    expect(f.events('warehouse_allocated')).toBe(1);
  });

  it('cancel puts the units back into the SAME warehouse, once', () => {
    const f = fixture([
      ['A', 1, 4],
      ['B', 5, 6],
    ]);
    const o = placeOrder(f.db, f.base({}, 2));
    // a later order drains B further so a wrong "default warehouse" release would show
    placeOrder(f.db, f.base({}, 1));
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(f.wh()).toEqual({ A: 4, B: 5 });
    expect(f.agg()).toBe(9);
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(f.wh()).toEqual({ A: 4, B: 5 });
    expect(f.events('warehouse_released')).toBe(1);
  });

  it('a phone order routes and its cancel releases to the same warehouse', () => {
    const f = fixture([
      ['A', 1, 4],
      ['B', 5, 6],
    ]);
    const o = placeAdminOrder(f.db, {
      storeId: 's1',
      lines: [{ productId: 'p1', quantity: 3 }],
      shippingAddress: { name: 'A' },
      actorId: 'u1',
    });
    expect(f.wh()).toEqual({ A: 4, B: 3 });
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(f.wh()).toEqual({ A: 4, B: 6 });
  });
});

describe('WAREHOUSE-ROUTE-2', () => {
  it('a reasoned phone-order stock override is never refused NO_SINGLE_WAREHOUSE, writes no allocation, and its cancel restores the totals', () => {
    const f = fixture([
      ['A', 1, 4],
      ['B', 5, 6],
    ]);
    const input = {
      storeId: 's1',
      lines: [{ productId: 'p1', quantity: 8 }],
      shippingAddress: { name: 'A' },
      actorId: 'u1',
    };
    expect(code(() => placeAdminOrder(f.db, input))).toBe('NO_SINGLE_WAREHOUSE');
    const o = placeAdminOrder(f.db, {
      ...input,
      overrideStock: true,
      stockOverrideReason: 'phone deal',
    });
    expect(f.agg()).toBe(2);
    expect(f.events('warehouse_allocated')).toBe(0);
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(f.agg()).toBe(10);
    // totals restored; the split is the reconcile's (surplus on the default warehouse), see the known gap
    expect(Object.values(f.wh()).reduce((n, q) => n + q, 0)).toBe(10);
  });

  it('an override order reconciles the warehouse rows at creation: shadow sum == total stock right away', () => {
    const f = fixture([
      ['A', 1, 4],
      ['B', 6, 6],
    ]);
    placeAdminOrder(f.db, {
      storeId: 's1',
      lines: [{ productId: 'p1', quantity: 3 }],
      shippingAddress: { name: 'A' },
      actorId: 'u1',
      overrideStock: true,
      stockOverrideReason: 'phone deal',
    });
    const sum = Object.values(f.wh()).reduce((n, q) => n + q, 0);
    expect(f.agg()).toBe(7);
    expect(sum).toBe(7);
  });

  it('an order from before routing (no allocation): its cancel puts the units on the default warehouse, shadow sum == aggregate', () => {
    const f = fixture([
      ['A', 1, 4],
      ['B', 5, 6],
    ]);
    const o = placeOrder(f.db, f.base({}, 3));
    f.raw.prepare(`DELETE FROM order_events WHERE to_status = 'warehouse_allocated'`).run();
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    expect(f.agg()).toBe(10);
    expect(f.wh()).toEqual({ A: 7, B: 3 }); // default (A) takes the unallocated units
  });

  it('a negative aggregate (backorder) is not a shortfall: no reconcile_shortfall error is logged', () => {
    const f = fixture(
      [
        ['A', 1, 0],
        ['B', 5, 0],
      ],
      -3
    );
    f.raw.prepare(`UPDATE products SET allow_backorder = 1 WHERE id = 'p1'`).run();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      placeOrder(f.db, f.base({ backorderEnabled: true }, 1));
      expect(spy.mock.calls.filter(c => String(c[0]).includes('reconcile_shortfall'))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('give-backs are keyed per order line: an unrouted line cannot use up a routed line of the same product', () => {
    const f = fixture([
      ['A', 1, 4],
      ['B', 5, 6],
    ]);
    const o = placeOrder(
      f.db,
      f.base(
        {
          lines: [
            { productId: 'p1', quantity: 2 },
            { productId: 'p1', quantity: 3 },
          ],
        },
        1
      )
    );
    const items = f.all<{ id: string; quantity: number }>(
      `SELECT id, quantity FROM order_items WHERE order_id = ? ORDER BY quantity`,
      o.orderId
    );
    expect(items).toHaveLength(2);
    expect(f.wh()).toEqual({ A: 4, B: 1 });
    // a line id that was never routed gets nothing from the routed lines' allocations
    releaseToWarehouses(f.db, 's1', o.orderId, 'unrouted-line', 'p1', null, 2, Date.now());
    expect(f.events('warehouse_released')).toBe(0);
    // the 3-unit line gives back exactly its own 3 units to B
    releaseToWarehouses(f.db, 's1', o.orderId, items[1].id, 'p1', null, 3, Date.now());
    expect(f.wh().B).toBe(4);
    // the 2-unit line still has its own 2 outstanding
    releaseToWarehouses(f.db, 's1', o.orderId, items[0].id, 'p1', null, 2, Date.now());
    expect(f.wh().B).toBe(6);
  });
});

describe('single / no warehouse is unchanged', () => {
  const run = (f: ReturnType<typeof fixture>) => {
    const o = placeOrder(f.db, f.base({}, 3));
    const placed = { ...o, orderId: 'x', orderNumber: 'x' };
    cancelOrder(f.db, { storeId: 's1', orderId: o.orderId });
    return {
      placed,
      agg: f.agg(),
      hist: f.all(
        `SELECT type, quantity, previous_stock, new_stock FROM inventory_history ORDER BY rowid`
      ),
    };
  };
  it('one warehouse: same totals, same stock math, no allocation event, shadow untouched by routing', () => {
    const none = run(fixture([]));
    const one = fixture([['A', 1, 10]]);
    const withOne = run(one);
    expect(withOne).toEqual(none);
    expect(one.events('warehouse_allocated')).toBe(0);
    expect(one.events('warehouse_released')).toBe(0);
    expect(one.wh()).toEqual({ A: 10 });
  });
});
