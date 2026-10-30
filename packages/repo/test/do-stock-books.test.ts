// INFRA-CF-1 R7 (Ruling CF-R7-1): the accounting and scan stock flows on the real DO schema (node:sqlite).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureStockOpsSchema, runStockOp, STOCK_OP_NAMES } from '../src/do/stock-ops';
import { BOOKS_OPS } from '../src/do/stock-books';
import { MoneyError } from '../src/do/sync-sql';

function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureStockOpsSchema(db);
  raw.exec(`
    INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES ('s1', 1);
    INSERT INTO accounts (id, store_id, code, name_en, type, is_system) VALUES
      ('a1200', 's1', '1200', 'Inventory', 'asset', 1), ('a3000', 's1', '3000', 'Equity', 'equity', 1),
      ('a2000', 's1', '2000', 'AP', 'liability', 1);
    INSERT INTO suppliers (id, store_id, name) VALUES ('sup1', 's1', 'Sup');
    INSERT INTO products (id, store_id, name, slug, price, inventory, cost_price, status) VALUES
      ('p1', 's1', 'Plain', 'plain', 1000, 10, 100, 'active'),
      ('pv', 's1', 'Shirt', 'shirt', 0, 0, 50, 'active'),
      ('px', 'other', 'Foreign', 'foreign', 1, 5, 10, 'active');
    INSERT INTO product_variants (id, product_id, title, price, inventory, cost_price) VALUES ('v1', 'pv', 'M', 100, 3, 60), ('v2', 'pv', 'L', 100, 4, NULL);
  `);
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runStockOp(db, 's1', name, args, key) as any;
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
const vinv = (r: ReturnType<typeof rig>, id: string) =>
  r.q('SELECT inventory FROM product_variants WHERE id = ?', id)[0].inventory as number;

it('the op name list equals the implemented books ops', () => {
  for (const n of Object.keys(BOOKS_OPS)) expect(STOCK_OP_NAMES).toContain(n);
});

describe('stock adjustments', () => {
  it('creates a numbered draft with the snapshot, posts once, refuses a foreign id and a second post', () => {
    const r = rig();
    expect(
      r.code('createStockAdjustment', {
        type: 'damage',
        items: [{ productId: 'px', newQty: 1 }],
      })
    ).toBe('NOT_FOUND/404');
    const d = r.op('createStockAdjustment', {
      type: 'damage',
      reason: 'broken',
      items: [
        { productId: 'p1', newQty: 7 },
        { productId: 'pv', variantId: 'v1', newQty: 5 },
      ],
    });
    expect(d.adjustmentNumber).toMatch(/^ADJ-\d{4}-000001$/);
    expect(r.q('SELECT total_value_impact AS t FROM stock_adjustments')[0].t).toBe(
      -3 * 100 + 2 * 60
    );
    expect(inv(r, 'p1')).toBe(10); // a draft moves nothing
    r.op('postStockAdjustment', { id: d.id, postedBy: 'u1' });
    expect(inv(r, 'p1')).toBe(7);
    expect(vinv(r, 'v1')).toBe(5);
    expect(
      r.q(
        'SELECT type, quantity, previous_stock, new_stock, reference FROM inventory_history ORDER BY rowid'
      )
    ).toEqual([
      {
        type: 'damage',
        quantity: -3,
        previous_stock: 10,
        new_stock: 7,
        reference: d.adjustmentNumber,
      },
      {
        type: 'damage',
        quantity: 2,
        previous_stock: 3,
        new_stock: 5,
        reference: d.adjustmentNumber,
      },
    ]);
    expect(r.code('postStockAdjustment', { id: d.id })).toBe('ALREADY_POSTED/409');
    expect(inv(r, 'p1')).toBe(7);
    expect(r.code('postStockAdjustment', { id: 'nope' })).toBe('NOT_FOUND/404');
  });

  it('a CSV import key finds the first adjustment instead of creating a second', () => {
    const r = rig();
    const a = r.op('createStockAdjustment', {
      type: 'cycle_count',
      importKey: 'imp-1',
      items: [{ productId: 'p1', newQty: 4 }],
    });
    const b = r.op('createStockAdjustment', {
      type: 'cycle_count',
      importKey: 'imp-1',
      items: [{ productId: 'p1', newQty: 4 }],
    });
    expect(b).toMatchObject({ id: a.id, replayed: true });
    expect(r.q('SELECT count(*) AS n FROM stock_adjustments')[0].n).toBe(1);
  });

  it('a post that fails midway rolls the claim back (a product that left the store)', () => {
    const r = rig();
    const d = r.op('createStockAdjustment', {
      type: 'found',
      items: [
        { productId: 'pv', variantId: 'v1', newQty: 9 },
        { productId: 'p1', newQty: 9 },
      ],
    });
    r.raw.exec("UPDATE products SET store_id = 'other' WHERE id = 'p1'");
    expect(r.code('postStockAdjustment', { id: d.id })).toBe('NOT_FOUND/404');
    expect(r.q('SELECT status FROM stock_adjustments')[0].status).toBe('draft');
    expect(r.q('SELECT count(*) AS n FROM inventory_history')[0].n).toBe(0);
  });
});

