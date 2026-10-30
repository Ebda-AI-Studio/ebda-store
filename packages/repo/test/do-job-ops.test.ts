// Ruling CF-JOBS-3: the store-side statements background jobs need on a store that lives on its Durable Object, run on the
// real DO schema (node:sqlite): payment-timeline rows, the abandonment stamp once, the ledger totals, cancel-only-if-unpaid.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';
import { ensurePaymentSchema } from '../src/do/payments';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
const COA: Array<[string, string, string]> = [
  ['1000', 'Cash Online', 'asset'],
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
  const op = (name: string, args: Record<string, unknown>, key?: string, store = S) =>
    runMoneyOp(db, store, name, args, key) as any;
  const code = (name: string, args: Record<string, unknown>): string => {
    try {
      op(name, args);
    } catch (e) {
      return `${(e as MoneyError).code}/${(e as MoneyError).status}`;
    }
    return 'no error';
  };
  let n = 0;
  const order = (provider = 'paymob') => {
    n++;
    const o = op('createOrder', {
      lines: [{ productId: 'sku', quantity: 2 }],
      shippingAddress: { phone: `010${String(n).padStart(8, '0')}` },
    });
    const { paymentId } = op('paymentCreate', {
      orderId: o.orderId,
      provider,
      amount: o.total,
      transactionId: `tx-${n}`,
    });
    return { ...o, paymentId, ref: `tx-${n}`, provider };
  };
  return { raw, db, q, op, code, order };
}

describe('job operations on the DO (Ruling CF-JOBS-3)', () => {
  it('are registered', () => {
    expect(MONEY_OP_NAMES).toEqual(
      expect.arrayContaining([
        'paymentEventRecord',
        'abandonStamp',
        'trialBalance',
        'periodGlCredits',
      ])
    );
  });

  it('paymentEventRecord appends a reconciliation row; another store or another order cannot', () => {
    const r = rig();
    const o = r.order();
    r.op('paymentEventRecord', {
      paymentId: o.paymentId,
      orderId: o.orderId,
      eventType: 'reconciliation',
      fromStatus: 'completed',
      provider: 'paymob',
      details: { reason: 'completed_payment_on_cancelled_order' },
    });
    const rows = r.q(
      "SELECT details, from_status, store_id FROM payment_events WHERE event_type = 'reconciliation'"
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details)).toEqual({ reason: 'completed_payment_on_cancelled_order' });
    expect(rows[0].store_id).toBe('s1');
    expect(
      r.code('paymentEventRecord', { paymentId: o.paymentId, orderId: 'nope', eventType: 'x' })
    ).toBe('PAYMENT_NOT_FOUND/404');
    expect(
      (() => {
        try {
          r.op(
            'paymentEventRecord',
            { paymentId: o.paymentId, orderId: o.orderId, eventType: 'x' },
            undefined,
            'other'
          );
          return 'no error';
        } catch (e) {
          return (e as MoneyError).code;
        }
      })()
    ).toBe('PAYMENT_NOT_FOUND');
  });

  it('abandonStamp stamps an unpaid order once, and never a paid one', () => {
    const r = rig();
    const o = r.order();
    expect(r.op('abandonStamp', { orderId: o.orderId })).toEqual({ stamped: true });
    expect(r.op('abandonStamp', { orderId: o.orderId })).toEqual({ stamped: false });
    const paid = r.order();
    r.op('paymentWebhook', {
      input: {
        provider: 'paymob',
        eventId: 'e1',
        providerRef: paid.ref,
        kind: 'payment',
        status: 'completed',
        amount: paid.total,
      },
      confirmed: null,
    });
    expect(r.op('abandonStamp', { orderId: paid.orderId })).toEqual({ stamped: false });
    expect(
      r.q('SELECT payment_gateway_abandoned_at a FROM orders WHERE id = ?', paid.orderId)[0].a
    ).toBeNull();
  });

  it('trialBalance and periodGlCredits read the posted ledger of this store only', () => {
    const r = rig();
    const o = r.order();
    r.op('paymentWebhook', {
      input: {
        provider: 'paymob',
        eventId: 'e2',
        providerRef: o.ref,
        kind: 'payment',
        status: 'completed',
        amount: o.total,
      },
      confirmed: null,
    });
    r.op('journalSale', { orderId: o.orderId });
    const tb = r.op('trialBalance', {});
    expect(tb.debit).toBeGreaterThan(0);
    expect(tb.debit).toBe(tb.credit);
    const since = r.op('periodGlCredits', { sinceMs: 0 });
    expect(since.total).toBeGreaterThan(0);
    expect(r.op('periodGlCredits', { sinceMs: Date.now() + 60_000 }).total).toBe(0);
    expect(r.op('trialBalance', {}, undefined, 'other')).toEqual({ debit: 0, credit: 0 });
  });

  it('cancel with unpaidOnly cancels an unpaid order and refuses a paid one without changing it', () => {
    const r = rig();
    const u = r.order();
    expect(r.op('cancel', { orderId: u.orderId, unpaidOnly: true }).status).toBe('cancelled');
    const p = r.order();
    r.op('paymentWebhook', {
      input: {
        provider: 'paymob',
        eventId: 'e3',
        providerRef: p.ref,
        kind: 'payment',
        status: 'completed',
        amount: p.total,
      },
      confirmed: null,
    });
    expect(r.code('cancel', { orderId: p.orderId, unpaidOnly: true })).toBe(
      'ORDER_ALREADY_PAID/409'
    );
    expect(r.q('SELECT status FROM orders WHERE id = ?', p.orderId)[0].status).not.toBe(
      'cancelled'
    );
  });
});
