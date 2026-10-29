// Return lifecycle and partial-return journal on node:sqlite (real StoreDO schema). Ruling CF-RETURNS-1.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { postEntry } from '../src/do/ledger';
import { MoneyError } from '../src/do/sync-sql';

const DAY = 86_400_000;
function fixture(over: { days?: number | null; walletAmount?: number } = {}) {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const all = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  const one = (sql: string, ...p: unknown[]) => raw.prepare(sql).get(...(p as never[])) as any;
  x(`INSERT INTO store_config (store_id, return_window_days) VALUES ('s1', ?)`, over.days ?? null);
  x(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', 's1', 'Tee', 'tee', 10000, 5, 'active')`
  );
  x(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p2', 's1', 'Cap', 'cap', 5000, 5, 'active')`
  );
  x(`INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('cust', 's1', 'A', 'B')`);
  x(
    `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, discount, tax, shipping, total, wallet_amount, shipping_address, billing_address, delivered_at, updated_at, created_at)
     VALUES ('o1', 's1', 'cust', 'ORD-1', 'delivered', 'paid', 25000, 2500, 3150, 0, 25650, ?, '{}', '{}', ?, ?, ?)`,
    over.walletAmount ?? 0,
    Date.now() - DAY,
    Date.now() - DAY,
    Date.now() - 3 * DAY
  );
  x(
    `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total, cost_price) VALUES ('i1', 'o1', 'p1', 'Tee', 2, 10000, 20000, 4000)`
  );
  x(
    `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total, cost_price) VALUES ('i2', 'o1', 'p2', 'Cap', 1, 5000, 5000, 2000)`
  );
  x(
    `INSERT INTO payments (id, order_id, provider, status, amount, created_at, updated_at) VALUES ('pay1', 'o1', 'paymob', 'completed', 25650, ?, ?)`,
    Date.now(),
    Date.now()
  );
  for (const [c, n, t] of [
    ['1000', 'Cash', 'asset'],
    ['1020', 'COD', 'asset'],
    ['1200', 'Inventory', 'asset'],
    ['2100', 'Tax', 'liability'],
    ['2150', 'Wallet', 'liability'],
    ['2160', 'Store credit', 'liability'],
    ['4000', 'Sales', 'revenue'],
    ['4090', 'Sales returns', 'revenue'],
    ['5000', 'COGS', 'expense'],
  ])
    x(
      `INSERT INTO accounts (id, store_id, code, name_en, type, is_system) VALUES ('a${c}', 's1', ?, ?, ?, 1)`,
      c,
      n,
      t
    );
  postEntry(db, {
    storeId: 's1',
    source: 'order',
    sourceId: 'o1',
    lines: [
      { accountId: 'a1000', debit: 25650, credit: 0 },
      { accountId: 'a4000', debit: 0, credit: 25000 + 0 - 2500 },
      { accountId: 'a2100', debit: 0, credit: 3150 },
    ],
  });
  postEntry(db, {
    storeId: 's1',
    source: 'order',
    sourceId: 'o1:cogs',
    lines: [
      { accountId: 'a5000', debit: 10000, credit: 0 },
      { accountId: 'a1200', debit: 0, credit: 10000 },
    ],
  });
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, 's1', name, args, key) as any;
  const create = (
    items: Array<{ orderItemId: string; productId: string; quantity: number }>,
    extra = {}
  ) =>
    op('returnCreate', {
      orderId: 'o1',
      customerId: 'cust',
      type: 'return',
      reason: 'wrong size',
      items: items.map(i => ({ ...i, productName: 'x' })),
      ...extra,
    }).returnId as string;
  const toReceived = (id: string) => {
    op('returnStatus', { returnId: id, status: 'approved', userId: 'u1' });
    op('returnStatus', { returnId: id, status: 'received', userId: 'u1' });
  };
  const ret = (id: string) => one('SELECT * FROM returns WHERE id = ?', id);
  return { raw, db, x, all, one, op, create, toReceived, ret };
}
const refusal = (fn: () => unknown): MoneyError => {
  try {
    fn();
  } catch (e) {
    return e as MoneyError;
  }
  throw new Error('expected a refusal');
};
const line = (id: string, p: string, q: number) => ({ orderItemId: id, productId: p, quantity: q });

