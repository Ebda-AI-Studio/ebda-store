// PR D2a (Ruling CF-STOCK-1): the stock operations of the StoreDO on the real DO schema (node:sqlite).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureStockOpsSchema, runStockOp } from '../src/do/stock-ops';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureStockOpsSchema(db);
  raw.exec(`
    INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES
      ('p1', 's1', 'Plain', 'plain', 1000, 10, 'active'),
      ('pv', 's1', 'Shirt', 'shirt', 0, 0, 'active'),
      ('gone', 's1', 'Gone', 'gone', 1, 5, 'active');
    UPDATE products SET deleted_at = 1 WHERE id = 'gone';
    INSERT INTO product_variants (id, product_id, title, price, inventory) VALUES ('v1', 'pv', 'M', 100, 3), ('v2', 'pv', 'L', 100, 4);
  `);
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runStockOp(db, S, name, args, key) as any;
  const code = (name: string, args: Record<string, unknown>): string => {
    try {
      op(name, args);
    } catch (e) {
      return `${(e as MoneyError).code}/${(e as MoneyError).status}`;
    }
    return 'no error';
  };
  return { raw, db, q, op, code };
}
const inv = (r: ReturnType<typeof rig>, id: string) =>
  r.q('SELECT inventory FROM products WHERE id = ?', id)[0].inventory as number;

describe('adjustProduct / setProduct', () => {
  it('moves stock, records the history row, refuses below zero and variant products', () => {
    const r = rig();
    const out = r.op('adjustProduct', {
      productId: 'p1',
      quantity: -4,
      type: 'manual_remove',
      reason: 'broken',
      userId: 'u1',
    });
    expect(out).toMatchObject({ previousStock: 10, newStock: 6 });
    expect(inv(r, 'p1')).toBe(6);
    expect(
      r.q(
        'SELECT type, quantity, previous_stock, new_stock, reason, created_by FROM inventory_history'
      )
    ).toEqual([
      {
        type: 'manual_remove',
        quantity: -4,
        previous_stock: 10,
        new_stock: 6,
        reason: 'broken',
        created_by: 'u1',
      },
    ]);
    expect(r.code('adjustProduct', { productId: 'p1', quantity: -7, type: 'manual_remove' })).toBe(
      'INSUFFICIENT_STOCK/400'
    );
    expect(inv(r, 'p1')).toBe(6);
    expect(r.code('adjustProduct', { productId: 'pv', quantity: 1, type: 'manual_add' })).toBe(
      'VARIANT_PRODUCT/400'
    );
    expect(r.code('adjustProduct', { productId: 'gone', quantity: 1, type: 'manual_add' })).toBe(
      'NOT_FOUND/404'
    );
    expect(r.code('adjustProduct', { productId: 'p1', quantity: 1, type: 'nope' })).toBe(
      'BAD_ARGS/400'
    );
  });

  it('is scoped to the store: another store id finds nothing', () => {
    const r = rig();
    expect(() =>
      runStockOp(r.db, 'other', 'adjustProduct', {
        productId: 'p1',
        quantity: 1,
        type: 'manual_add',
      })
    ).toThrow(/Product not found/);
  });

  it('setProduct writes an absolute count with the default reason', () => {
    const r = rig();
    r.op('setProduct', { productId: 'p1', quantity: 25 });
    expect(inv(r, 'p1')).toBe(25);
    expect(r.q('SELECT type, quantity, reason FROM inventory_history')[0]).toEqual({
      type: 'adjustment',
      quantity: 15,
      reason: 'Inventory count adjustment',
    });
    expect(r.code('setProduct', { productId: 'p1', quantity: -1 })).toBe('BAD_ARGS/400');
  });
});

describe('bulkAdjustProducts', () => {
  it('a bad row fails alone and the rest apply with one history row each', () => {
    const r = rig();
    const out = r.op('bulkAdjustProducts', {
      adjustments: [
        { productId: 'p1', quantity: 5, type: 'manual_add' },
        { productId: 'nope', quantity: 1, type: 'manual_add' },
        { productId: 'pv', quantity: 1, type: 'manual_add' },
        { productId: 'p1', quantity: -100, type: 'manual_remove' },
      ],
    });
    expect(out).toMatchObject({ successful: 1, failed: 3 });
    expect(out.errors).toEqual([
      'Product nope: NOT_FOUND',
      'Shirt: tracks stock on its variants — adjust the variant inventory instead',
      'Product p1: INSUFFICIENT_STOCK',
    ]);
    expect(inv(r, 'p1')).toBe(15);
    expect(r.q('SELECT count(*) AS n FROM inventory_history')[0].n).toBe(1);
  });
});

