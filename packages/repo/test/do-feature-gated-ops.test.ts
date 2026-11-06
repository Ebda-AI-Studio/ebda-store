// Ruling NZ-FEAT-1: the feature-gated operations added on the DO schema (node:sqlite): backorder cancel (money op, one section:
// claim, deferred-cost flag, stock-debt heal, marker), scan-to-pick (stock op, capped), and the affiliate money columns that the
// generic writer refuses.
import { describe, expect, it } from 'vitest';
import { openSqlite, META } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { nodeSqlRunner } from './node-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';
import { ensureStockOpsSchema, runStockOp, STOCK_OP_NAMES } from '../src/do/stock-ops';
import { createPrismaLite } from '../src/prisma-lite/client';
import { runWrites, ensureIdempotencySchema } from '../src/rpc/writes';

const S = 's1';
function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  ensureStockOpsSchema(db);
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  raw.exec(`
    INSERT INTO products (id, store_id, name, slug, price, inventory, track_inventory) VALUES ('p1', 's1', 'Abaya', 'abaya', 1000, -2, 1);
    INSERT INTO products (id, store_id, name, slug, price, inventory, track_inventory) VALUES ('p2', 's1', 'Scarf', 'scarf', 500, 10, 1);
    INSERT INTO orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address) VALUES ('o1', 's1', 'ORD-1', 4000, 4000, '{}', '{}');
    INSERT INTO orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address) VALUES ('o2', 's2', 'ORD-2', 500, 500, '{}', '{}');
    INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total, cost_price_deferred) VALUES ('i1', 'o1', 'p1', 'Abaya', 3, 1000, 3000, 1);
    INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total) VALUES ('i2', 'o1', 'p2', 'Scarf', 1, 500, 500);
    INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total) VALUES ('i3', 'o1', 'p2', 'Scarf', 1, 500, 500);
    INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total) VALUES ('i9', 'o2', 'p2', 'Scarf', 1, 500, 500);
    INSERT INTO backorder_lines (id, store_id, order_item_id, product_id, qty, stock_taken) VALUES ('b1', 's1', 'i1', 'p1', 3, 3);
  `);
  const money = (name: string, args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, S, name, args, key) as any;
  const stock = (name: string, args: Record<string, unknown>, storeId = S) =>
    runStockOp(db, storeId, name, args) as any;
  return { raw, db, q, money, stock };
}