describe('returnCreate', () => {
  it('books the gross estimate, refuses an over-claim across requests and counts rejected ones as released', () => {
    const f = fixture();
    const a = f.create([line('i1', 'p1', 1)]);
    expect(f.ret(a)).toMatchObject({ status: 'pending', refund_amount: 10000, type: 'return' });
    expect(refusal(() => f.create([line('i1', 'p1', 2)])).code).toBe('INVALID_QUANTITY');
    f.op('returnStatus', { returnId: a, status: 'rejected', userId: 'u1', notes: 'no' });
    expect(f.ret(a)).toMatchObject({
      status: 'rejected',
      rejected_by: 'u1',
      rejection_reason: 'no',
    });
    expect(() => f.create([line('i1', 'p1', 2)])).not.toThrow();
  });
  it('refuses a foreign order, a closed window, an exchange to a gold piece and an empty request', () => {
    const f = fixture({ days: 0 });
    expect(refusal(() => f.create([line('i1', 'p1', 1)]))).toMatchObject({
      code: 'RETURN_WINDOW_CLOSED',
      status: 422,
    });
    const g = fixture({ days: 30 });
    expect(() => g.create([line('i1', 'p1', 1)])).not.toThrow();
    g.x(`UPDATE order_items SET gold_snapshot = '{}' WHERE id = 'i2'`);
    expect(refusal(() => g.create([line('i2', 'p2', 1)], { type: 'exchange' })).code).toBe(
      'GOLD_EXCHANGE_UNSUPPORTED'
    );
    expect(refusal(() => g.create([])).code).toBe('NO_ITEMS');
    expect(
      refusal(() =>
        g.op('returnCreate', {
          orderId: 'o1',
          customerId: 'someone',
          type: 'return',
          reason: 'x',
          items: [],
        })
      ).code
    ).toBe('INVALID_ORDER');
    const old = fixture({ days: 1 });
    old.x(`UPDATE orders SET delivered_at = ?`, Date.now() - 5 * DAY);
    expect(refusal(() => old.create([line('i1', 'p1', 1)])).code).toBe('RETURN_WINDOW_CLOSED');
  });
  it('a keyed create replays to one return', () => {
    const f = fixture();
    const args = {
      orderId: 'o1',
      customerId: 'cust',
      type: 'return',
      reason: 'r',
      items: [{ ...line('i1', 'p1', 1), productName: 'x' }],
    };
    const a = f.op('returnCreate', args, 'create-key-0001');
    const b = f.op('returnCreate', args, 'create-key-0001');
    expect(b.returnId).toBe(a.returnId);
    expect(f.one('SELECT count(*) n FROM returns').n).toBe(1);
  });
});