describe('setVariantInventory', () => {
  it('sets per variant; a variant of another product fails alone; a missing product is 404', () => {
    const r = rig();
    const out = r.op('setVariantInventory', {
      productId: 'pv',
      updates: [
        { variantId: 'v1', inventory: 9 },
        { variantId: 'zzz', inventory: 1 },
      ],
    });
    expect(out).toMatchObject({ updated: 1, failed: 1 });
    expect(r.q('SELECT inventory FROM product_variants WHERE id = ?', 'v1')[0].inventory).toBe(9);
    expect(r.code('setVariantInventory', { productId: 'nope', updates: [] })).toBe('NOT_FOUND/404');
  });
});

describe('setVariantActive', () => {
  it('flips is_active with a quantity-0 history row when the variant holds units; no-op and missing rows', () => {
    const r = rig();
    const units = r.q('SELECT inventory FROM product_variants WHERE id = ?', 'v1')[0]
      .inventory as number;
    const before = r.q('SELECT count(*) AS n FROM inventory_history')[0].n as number;
    const off = r.op('setVariantActive', { productId: 'pv', variantId: 'v1', isActive: false });
    expect(off).toMatchObject({ changed: true });
    expect(r.q('SELECT is_active FROM product_variants WHERE id = ?', 'v1')[0].is_active).toBe(0);
    const h = r.q(
      'SELECT quantity, previous_stock, new_stock, reference FROM inventory_history ORDER BY rowid DESC LIMIT 1'
    )[0];
    if (units !== 0) {
      expect(h).toMatchObject({
        quantity: 0,
        previous_stock: units,
        new_stock: units,
        reference: 'variant:v1',
      });
      expect(r.q('SELECT count(*) AS n FROM inventory_history')[0].n).toBe(before + 1);
    } else expect(r.q('SELECT count(*) AS n FROM inventory_history')[0].n).toBe(before);
    expect(r.op('setVariantActive', { productId: 'pv', variantId: 'v1', isActive: false })).toEqual(
      {
        changed: false,
        historyId: null,
      }
    );
    expect(r.code('setVariantActive', { productId: 'pv', variantId: 'zzz', isActive: true })).toBe(
      'NOT_FOUND/404'
    );
    expect(r.code('setVariantActive', { productId: 'nope', variantId: 'v1', isActive: true })).toBe(
      'NOT_FOUND/404'
    );
    expect(r.code('setVariantActive', { productId: 'pv', variantId: 'v1', isActive: 'yes' })).toBe(
      'BAD_ARGS/400'
    );
  });
});