describe('feature-gated operations on the DO (Ruling NZ-FEAT-1)', () => {
  it('are registered', () => {
    expect(MONEY_OP_NAMES).toContain('backorderCancel');
    expect(STOCK_OP_NAMES).toContain('pickOrderItem');
  });

  describe('backorderCancel', () => {
    it('claims the line once, clears the deferred flag, heals only the negative stock, writes the marker', () => {
      const r = rig();
      const out = r.money(
        'backorderCancel',
        { backorderLineId: 'b1', reason: 'discontinued', userId: 'u1' },
        'backorder-cancel:b1'
      );
      expect(out).toEqual({
        found: true,
        orderId: 'o1',
        orderItemId: 'i1',
        quantity: 3,
        stockRestored: 2,
      });
      expect(r.q(`SELECT inventory FROM products WHERE id = 'p1'`)[0].inventory).toBe(0);
      expect(
        r.q(`SELECT cost_price_deferred FROM order_items WHERE id = 'i1'`)[0].cost_price_deferred
      ).toBe(0);
      expect(
        r.q(`SELECT cancelled_reason FROM backorder_lines WHERE id = 'b1'`)[0].cancelled_reason
      ).toBe('discontinued');
      const hist = r.q(
        `SELECT type, quantity, previous_stock, new_stock, reference FROM inventory_history`
      );
      expect(hist).toEqual([
        {
          type: 'return_stock',
          quantity: 2,
          previous_stock: -2,
          new_stock: 0,
          reference: 'backorder:b1',
        },
      ]);
      const ev = r.q(`SELECT to_status, metadata FROM order_events WHERE order_id = 'o1'`);
      expect(ev).toHaveLength(1);
      expect(ev[0].to_status).toBe('backorder_line_cancelled');
      expect(JSON.parse(ev[0].metadata)).toMatchObject({
        refundKey: 'backorder:b1',
        backorderLineId: 'b1',
        items: [{ orderItemId: 'i1', quantity: 3 }],
        stockRestored: 2,
      });
      // a keyed replay answers the same, heals nothing twice, writes no second marker
      expect(
        r.money(
          'backorderCancel',
          { backorderLineId: 'b1', reason: 'discontinued', userId: 'u1' },
          'backorder-cancel:b1'
        )
      ).toEqual(out);
      expect(r.q(`SELECT inventory FROM products WHERE id = 'p1'`)[0].inventory).toBe(0);
      expect(r.q(`SELECT COUNT(*) AS n FROM order_events`)[0].n).toBe(1);
      // unkeyed second cancel: the line is no longer open
      expect(r.money('backorderCancel', { backorderLineId: 'b1', reason: 'again' })).toEqual({
        found: false,
      });
    });

    it('refuses an unknown line, another store, a missing reason; keeps the flag while another line is open', () => {
      const r = rig();
      expect(r.money('backorderCancel', { backorderLineId: 'nope', reason: 'x' })).toEqual({
        found: false,
      });
      expect(
        runMoneyOp(r.db, 's2', 'backorderCancel', { backorderLineId: 'b1', reason: 'x' })
      ).toEqual({
        found: false,
      });
      expect(() => r.money('backorderCancel', { backorderLineId: 'b1', reason: '' })).toThrow();
      r.raw.exec(
        `INSERT INTO backorder_lines (id, store_id, order_item_id, product_id, qty, stock_taken) VALUES ('b2', 's1', 'i1', 'p1', 1, 1)`
      );
      r.money('backorderCancel', { backorderLineId: 'b1', reason: 'x' });
      expect(
        r.q(`SELECT cost_price_deferred FROM order_items WHERE id = 'i1'`)[0].cost_price_deferred
      ).toBe(1);
    });
  });

  describe('pickOrderItem', () => {
    it('fills the first open line, caps at its quantity, moves to the next line, then reports already picked', () => {
      const r = rig();
      const a = r.stock('pickOrderItem', { orderId: 'o1', productId: 'p2', qty: 5 });
      expect(a).toMatchObject({
        kind: 'picked',
        item: { id: 'i2' },
        pickedQtyBefore: 0,
        pickedQtyAfter: 1,
        orderFullyPicked: false,
      });
      const b = r.stock('pickOrderItem', { orderId: 'o1', productId: 'p2', qty: 1 });
      expect(b).toMatchObject({ kind: 'picked', item: { id: 'i3' }, pickedQtyAfter: 1 });
      expect(r.stock('pickOrderItem', { orderId: 'o1', productId: 'p2', qty: 1 })).toEqual({
        kind: 'already_picked',
      });
      const c = r.stock('pickOrderItem', { orderId: 'o1', productId: 'p1', qty: 3 });
      expect(c).toMatchObject({ kind: 'picked', pickedQtyAfter: 3, orderFullyPicked: true });
      expect(r.q(`SELECT picked_at FROM order_items WHERE id = 'i1'`)[0].picked_at).toBeGreaterThan(
        0
      );
    });

    it('never picks another store order or a product not on the order', () => {
      const r = rig();
      expect(r.stock('pickOrderItem', { orderId: 'o2', productId: 'p2', qty: 1 })).toEqual({
        kind: 'not_in_order',
      });
      expect(r.stock('pickOrderItem', { orderId: 'o1', productId: 'zz', qty: 1 })).toEqual({
        kind: 'not_in_order',
      });
      expect(() => r.stock('pickOrderItem', { orderId: 'o1', productId: 'p2', qty: 0 })).toThrow();
      expect(r.q(`SELECT picked_qty FROM order_items WHERE id = 'i9'`)[0].picked_qty).toBe(0);
    });
  });

  it('the generic writer refuses an affiliate balance or a referral commission (money ops only)', async () => {
    const raw = openSqlite();
    const sql = nodeSqlRunner(raw);
    ensureIdempotencySchema(sql);
    const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: S }) as never as any;
    const write = (model: string, op: string, args: unknown) =>
      runWrites(lite, sql, { ops: [{ model, op: op as never, args }] } as never, () => 1) as any;
    const ok = await write('Affiliate', 'create', {
      data: { id: 'af1', storeId: S, name: 'A', email: 'a@x.invalid', referralCode: 'A1' },
    });
    expect(JSON.stringify(ok)).not.toContain('STOCK_WRITE_REFUSED');
    for (const data of [{ pendingBalance: 100 }, { totalEarned: 1 }, { totalPaid: 1 }])
      expect(
        JSON.stringify(
          await write('Affiliate', 'update', { where: { id: 'af1', storeId: S }, data })
        )
      ).toContain('STOCK_WRITE_REFUSED');
    expect(raw.prepare(`SELECT pending_balance FROM affiliates WHERE id = 'af1'`).all()).toEqual([
      { pending_balance: 0 },
    ]);
    const click = {
      id: 'r1',
      storeId: S,
      affiliateId: 'af1',
      referralCode: 'A1',
      cookieExpiresAt: new Date(2_000_000_000_000),
    };
    expect(
      JSON.stringify(await write('AffiliateReferral', 'create', { data: click }))
    ).not.toContain('STOCK_WRITE_REFUSED');
    expect(
      JSON.stringify(
        await write('AffiliateReferral', 'update', {
          where: { id: 'r1', storeId: S },
          data: { commissionAmount: 500 },
        })
      )
    ).toContain('STOCK_WRITE_REFUSED');
  });
});
