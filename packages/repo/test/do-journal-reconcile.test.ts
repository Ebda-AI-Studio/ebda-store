// Ruling JOURNAL-RECONCILE-1: a lost post-payment fan-out (the best-effort `order/created` enqueue) must not leave a paid
// order with no sale entry forever. `journalRepairSales` finds the orders PAID in the window with no sale entry and posts
// it, on the real DO schema (node:sqlite).
//
// Mutation proofs: key the window on `orders.created_at` only -> the COD test (created days ago, paid an hour ago) fails;
// drop the NOT EXISTS -> the take-1 test starves on an already-posted order; drop `o.total > 0` -> the zero-total test
// reports one.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';
import { ensurePaymentSchema } from '../src/do/payments';
import { trialBalance } from '../src/do/ledger';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
const MIN = 60_000;
const HOUR = 60 * MIN;
const COA: Array<[string, string, string]> = [
  ['1000', 'Cash Online', 'asset'],
  ['1010', 'Cash Card', 'asset'],
  ['1020', 'Cash COD', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['2100', 'Tax Payable', 'liability'],
  ['2150', 'Customer Wallet Liability', 'liability'],
  ['4000', 'Sales', 'revenue'],
  ['4010', 'Shipping Income', 'revenue'],
  ['5000', 'COGS', 'expense'],
];

function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  ensurePaymentSchema(db);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES ('sku', 's1', 'Widget', 'widget', 1000, 20, 'active', 400);
     INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES ('s1', 1);`
  );
  for (const [code, name, type] of COA)
    raw.exec(
      `INSERT INTO accounts (id, store_id, code, name_en, type, is_system) VALUES ('a${code}', 's1', '${code}', '${name}', '${type}', 1)`
    );
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  const op = (name: string, args: Record<string, unknown>) => runMoneyOp(db, S, name, args) as any;
  let n = 0;
  /** an order paid in full through a real webhook, with NO journal posted (the lost fan-out) */
  const paid = (provider = 'paymob') => {
    n++;
    const o = op('createOrder', {
      lines: [{ productId: 'sku', quantity: 1 }],
      shippingAddress: { phone: `010${String(n).padStart(8, '0')}` },
    });
    op('paymentCreate', {
      orderId: o.orderId,
      provider,
      amount: o.total,
      transactionId: `tx-${n}`,
    });
    op('paymentWebhook', {
      input: {
        provider,
        eventId: `evt-${n}`,
        providerRef: `tx-${n}`,
        kind: 'payment',
        status: 'completed',
        amount: o.total,
        currency: 'EGP',
      },
      confirmed: provider === 'kashier' ? { kind: 'payment', status: 'SUCCESS' } : null,
    });
    return o as { orderId: string; total: number };
  };
  /** move an order's creation and its payment's paid time */
  const at = (orderId: string, createdAt: number, paidAt: number) => {
    raw.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(createdAt, orderId);
    raw.prepare('UPDATE payments SET paid_at = ? WHERE order_id = ?').run(paidAt, orderId);
  };
  const now = Date.now();
  const repair = () =>
    op('journalRepairSales', {
      paidAfterMs: now - 72 * HOUR,
      paidBeforeMs: now - 10 * MIN,
      take: 200,
    }) as {
      repaired: Array<{ orderId: string; entries: number }>;
      failed: Array<{ orderId: string; error: string }>;
    };
  const saleEntries = (orderId: string) =>
    q("SELECT count(*) n FROM journal_entries WHERE source = 'order' AND source_id = ?", orderId)[0]
      .n as number;
  return { raw, db, q, op, paid, at, now, repair, saleEntries };
}

describe('journalRepairSales (Ruling JOURNAL-RECONCILE-1)', () => {
  it('is a registered money operation', () => {
    expect(MONEY_OP_NAMES).toContain('journalRepairSales');
  });

  it('posts the missing sale + COGS of a paid order, balanced, and a replay repairs nothing', () => {
    const r = rig();
    const o = r.paid();
    r.at(o.orderId, r.now - 2 * HOUR, r.now - 2 * HOUR);
    expect(r.saleEntries(o.orderId)).toBe(0);
    const a = r.repair();
    expect(a.repaired).toEqual([expect.objectContaining({ orderId: o.orderId, entries: 2 })]);
    expect(a.failed).toEqual([]);
    expect(r.saleEntries(o.orderId)).toBe(1);
    const tb = trialBalance(r.db, S);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find(x => x.code === '1000')?.debit).toBe(o.total);
    expect(r.repair()).toEqual({ repaired: [], failed: [] });
  });

  it('finds a COD-style order created days ago and paid an hour ago (keyed on the payment, not the order)', () => {
    const r = rig();
    const o = r.paid();
    r.at(o.orderId, r.now - 5 * 24 * HOUR, r.now - HOUR);
    expect(r.repair().repaired.map(x => x.orderId)).toEqual([o.orderId]);
  });

  it('leaves alone an order whose fan-out already posted it', () => {
    const r = rig();
    const o = r.paid();
    r.at(o.orderId, r.now - HOUR, r.now - HOUR);
    expect(r.op('journalSale', { orderId: o.orderId })).toMatchObject({ posted: true, entries: 2 });
    expect(r.repair()).toEqual({ repaired: [], failed: [] });
  });

  it('a full page of already-posted orders never starves a missing one (the NOT EXISTS is in the query)', () => {
    const r = rig();
    const done = r.paid();
    r.at(done.orderId, r.now - 3 * HOUR, r.now - 3 * HOUR);
    r.op('journalSale', { orderId: done.orderId });
    const lost = r.paid();
    r.at(lost.orderId, r.now - HOUR, r.now - HOUR);
    const res = r.op('journalRepairSales', {
      paidAfterMs: r.now - 72 * HOUR,
      paidBeforeMs: r.now - 10 * MIN,
      take: 1,
    });
    expect(res.repaired.map((x: { orderId: string }) => x.orderId)).toEqual([lost.orderId]);
  });

  it('skips orders paid inside the grace window or before the floor, unpaid, cancelled and zero-total orders', () => {
    const r = rig();
    const fresh = r.paid();
    r.at(fresh.orderId, r.now - 2 * MIN, r.now - 2 * MIN); // the fan-out may still be in flight
    const old = r.paid();
    r.at(old.orderId, r.now - 10 * 24 * HOUR, r.now - 10 * 24 * HOUR); // history is never back-posted
    const cancelled = r.paid();
    r.at(cancelled.orderId, r.now - HOUR, r.now - HOUR);
    r.raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(cancelled.orderId);
    const free = r.paid();
    r.at(free.orderId, r.now - HOUR, r.now - HOUR);
    r.raw.prepare('UPDATE orders SET total = 0 WHERE id = ?').run(free.orderId);
    const unpaid = r.op('createOrder', {
      lines: [{ productId: 'sku', quantity: 1 }],
      shippingAddress: { phone: '01099999999' },
    });
    r.raw
      .prepare('UPDATE orders SET created_at = ? WHERE id = ?')
      .run(r.now - HOUR, unpaid.orderId);
    expect(r.repair()).toEqual({ repaired: [], failed: [] });
    expect(r.q('SELECT count(*) n FROM journal_entries')[0].n).toBe(0);
  });

  it('does nothing for a store with accounting off', () => {
    const r = rig();
    const o = r.paid();
    r.at(o.orderId, r.now - HOUR, r.now - HOUR);
    r.raw.exec('UPDATE store_config SET accounting_enabled = 0');
    expect(r.repair()).toEqual({ repaired: [], failed: [] });
  });

  it('one order that cannot post is reported and never blocks the others', () => {
    const r = rig();
    const card = r.paid('kashier');
    const online = r.paid('paymob');
    r.at(card.orderId, r.now - 2 * HOUR, r.now - 2 * HOUR);
    r.at(online.orderId, r.now - HOUR, r.now - HOUR);
    r.raw.exec("DELETE FROM accounts WHERE code = '1010'"); // the card cash account is missing
    const res = r.repair();
    expect(res.failed.map(x => x.orderId)).toEqual([card.orderId]);
    expect(res.repaired.map(x => x.orderId)).toEqual([online.orderId]);
    expect(r.saleEntries(card.orderId)).toBe(0);
    expect(r.saleEntries(online.orderId)).toBe(1);
  });

  it('refuses a malformed window', () => {
    const r = rig();
    try {
      r.op('journalRepairSales', { paidAfterMs: 'x', paidBeforeMs: 1 });
      expect.unreachable();
    } catch (e) {
      expect((e as MoneyError).code).toBe('BAD_ARGS');
    }
  });
});