describe('warehouses', () => {
  function withWh() {
    const r = rig();
    r.raw.exec(
      `INSERT INTO warehouses (id, store_id, name, code, is_default) VALUES ('w1', 's1', 'Main', 'MAIN', 1), ('w2', 's1', 'Second', 'SEC', 0)`
    );
    return r;
  }
  it('set + adjust keep the aggregate equal to the sum, floor at zero, and audit', () => {
    const r = withWh();
    expect(r.op('setWarehouseStock', { warehouseId: 'w1', productId: 'p1', quantity: 7 })).toEqual({
      quantity: 7,
    });
    expect(r.op('setWarehouseStock', { warehouseId: 'w2', productId: 'p1', quantity: 5 })).toEqual({
      quantity: 5,
    });
    expect(inv(r, 'p1')).toBe(12);
    expect(
      r.op('adjustWarehouseStock', {
        warehouseId: 'w1',
        productId: 'p1',
        delta: -20,
        reason: 'lost',
      })
    ).toEqual({ newQuantity: 0 });
    expect(inv(r, 'p1')).toBe(5);
    expect(
      r.q(
        'SELECT type, quantity, previous_stock, new_stock, reason, reference FROM inventory_history'
      )[0]
    ).toEqual({
      type: 'manual_remove',
      quantity: -20,
      previous_stock: 7,
      new_stock: 0,
      reason: '[Warehouse: MAIN] lost',
      reference: 'w1',
    });
    expect(
      r.q(
        'SELECT count(*) AS n FROM warehouse_stock WHERE product_id = ? AND variant_id IS NULL',
        'p1'
      )[0].n
    ).toBe(2);
  });
  it('#632: a warehouse edit after a sale never resurrects the sold units (sale -> adjust -> aggregate)', () => {
    const r = withWh();
    r.op('setWarehouseStock', { warehouseId: 'w1', productId: 'p1', quantity: 10 });
    expect(inv(r, 'p1')).toBe(10);
    // a checkout sells 4: it decrements the aggregate only, the warehouse shadow still says 10
    r.raw.exec(`UPDATE products SET inventory = 6 WHERE id = 'p1'`);
    r.op('adjustWarehouseStock', {
      warehouseId: 'w1',
      productId: 'p1',
      delta: 5,
      reason: 'delivery',
    });
    expect(inv(r, 'p1')).toBe(11); // was 15: four phantom units
    expect(
      r.q(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = 'w1' AND product_id = 'p1'`)[0]
        .quantity
    ).toBe(11);
  });
  it('#632: two warehouses, a sale, then an edit of the OTHER warehouse: the aggregate stays real', () => {
    const r = withWh();
    r.op('setWarehouseStock', { warehouseId: 'w1', productId: 'p1', quantity: 7 });
    r.op('setWarehouseStock', { warehouseId: 'w2', productId: 'p1', quantity: 5 });
    r.raw.exec(`UPDATE products SET inventory = 8 WHERE id = 'p1'`); // 4 sold
    r.op('adjustWarehouseStock', { warehouseId: 'w2', productId: 'p1', delta: 1 });
    expect(inv(r, 'p1')).toBe(9); // was 13
    r.op('setWarehouseStock', { warehouseId: 'w2', productId: 'p1', quantity: 2 });
    expect(inv(r, 'p1')).toBe(5); // the default warehouse absorbed the sale: 3 + 2
  });
  it('variant rows aggregate onto the variant; refusals match the Postgres codes', () => {
    const r = withWh();
    r.op('setWarehouseStock', { warehouseId: 'w1', productId: 'pv', variantId: 'v1', quantity: 2 });
    r.op('adjustWarehouseStock', { warehouseId: 'w2', productId: 'pv', variantId: 'v1', delta: 3 });
    expect(r.q('SELECT inventory FROM product_variants WHERE id = ?', 'v1')[0].inventory).toBe(5);
    expect(r.code('setWarehouseStock', { warehouseId: 'w1', productId: 'pv', quantity: 1 })).toBe(
      'VARIANT_PRODUCT/400'
    );
    expect(r.code('setWarehouseStock', { warehouseId: 'nope', productId: 'p1', quantity: 1 })).toBe(
      'WAREHOUSE_NOT_FOUND/404'
    );
    expect(r.code('setWarehouseStock', { warehouseId: 'w1', productId: 'nope', quantity: 1 })).toBe(
      'PRODUCT_NOT_FOUND/404'
    );
    expect(r.code('setWarehouseStock', { warehouseId: 'w1', productId: 'p1', quantity: -1 })).toBe(
      'INVALID_QUANTITY/400'
    );
  });
  it('a product-level adjust re-syncs the default warehouse shadow inside the same section', () => {
    const r = withWh();
    r.op('setWarehouseStock', { warehouseId: 'w2', productId: 'p1', quantity: 4 });
    r.op('adjustProduct', { productId: 'p1', quantity: 6, type: 'manual_add' });
    const sum = r.q('SELECT SUM(quantity) AS s FROM warehouse_stock WHERE product_id = ?', 'p1')[0]
      .s;
    expect(sum).toBe(inv(r, 'p1'));
  });
});

describe('reconcile deficit (WAREHOUSE-NEG-1)', () => {
  const quantities = (r: ReturnType<typeof rig>, variant: string | null = null) =>
    r.q(
      `SELECT warehouse_id AS w, quantity AS q FROM warehouse_stock WHERE product_id = ? AND ${variant ? 'variant_id = ?' : 'variant_id IS NULL'} ORDER BY warehouse_id`,
      ...(variant ? ['pv', variant] : ['p1'])
    );
  function withThree() {
    const r = rig();
    r.raw.exec(
      `INSERT INTO warehouses (id, store_id, name, code, is_default, priority) VALUES ('w1', 's1', 'Main', 'MAIN', 1, 0), ('w2', 's1', 'Second', 'SEC', 0, 5), ('w3', 's1', 'Third', 'THI', 0, 9)`
    );
    return r;
  }
  it('a count below the shadow spreads the deficit default-first and never goes negative', () => {
    const r = withThree();
    r.op('setWarehouseStock', { warehouseId: 'w1', productId: 'p1', quantity: 2 });
    r.op('setWarehouseStock', { warehouseId: 'w2', productId: 'p1', quantity: 4 });
    r.op('setWarehouseStock', { warehouseId: 'w3', productId: 'p1', quantity: 10 });
    r.op('setProduct', { productId: 'p1', quantity: 5 });
    // deficit 11: default 2 -> 0, then priority desc: w3 9 of its 10 -> 1, w2 untouched
    expect(quantities(r)).toEqual([
      { w: 'w1', q: 0 },
      { w: 'w2', q: 4 },
      { w: 'w3', q: 1 },
    ]);
    expect(inv(r, 'p1')).toBe(5);
  });
});

describe('idempotency and atomicity', () => {
  it('a replayed key returns the first result without a second write; another payload is refused', () => {
    const r = rig();
    const a = { productId: 'p1', quantity: -1, type: 'sale' };
    const first = r.op('adjustProduct', a, 'order-1:p1:sale');
    const again = r.op('adjustProduct', a, 'order-1:p1:sale');
    expect(again).toEqual(first);
    expect(inv(r, 'p1')).toBe(9);
    expect(r.q('SELECT count(*) AS n FROM inventory_history')[0].n).toBe(1);
    expect(() => r.op('adjustProduct', { ...a, quantity: -2 }, 'order-1:p1:sale')).toThrow(
      /key used for another/
    );
  });
  it('a failing operation leaves no marker and no row, so the retry runs', () => {
    const r = rig();
    expect(r.code('adjustProduct', { productId: 'p1', quantity: -99, type: 'sale' })).toBe(
      'INSUFFICIENT_STOCK/400'
    );
    expect(() =>
      r.op('adjustProduct', { productId: 'p1', quantity: -99, type: 'sale' }, 'retry-key-1')
    ).toThrow();
    expect(r.q('SELECT count(*) AS n FROM _stock_ops')[0].n).toBe(0);
    expect(r.q('SELECT count(*) AS n FROM inventory_history')[0].n).toBe(0);
  });
  it('refuses an unknown operation and a malformed key', () => {
    const r = rig();
    expect(r.code('dropEverything', {})).toBe('STOCK_OP_NOT_ALLOWED/400');
    expect(() =>
      r.op('adjustProduct', { productId: 'p1', quantity: 1, type: 'sale' }, 'x')
    ).toThrow(/key/);
  });
});

describe('reconcileWarehouseSku / reconcileWarehouseAll (Ruling CF-JOBS-4)', () => {
  function drifted() {
    const r = rig();
    r.raw.exec(
      `INSERT INTO warehouses (id, store_id, name, code, is_default) VALUES ('w1', 's1', 'Main', 'MAIN', 1), ('w2', 's1', 'Second', 'SEC', 0)`
    );
    r.op('setWarehouseStock', { warehouseId: 'w1', productId: 'p1', quantity: 6 });
    r.op('setWarehouseStock', { warehouseId: 'w2', productId: 'p1', quantity: 4 });
    // the aggregate moved without the shadow (order placement does this): 10 -> 7
    r.raw.exec(`UPDATE products SET inventory = 7 WHERE id = 'p1'`);
    return r;
  }
  const sum = (r: ReturnType<typeof rig>) =>
    r.q(`SELECT COALESCE(SUM(quantity),0) s FROM warehouse_stock WHERE product_id = 'p1'`)[0].s;

  it('one SKU: the shadow returns to the aggregate, and a second call is a no-op', () => {
    const r = drifted();
    expect(r.op('reconcileWarehouseSku', { productId: 'p1' })).toMatchObject({ reconciled: true });
    expect(sum(r)).toBe(7);
    expect(r.op('reconcileWarehouseSku', { productId: 'p1' })).toMatchObject({ reconciled: false });
  });

  it('the sweep reconciles every drifted SKU in pages and reports the rest', () => {
    const r = drifted();
    const a = r.op('reconcileWarehouseAll', { limit: 500 });
    expect(a).toMatchObject({ skusReconciled: 1, skusFailed: 0, more: false });
    expect(sum(r)).toBe(7);
    expect(r.op('reconcileWarehouseAll', {})).toMatchObject({ skusReconciled: 0 });
  });

  it('a store with no warehouse is a no-op', () => {
    const r = rig();
    expect(r.op('reconcileWarehouseSku', { productId: 'p1' })).toMatchObject({ reconciled: false });
    expect(r.op('reconcileWarehouseAll', {})).toMatchObject({ skusReconciled: 0, more: false });
  });
});
