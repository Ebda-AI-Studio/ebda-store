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
        replayed: false,
        orderId: 'o1',
        orderItemId: 'i1',
        quantity: 3,
        stockRestored: 2,
        cancelledAt: expect.any(Number),
        cancelledReason: 'discontinued',
        // the line's share of an unpaid order (no discount, no tax): the books reverse it, nothing is owed back
        refundAmount: 3000,
        notify: false,
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
      // unkeyed second cancel: a replay of the first (the line is no longer open), nothing written
      expect(r.money('backorderCancel', { backorderLineId: 'b1', reason: 'again' })).toEqual({
        ...out,
        replayed: true,
      });
      expect(r.q(`SELECT COUNT(*) AS n FROM order_events`)[0].n).toBe(1);
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

// Review of #467 (I-1, I-2, M-1, M-5): the affiliate money trail cannot be deleted or re-pointed through the generic writer,
// a reversal never runs twice, a re-cancel is a replay, and a failure AFTER a first write inside an op rolls the op back.
describe('money guards on the generic writer and the new ops (Ruling NZ-FEAT-1, review of #467)', () => {
  function writer() {
    const r = rig();
    const sql = nodeSqlRunner(r.raw);
    ensureIdempotencySchema(sql);
    const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: S }) as never as any;
    const run = (ops: unknown[]) => runWrites(lite, sql, { ops } as never, () => 1) as Promise<any>;
    const proc = async (op: string, args: Record<string, unknown>) => {
      const out = await run([{ model: '$proc', op, args }]);
      if (!out.ok) throw new Error(`${out.code}: ${out.message}`);
      return JSON.parse(out.json)[0] as number;
    };
    r.raw.exec(`
      INSERT INTO affiliates (id, store_id, name, email, referral_code, status) VALUES ('af1', 's1', 'A', 'a@x.invalid', 'A1', 'approved');
      INSERT INTO affiliates (id, store_id, name, email, referral_code, status) VALUES ('af2', 's1', 'B', 'b@x.invalid', 'B1', 'approved');
      INSERT INTO affiliate_referrals (id, store_id, affiliate_id, referral_code, status, cookie_expires_at) VALUES ('r1', 's1', 'af1', 'A1', 'clicked', 4102444800000);
      INSERT INTO affiliate_events (id, store_id, affiliate_id, event_type) VALUES ('e2', 's1', 'af2', 'created');
      INSERT INTO warehouses (id, store_id, name, code) VALUES ('w1', 's1', 'Main', 'MAIN');
    `);
    return { ...r, run, proc };
  }

  it('I-1: the generic writer never deletes an affiliate or a warehouse', async () => {
    const r = writer();
    for (const [model, op, args] of [
      ['Affiliate', 'delete', { where: { id: 'af2', storeId: S } }],
      ['Affiliate', 'deleteMany', { where: { storeId: S } }],
      ['Warehouse', 'delete', { where: { id: 'w1', storeId: S } }],
      ['Warehouse', 'deleteMany', { where: { storeId: S } }],
    ] as const)
      expect(await r.run([{ model, op, args }])).toMatchObject({
        ok: false,
        code: 'DELETE_REFUSED',
      });
    expect(r.q(`SELECT COUNT(*) AS n FROM affiliates`)[0].n).toBe(2);
    expect(r.q(`SELECT COUNT(*) AS n FROM warehouses`)[0].n).toBe(1);
  });

  it('I-1: a commission that lands before the delete survives it (the check IS the delete); a clean affiliate goes with its children', async () => {
    const r = writer();
    // the link + commission land first (the race the old check-then-act lost)
    expect(
      await r.proc('affiliateReferralLink', { id: 'r1', storeId: S, orderId: 'o1', convertedAt: 1 })
    ).toBe(1);
    expect(r.money('affiliateCommission', { referralId: 'r1', commissionAmount: 250 })).toEqual({
      claimed: true,
    });
    expect(await r.proc('affiliateDeleteIfClean', { id: 'af1', storeId: S })).toBe(0);
    expect(r.q(`SELECT pending_balance, total_earned FROM affiliates WHERE id = 'af1'`)).toEqual([
      { pending_balance: 250, total_earned: 250 },
    ]);
    expect(r.q(`SELECT status FROM affiliate_referrals WHERE id = 'r1'`)[0].status).toBe(
      'commission_paid'
    );
    // a clean affiliate: deleted, its events cascade with it
    expect(await r.proc('affiliateDeleteIfClean', { id: 'af2', storeId: S })).toBe(1);
    expect(r.q(`SELECT COUNT(*) AS n FROM affiliate_events WHERE affiliate_id = 'af2'`)[0].n).toBe(
      0
    );
    // another store's id deletes nothing
    expect(await r.proc('affiliateDeleteIfClean', { id: 'af1', storeId: 's2' })).toBe(0);
  });

  it('I-2: a referral lifecycle (status, order) is never written through the generic writer; the link happens once', async () => {
    const r = writer();
    for (const data of [{ status: 'commission_paid' }, { status: 'refunded' }, { orderId: 'o1' }])
      expect(
        await r.run([
          {
            model: 'AffiliateReferral',
            op: 'update',
            args: { where: { id: 'r1', storeId: S }, data },
          },
        ])
      ).toMatchObject({ ok: false, code: 'STOCK_WRITE_REFUSED' });
    expect(
      await r.run([
        {
          model: 'AffiliateReferral',
          op: 'create',
          args: {
            data: {
              id: 'r9',
              storeId: S,
              affiliateId: 'af1',
              referralCode: 'A1',
              status: 'commission_paid',
              cookieExpiresAt: new Date(4102444800000),
            },
          },
        },
      ])
    ).toMatchObject({ ok: false, code: 'STOCK_WRITE_REFUSED' });
    expect(
      await r.proc('affiliateReferralLink', { id: 'r1', storeId: S, orderId: 'o1', convertedAt: 1 })
    ).toBe(1);
    // a second link (another order) is a no-op: the referral is never re-pointed
    r.raw.exec(
      `INSERT INTO orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address) VALUES ('o3', 's1', 'ORD-3', 1, 1, '{}', '{}')`
    );
    expect(
      await r.proc('affiliateReferralLink', { id: 'r1', storeId: S, orderId: 'o3', convertedAt: 2 })
    ).toBe(0);
    expect(r.q(`SELECT order_id, status FROM affiliate_referrals WHERE id = 'r1'`)).toEqual([
      { order_id: 'o1', status: 'converted' },
    ]);
  });

  it('I-2: a double reversal takes the commission back once', async () => {
    const r = writer();
    await r.proc('affiliateReferralLink', { id: 'r1', storeId: S, orderId: 'o1', convertedAt: 1 });
    r.money('affiliateCommission', { referralId: 'r1', commissionAmount: 300 });
    expect(r.money('affiliateReverse', { orderId: 'o1' })).toEqual({ amount: 300 });
    expect(r.money('affiliateReverse', { orderId: 'o1' })).toEqual({ amount: null });
    expect(r.q(`SELECT pending_balance, total_earned FROM affiliates WHERE id = 'af1'`)).toEqual([
      { pending_balance: 0, total_earned: 0 },
    ]);
    expect(
      r.q(
        `SELECT COUNT(*) AS n FROM affiliate_events WHERE affiliate_id = 'af1' AND event_type = 'commission_reversed'`
      )[0].n
    ).toBe(1);
  });

  it('M-1: a re-cancel by another admin with another reason is a replay: same figures, nothing written', () => {
    const r = rig();
    const first = r.money('backorderCancel', {
      backorderLineId: 'b1',
      reason: 'discontinued',
      userId: 'u1',
    });
    expect(first).toMatchObject({ found: true, replayed: false, quantity: 3, stockRestored: 2 });
    const again = r.money('backorderCancel', {
      backorderLineId: 'b1',
      reason: 'other',
      userId: 'u2',
    });
    expect(again).toEqual({ ...first, replayed: true });
    expect(r.q(`SELECT COUNT(*) AS n FROM order_events`)[0].n).toBe(1);
    expect(r.q(`SELECT inventory FROM products WHERE id = 'p1'`)[0].inventory).toBe(0);
    expect(
      r.q(`SELECT cancelled_reason FROM backorder_lines WHERE id = 'b1'`)[0].cancelled_reason
    ).toBe('discontinued');
  });

  it('M-5: a failure AFTER the first write inside an op rolls the whole op back', () => {
    const r = rig();
    // backorderCancel: the marker insert (last step) fails after the claim, the flag and the stock heal were written
    r.raw.exec(
      `CREATE TRIGGER fail_marker BEFORE INSERT ON order_events BEGIN SELECT RAISE(ABORT, 'injected'); END;`
    );
    expect(() => r.money('backorderCancel', { backorderLineId: 'b1', reason: 'x' })).toThrow();
    expect(
      r.q(`SELECT cancelled_at FROM backorder_lines WHERE id = 'b1'`)[0].cancelled_at
    ).toBeNull();
    expect(r.q(`SELECT inventory FROM products WHERE id = 'p1'`)[0].inventory).toBe(-2);
    expect(
      r.q(`SELECT cost_price_deferred FROM order_items WHERE id = 'i1'`)[0].cost_price_deferred
    ).toBe(1);
    expect(r.q(`SELECT COUNT(*) AS n FROM inventory_history`)[0].n).toBe(0);

    // journalManual: the SECOND line insert fails after the entry and the first line were written
    r.raw.exec(`
      INSERT INTO accounts (id, store_id, code, name_en, type, is_system, is_active) VALUES ('a1', 's1', '1000', 'Cash', 'asset', 1, 1);
      INSERT INTO accounts (id, store_id, code, name_en, type, is_system, is_active) VALUES ('a2', 's1', '4000', 'Sales', 'revenue', 1, 1);
      CREATE TRIGGER fail_second_line BEFORE INSERT ON journal_lines
        WHEN (SELECT COUNT(*) FROM journal_lines) >= 1 BEGIN SELECT RAISE(ABORT, 'injected'); END;
    `);
    expect(() =>
      r.money('journalManual', {
        lines: [
          { accountId: 'a1', debit: 100, credit: 0 },
          { accountId: 'a2', debit: 0, credit: 100 },
        ],
      })
    ).toThrow();
    expect(r.q(`SELECT COUNT(*) AS n FROM journal_entries`)[0].n).toBe(0);
    expect(r.q(`SELECT COUNT(*) AS n FROM journal_lines`)[0].n).toBe(0);
  });

  it('re-review m-1: a replay answers the FIRST cancel figures (time, reason, amount owed on a paid order) exactly', () => {
    const r = rig();
    r.raw.exec(`UPDATE orders SET payment_status = 'paid' WHERE id = 'o1'`);
    const first = r.money('backorderCancel', {
      backorderLineId: 'b1',
      reason: 'first reason',
      userId: 'u1',
    });
    expect(first).toMatchObject({
      refundAmount: 3000,
      notify: true,
      cancelledReason: 'first reason',
    });
    // a later write that would change a recomputation (the order refunded) does not change the stored answer
    r.raw.exec(`UPDATE orders SET payment_status = 'refunded' WHERE id = 'o1'`);
    const again = r.money('backorderCancel', {
      backorderLineId: 'b1',
      reason: 'other reason',
      userId: 'u2',
    });
    expect(again).toEqual({ ...first, replayed: true });
  });

  it('re-review: a pickOrderItem failure AFTER its write rolls the pick back', () => {
    const r = rig();
    // the op's last statement (the remaining-lines count) runs AFTER the picked_qty UPDATE: make exactly that read fail
    const failing = new Proxy(r.db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== 'all' || typeof v !== 'function')
          return typeof v === 'function' ? v.bind(target) : v;
        return (sql: string, params: unknown[]) => {
          if (/COUNT\(\*\) AS n FROM order_items/.test(sql))
            throw new Error('injected after the write');
          return v.call(target, sql, params);
        };
      },
    });
    expect(() =>
      runStockOp(failing as typeof r.db, S, 'pickOrderItem', {
        orderId: 'o1',
        productId: 'p2',
        qty: 1,
      })
    ).toThrow('injected after the write');
    expect(
      r.q(`SELECT picked_qty, picked_at FROM order_items WHERE order_id = 'o1' ORDER BY id`)
    ).toEqual([
      { picked_qty: 0, picked_at: null },
      { picked_qty: 0, picked_at: null },
      { picked_qty: 0, picked_at: null },
    ]);
    // the same op without the injected failure does write (the assertion above is not vacuous)
    expect(r.stock('pickOrderItem', { orderId: 'o1', productId: 'p2', qty: 1 })).toMatchObject({
      kind: 'picked',
    });
  });
});