describe('purchase orders', () => {
  const line = (o: Record<string, unknown> = {}) => ({
    productId: 'p1',
    qty: 10,
    unitCost: 200,
    ...o,
  });

  it('drafts with ownership and the variant rules; receives with a weighted-average cost; partial then complete', () => {
    const r = rig();
    expect(
      r.code('createPurchaseOrder', { supplierId: 'sup1', items: [line({ productId: 'px' })] })
    ).toBe('NOT_FOUND/404');
    expect(r.code('createPurchaseOrder', { supplierId: 'nope', items: [line()] })).toBe(
      'NOT_FOUND/404'
    );
    expect(
      r.code('createPurchaseOrder', { supplierId: 'sup1', items: [line({ productId: 'pv' })] })
    ).toBe('VARIANT_REQUIRED/400');
    expect(
      r.code('createPurchaseOrder', { supplierId: 'sup1', items: [line({ variantId: 'v1' })] })
    ).toBe('VARIANT_PRODUCT_MISMATCH/400');
    const po = r.op('createPurchaseOrder', { supplierId: 'sup1', items: [line()] });
    expect(po.poNumber).toMatch(/^PO-\d{4}-000001$/);
    const item = r.q('SELECT id FROM purchase_order_items')[0].id;
    expect(
      r.code('receivePurchaseOrder', {
        poId: po.id,
        receipts: [{ poItemId: item, qtyReceived: 11 }],
      })
    ).toBe('RECEIVE_EXCEEDS_QTY/400');
    const out = r.op('receivePurchaseOrder', {
      poId: po.id,
      receipts: [{ poItemId: item, qtyReceived: 4 }],
    });
    expect(out.status).toBe('partial');
    // WAC: (10*100 + 4*200) / 14 = 128.57 -> 129
    expect(inv(r, 'p1')).toBe(14);
    expect(r.q('SELECT cost_price FROM products WHERE id = ?', 'p1')[0].cost_price).toBe(129);
    expect(
      r.q('SELECT type, quantity, previous_stock, new_stock FROM inventory_history')[0]
    ).toEqual({
      type: 'transfer_in',
      quantity: 4,
      previous_stock: 10,
      new_stock: 14,
    });
    expect(
      r.op('receivePurchaseOrder', { poId: po.id, receipts: [{ poItemId: item, qtyReceived: 6 }] })
        .status
    ).toBe('received');
    expect(inv(r, 'p1')).toBe(20);
    expect(r.code('receivePurchaseOrder', { poId: po.id, receipts: [] })).toBe(
      'PO_NOT_RECEIVABLE/409'
    );
    expect(r.code('cancelPurchaseOrder', { id: po.id })).toBe('PO_ALREADY_RECEIVED/409');
  });

  it('a variant line lands stock and cost on the variant; the parent keeps no stock', () => {
    const r = rig();
    const po = r.op('createPurchaseOrder', {
      supplierId: 'sup1',
      items: [{ productId: 'pv', variantId: 'v1', qty: 3, unitCost: 120 }],
    });
    const item = r.q('SELECT id FROM purchase_order_items')[0].id;
    r.op('receivePurchaseOrder', { poId: po.id, receipts: [{ poItemId: item, qtyReceived: 3 }] });
    expect(vinv(r, 'v1')).toBe(6);
    expect(r.q('SELECT cost_price FROM product_variants WHERE id = ?', 'v1')[0].cost_price).toBe(
      90
    );
    expect(inv(r, 'pv')).toBe(0);
    // history: previous = sum of ACTIVE variants before (3 + 4)
    expect(r.q('SELECT previous_stock, new_stock FROM inventory_history')[0]).toEqual({
      previous_stock: 7,
      new_stock: 10,
    });
  });

  it('clears the oldest backorder first, heals the stock debt and flips the order item out of deferred', () => {
    const r = rig();
    r.raw.exec(`
      UPDATE products SET inventory = -3 WHERE id = 'p1';
      INSERT INTO orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address) VALUES ('o1','s1','1',1,1,'{}','{}');
      INSERT INTO order_items (id, order_id, product_id, product_name, price, quantity, total, cost_price, cost_price_deferred) VALUES
        ('oi1','o1','p1','Plain',100,2,200,150,1), ('oi2','o1','p1','Plain',100,5,500,150,1);
      INSERT INTO backorder_lines (id, store_id, order_item_id, product_id, qty, created_at) VALUES
        ('b1','s1','oi1','p1',2,1000), ('b2','s1','oi2','p1',5,2000);
    `);
    const po = r.op('createPurchaseOrder', {
      supplierId: 'sup1',
      items: [{ productId: 'p1', qty: 4, unitCost: 250 }],
    });
    const item = r.q('SELECT id FROM purchase_order_items')[0].id;
    const out = r.op('receivePurchaseOrder', {
      poId: po.id,
      receipts: [{ poItemId: item, qtyReceived: 4 }],
    });
    // 4 units: b1 takes 2 (oldest, fully), b2 takes 2 of 5 -> nothing is left for the shelf
    expect(out.clearedBackorders).toEqual([
      {
        backorderLineId: 'b1',
        orderItemId: 'oi1',
        qty: 2,
        actualUnitCost: 250,
        estimateUnitCost: 150,
        variance: 200,
      },
      {
        backorderLineId: 'b2',
        orderItemId: 'oi2',
        qty: 2,
        actualUnitCost: 250,
        estimateUnitCost: 150,
        variance: 200,
      },
    ]);
    expect(
      r.q(
        'SELECT id, qty_fulfilled, fulfilled_at IS NOT NULL AS done FROM backorder_lines ORDER BY id'
      )
    ).toEqual([
      { id: 'b1', qty_fulfilled: 2, done: 1 },
      { id: 'b2', qty_fulfilled: 2, done: 0 },
    ]);
    expect(r.q('SELECT id, cost_price_deferred AS d FROM order_items ORDER BY id')).toEqual([
      { id: 'oi1', d: 0 },
      { id: 'oi2', d: 1 },
    ]);
    // the debt of -3 heals by 2 + 2 but never above 0: -3 -> -1 -> 0
    expect(inv(r, 'p1')).toBe(0);
    expect(
      r.q(
        "SELECT type, quantity, previous_stock, new_stock FROM inventory_history WHERE type = 'return_stock' ORDER BY rowid"
      )
    ).toEqual([
      { type: 'return_stock', quantity: 2, previous_stock: -3, new_stock: -1 },
      { type: 'return_stock', quantity: 1, previous_stock: -1, new_stock: 0 },
    ]);
  });
});