describe('complete: claim, finish, release', () => {
  it('a double claim is RETURN_ALREADY_COMPLETING, a sibling is RETURN_ORDER_BUSY, release re-opens it', () => {
    const f = fixture();
    const a = f.create([line('i1', 'p1', 1)]);
    const b = f.create([line('i2', 'p2', 1)]);
    f.toReceived(a);
    f.toReceived(b);
    const plan = f.op('returnClaim', { returnId: a, refundMethod: 'manual' });
    expect(plan.partial.cashCredit).toBeGreaterThan(0);
    expect(refusal(() => f.op('returnClaim', { returnId: a, refundMethod: 'manual' })).code).toBe(
      'RETURN_ALREADY_COMPLETING'
    );
    expect(refusal(() => f.op('returnClaim', { returnId: b, refundMethod: 'manual' })).code).toBe(
      'RETURN_ORDER_BUSY'
    );
    expect(f.op('returnRelease', { returnId: a }).released).toBe(true);
    expect(() => f.op('returnClaim', { returnId: b, refundMethod: 'manual' })).not.toThrow();
  });
  it('a refused plan leaves no claim behind (the section rolled back)', () => {
    const f = fixture();
    const a = f.create([line('i1', 'p1', 1)]);
    f.toReceived(a);
    expect(
      refusal(() =>
        f.op('returnClaim', {
          returnId: a,
          refundMethod: 'original',
          refundOverrides: { nope: { amountMinor: 1, reason: 'x' } },
        })
      ).code
    ).toBe('OVERRIDE_UNKNOWN_ITEM');
    expect(f.ret(a).refunded_at).toBeNull();
    expect(() => f.op('returnClaim', { returnId: a, refundMethod: 'manual' })).not.toThrow();
  });
  it('two partial returns sum to the order discount and tax exactly and restock their own lines once', () => {
    const f = fixture();
    const a = f.create([line('i1', 'p1', 1)]);
    const b = f.create([line('i1', 'p1', 1), line('i2', 'p2', 1)]);
    let paid = 0;
    for (const id of [a, b]) {
      f.toReceived(id);
      const plan = f.op('returnClaim', { returnId: id, refundMethod: 'manual' });
      const done = f.op('returnFinish', { returnId: id, refundMethod: 'manual', userId: 'u1' });
      expect(done.replayed).toBe(false);
      paid += plan.partial.cashCredit;
      expect(f.ret(id)).toMatchObject({
        status: 'completed',
        refund_method: 'manual',
        refund_amount: plan.partial.cashCredit,
      });
      expect(f.ret(id).reversal_requested_at).not.toBeNull();
    }
    expect(paid).toBe(25000 - 2500 + 3150); // goods less discount plus tax, no shipping
    expect(f.one(`SELECT inventory FROM products WHERE id = 'p1'`).inventory).toBe(7);
    expect(f.one(`SELECT inventory FROM products WHERE id = 'p2'`).inventory).toBe(6);
    expect(
      f.op('returnFinish', { returnId: a, refundMethod: 'manual', userId: 'u1' }).replayed
    ).toBe(true);
    expect(f.one(`SELECT inventory FROM products WHERE id = 'p1'`).inventory).toBe(7);
  });
  it('store credit lands in the wallet once (feature on) and not at all with the feature off', () => {
    const on = fixture();
    const a = on.create([line('i1', 'p1', 1)]);
    on.toReceived(a);
    on.op('returnClaim', { returnId: a, refundMethod: 'store_credit', walletFeature: true });
    const r = on.op('returnFinish', {
      returnId: a,
      refundMethod: 'store_credit',
      walletFeature: true,
      userId: 'u1',
    });
    expect(r.walletCredited).toBeGreaterThan(0);
    expect(on.one(`SELECT balance FROM customer_wallets WHERE customer_id = 'cust'`).balance).toBe(
      r.walletCredited
    );
    expect(on.one(`SELECT return_id, idempotency_key FROM wallet_transactions`)).toMatchObject({
      return_id: a,
      idempotency_key: `return-credit:${a}`,
    });
    const off = fixture();
    const b = off.create([line('i1', 'p1', 1)]);
    off.toReceived(b);
    off.op('returnClaim', { returnId: b, refundMethod: 'store_credit' });
    off.op('returnFinish', { returnId: b, refundMethod: 'store_credit', userId: 'u1' });
    expect(off.one('SELECT count(*) n FROM wallet_transactions').n).toBe(0);
  });
  it('the completion and its wallet credit are ONE section: a failing credit rolls the return, stock and claim back; a retry after a rolled-back request credits once', () => {
    const f = fixture();
    const a = f.create([line('i1', 'p1', 1)]);
    f.toReceived(a);
    f.op('returnClaim', { returnId: a, refundMethod: 'store_credit', walletFeature: true });
    f.x(`DELETE FROM customers WHERE id = 'cust'`); // the credit cannot be applied
    expect(
      refusal(() =>
        f.op('returnFinish', {
          returnId: a,
          refundMethod: 'store_credit',
          walletFeature: true,
          userId: 'u1',
        })
      ).code
    ).toBe('CUSTOMER_NOT_FOUND');
    expect(f.ret(a)).toMatchObject({ status: 'received' }); // not completed without its credit
    expect(f.one(`SELECT inventory FROM products WHERE id = 'p1'`).inventory).toBe(5); // no restock either
    expect(f.one('SELECT count(*) n FROM wallet_transactions').n).toBe(0);
    f.x(
      `INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('cust', 's1', 'A', 'B')`
    );
    const key = 'finish-key-0001';
    const args = { returnId: a, refundMethod: 'store_credit', walletFeature: true, userId: 'u1' };
    const one = f.op('returnFinish', args, key);
    // the Postgres request around the call rolled back and the client retried: same key, then a keyless retry
    expect(f.op('returnFinish', args, key)).toEqual(one);
    expect(f.op('returnFinish', args).replayed).toBe(true);
    expect(f.one(`SELECT balance FROM customer_wallets WHERE customer_id = 'cust'`).balance).toBe(
      one.walletCredited
    );
    expect(f.one('SELECT count(*) n FROM wallet_transactions').n).toBe(1);
    expect(f.one(`SELECT inventory FROM products WHERE id = 'p1'`).inventory).toBe(6);
    // and a claim after completion is refused, never a second credit
    expect(
      refusal(() =>
        f.op('returnClaim', { returnId: a, refundMethod: 'store_credit', walletFeature: true })
      ).code
    ).toBe('INVALID_STATUS');
  });
  it('a gateway completion on an order paid partly from the wallet credits the wallet share under its own key', () => {
    const f = fixture({ walletAmount: 10000 });
    const a = f.create([line('i1', 'p1', 1)]);
    f.toReceived(a);
    const plan = f.op('returnClaim', { returnId: a, refundMethod: 'original' });
    expect(plan.walletShare).toBeGreaterThan(0);
    expect(plan.walletShare + plan.partial.gatewayShare).toBe(plan.partial.cashCredit);
    f.op('returnFinish', { returnId: a, refundMethod: 'original', userId: 'u1' });
    expect(f.one('SELECT idempotency_key k FROM wallet_transactions').k).toBe(
      `return-wallet-share:${a}`
    );
  });
  it('an exchange cannot refund to a gateway; a full return reverses the order effects', () => {
    const f = fixture();
    const e = f.create([line('i1', 'p1', 1)], { type: 'exchange' });
    f.toReceived(e);
    expect(refusal(() => f.op('returnClaim', { returnId: e, refundMethod: 'original' })).code).toBe(
      'EXCHANGE_CANNOT_REFUND_TO_GATEWAY'
    );
    const g = fixture();
    const full = g.create([line('i1', 'p1', 2), line('i2', 'p2', 1)]);
    g.toReceived(full);
    const plan = g.op('returnClaim', { returnId: full, refundMethod: 'manual' });
    expect(plan.isFullReturn).toBe(true);
    g.op('returnFinish', { returnId: full, refundMethod: 'manual', userId: 'u1' });
    expect(g.one('SELECT status, refund_reversal_requested_at r FROM orders').status).toBe(
      'delivered'
    );
    expect(g.one('SELECT refund_reversal_requested_at r FROM orders').r).not.toBeNull();
  });
});

describe('journalPartialReturn', () => {
  it('posts the adjustment and the COGS reversal once, balanced, and a replay books nothing', () => {
    const f = fixture();
    const a = f.create([line('i1', 'p1', 1)]);
    f.toReceived(a);
    f.op('returnClaim', { returnId: a, refundMethod: 'manual' });
    f.op('returnFinish', { returnId: a, refundMethod: 'manual', userId: 'u1' });
    const r1 = f.op('journalPartialReturn', {
      orderId: 'o1',
      refundKey: a,
      items: [{ orderItemId: 'i1', quantity: 1 }],
    });
    expect(r1.posted).toBe(2);
    const r2 = f.op('journalPartialReturn', {
      orderId: 'o1',
      refundKey: a,
      items: [{ orderItemId: 'i1', quantity: 1 }],
    });
    expect(r2).toMatchObject({ posted: 0, skipped: 'already-posted' });
    expect(
      f.one(`SELECT count(*) n FROM journal_entries WHERE source_id LIKE 'o1:partial:%'`).n
    ).toBe(2);
    const sums = f.one(`SELECT SUM(debit) d, SUM(credit) c FROM journal_lines`);
    expect(sums.d).toBe(sums.c);
  });
  it('skips with the Postgres reasons: no order, no sale entry, reversed sale, nothing left', () => {
    const f = fixture();
    expect(
      f.op('journalPartialReturn', { orderId: 'nope', refundKey: 'k', items: [] }).skipped
    ).toBe('order-not-found');
    expect(
      f.op('journalPartialReturn', {
        orderId: 'o1',
        refundKey: 'k',
        items: [{ orderItemId: 'zz', quantity: 1 }],
      }).skipped
    ).toBe('nothing-to-adjust');
    f.x(`UPDATE journal_entries SET status = 'reversed' WHERE source_id = 'o1'`);
    expect(
      f.op('journalPartialReturn', {
        orderId: 'o1',
        refundKey: 'k2',
        items: [{ orderItemId: 'i1', quantity: 1 }],
      }).skipped
    ).toBe('original-reversed');
    const g = fixture();
    g.x(`DELETE FROM journal_lines`);
    g.x(`DELETE FROM journal_entries`);
    expect(
      g.op('journalPartialReturn', {
        orderId: 'o1',
        refundKey: 'k',
        items: [{ orderItemId: 'i1', quantity: 1 }],
      }).skipped
    ).toBe('no-original-entry');
  });
  it('journalAmountOnlyRefund books DR 4090 / CR the sale cash account once per key', () => {
    const f = fixture();
    expect(
      f.op('journalAmountOnlyRefund', { orderId: 'o1', refundKey: 'refund:abc', amount: 700 })
        .posted
    ).toBe(1);
    expect(
      f.op('journalAmountOnlyRefund', { orderId: 'o1', refundKey: 'refund:abc', amount: 700 })
        .skipped
    ).toBe('already-posted');
    expect(
      f.op('journalAmountOnlyRefund', { orderId: 'o1', refundKey: 'refund:z', amount: 0 }).skipped
    ).toBe('invalid-amount');
  });
});