describe('opening balance and chart seed', () => {
  it('posts one journal DR inventory / CR equity, once', () => {
    const r = rig();
    const first = r.op('openingBalance', {});
    // p1: 10*100; v1: 3*60; v2: 4*(null -> parent 50) = 1000 + 180 + 200
    expect(first).toEqual({ posted: true, total: 1380, skus: 3 });
    expect(r.op('openingBalance', {}).posted).toBe(false);
    expect(
      r.q("SELECT count(*) AS n FROM journal_entries WHERE source = 'opening_balance'")[0].n
    ).toBe(1);
    expect(r.q('SELECT debit, credit FROM journal_lines ORDER BY debit DESC')).toEqual([
      { debit: 1380, credit: 0 },
      { debit: 0, credit: 1380 },
    ]);
  });

  it('seedCoa adds only the missing system accounts', () => {
    const r = rig();
    const out = r.op('seedCoa', {
      accounts: [
        { code: '1200', nameEn: 'Inventory', type: 'asset' },
        { code: '1000', nameEn: 'Cash', type: 'asset' },
      ],
    });
    expect(out.created).toBe(1);
    expect(r.q("SELECT count(*) AS n FROM accounts WHERE code = '1000'")[0].n).toBe(1);
  });
});

describe('scan flows', () => {
  it('receiveVariant moves the variant and records history; a foreign variant is 404', () => {
    const r = rig();
    const out = r.op('receiveVariant', {
      productId: 'pv',
      variantId: 'v1',
      quantity: 5,
      userId: 'u1',
    });
    expect(out).toMatchObject({ previousInventory: 3, newInventory: 8 });
    expect(r.q('SELECT reason, type FROM inventory_history')[0]).toEqual({
      reason: 'barcode_receive',
      type: 'manual_add',
    });
    expect(r.code('receiveVariant', { productId: 'p1', variantId: 'v1', quantity: 1 })).toBe(
      'VARIANT_NOT_FOUND/404'
    );
  });

  it('a count session: lines upsert, close, reconcile creates and posts the cycle_count adjustment', () => {
    const r = rig();
    const s = r.op('openCountSession', { createdBy: 'u1' });
    r.op('submitCountLine', { sessionId: s.id, productId: 'p1', countedQty: 8 });
    const again = r.op('submitCountLine', { sessionId: s.id, productId: 'p1', countedQty: 6 });
    expect(again).toMatchObject({ systemQty: 10, variance: -4 });
    r.op('submitCountLine', { sessionId: s.id, productId: 'pv', variantId: 'v1', countedQty: 3 });
    expect(r.q('SELECT count(*) AS n FROM count_lines')[0].n).toBe(2);
    expect(r.code('reconcileCountSession', { sessionId: s.id })).toBe('SESSION_NOT_FOUND/404');
    r.op('closeCountSession', { sessionId: s.id });
    expect(r.code('submitCountLine', { sessionId: s.id, productId: 'p1', countedQty: 1 })).toBe(
      'SESSION_NOT_FOUND/404'
    );
    expect(r.code('closeCountSession', { sessionId: s.id })).toBe('SESSION_NOT_OPEN/409');
    const out = r.op('reconcileCountSession', { sessionId: s.id, reconciledBy: 'u1' });
    expect(out).toMatchObject({ linesReconciled: 1, zeroVarianceLines: 1 });
    expect(inv(r, 'p1')).toBe(6);
    expect(r.q('SELECT status, adjustment_id FROM count_sessions')[0].status).toBe('reconciled');
    expect(r.q('SELECT status FROM stock_adjustments')[0].status).toBe('posted');
  });
});

describe('bulk inventory', () => {
  it('sets or adjusts simple products only, floored at 0, and writes no history', () => {
    const r = rig();
    expect(
      r.op('bulkSetInventory', { productIds: ['p1', 'pv', 'px'], mode: 'adjust', value: -50 })
    ).toEqual({
      updated: 1,
    });
    expect(inv(r, 'p1')).toBe(0);
    r.op('bulkSetInventory', { productIds: ['p1'], mode: 'set', value: 12.4 });
    expect(inv(r, 'p1')).toBe(12);
    expect(inv(r, 'px')).toBe(5);
    expect(r.q('SELECT count(*) AS n FROM inventory_history')[0].n).toBe(0);
  });
});
