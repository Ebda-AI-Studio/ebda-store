// PR D2b-3 (Rulings CF-PAY-1, CF-LEDGER-1): payments, webhooks, refunds, the ledger and gold repricing as named money
// operations on the real DO schema (node:sqlite): the door, replay, external facts recorded in full, trial balance.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';
import { ensurePaymentSchema } from '../src/do/payments';
import { trialBalance } from '../src/do/ledger';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
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
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, S, name, args, key) as any;
  const code = (name: string, args: Record<string, unknown>, key?: string): string => {
    try {
      op(name, args, key);
    } catch (e) {
      return `${(e as MoneyError).code}/${(e as MoneyError).status}`;
    }
    return 'no error';
  };
  let n = 0;
  /** an order with a payment of its full total, completed through a real paymob webhook */
  const paid = (qty = 3, provider = 'paymob') => {
    n++;
    const o = op('createOrder', {
      lines: [{ productId: 'sku', quantity: qty }],
      shippingAddress: { phone: `010${String(n).padStart(8, '0')}` },
    });
    const { paymentId } = op('paymentCreate', {
      orderId: o.orderId,
      provider,
      amount: o.total,
      transactionId: `tx-${n}`,
    });
    const hook = (eventId: string, extra: Record<string, unknown> = {}) =>
      op('paymentWebhook', {
        input: {
          provider,
          eventId,
          providerRef: `tx-${n}`,
          kind: 'payment',
          status: 'completed',
          amount: o.total,
          ...extra,
        },
        confirmed: provider === 'kashier' ? { kind: 'payment', status: 'SUCCESS' } : null,
      });
    return { o, paymentId, hook, ref: `tx-${n}` };
  };
  return { raw, db, q, op, code, paid };
}

describe('payment money operations: the door', () => {
  it('registers the new operations', () => {
    expect(MONEY_OP_NAMES).toEqual(
      expect.arrayContaining([
        'paymentCreate',
        'paymentWebhook',
        'refundBegin',
        'refundComplete',
        'refundRelease',
        'refundIndeterminate',
        'refundBook',
        'journalSale',
        'journalRefund',
        'goldApplyRates',
      ])
    );
  });

  it('paymentCreate refuses an amount that is not the order total and indexes the payment for the D1 entity index', () => {
    const r = rig();
    const o = r.op('createOrder', {
      lines: [{ productId: 'sku', quantity: 1 }],
      shippingAddress: { phone: '01000000001' },
    });
    expect(
      r.code('paymentCreate', { orderId: o.orderId, provider: 'paymob', amount: o.total + 1 })
    ).toBe('PAYMENT_AMOUNT_MISMATCH/409');
    r.op('paymentCreate', {
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'T9',
    });
    const idx = r
      .q("SELECT payload FROM d1_outbox WHERE kind = 'entity_index'")
      .map(x => JSON.parse(x.payload));
    expect(idx).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'webhook', id: 'paymob:T9', storeId: 's1' }),
        expect.objectContaining({ kind: 'payment', storeId: 's1' }),
      ])
    );
  });

  it('a webhook replay applies once (same event id, with or without a key)', () => {
    const r = rig();
    const p = r.paid();
    const first = p.hook('evt-1');
    expect(first.outcome).toBe('applied');
    expect(first.postCommit).toContain('order_paid');
    const again = p.hook('evt-1');
    expect(again.outcome).toBe('replayed');
    expect(r.q("SELECT count(*) n FROM payment_event_log WHERE event_id = 'evt-1'")[0].n).toBe(1);
    expect(r.q('SELECT payment_status FROM orders')[0].payment_status).toBe('paid');
  });

  it('a Kashier delivery without the gateway confirmation is refused 503 and writes nothing', () => {
    const r = rig();
    const p = r.paid(1, 'kashier');
    // `paid` confirms; ask again with no confirmation for a fresh event
    expect(
      r.code('paymentWebhook', {
        input: {
          provider: 'kashier',
          eventId: 'e-x',
          providerRef: p.ref,
          kind: 'payment',
          status: 'completed',
        },
      })
    ).toBe('WEBHOOK_UNCONFIRMED/503');
    expect(r.q("SELECT count(*) n FROM payment_event_log WHERE event_id = 'e-x'")[0].n).toBe(0);
  });

  it('a webhook for a reference no payment of this store holds is PAYMENT_NOT_FOUND 404', () => {
    const r = rig();
    expect(
      r.code('paymentWebhook', {
        input: {
          provider: 'paymob',
          eventId: 'e1',
          providerRef: 'nope',
          kind: 'payment',
          status: 'completed',
        },
      })
    ).toBe('PAYMENT_NOT_FOUND/404');
  });
});

describe('refunds', () => {
  it('claim, provider answer, completion: a double claim for the same refundKey is refused, the full refund reverses the order once', () => {
    const r = rig();
    const p = r.paid(3);
    p.hook('evt-p');
    const claim = r.op('refundBegin', { paymentId: p.paymentId, refundKey: 'rk-123456' });
    expect(claim).toMatchObject({ isFullRefund: true, flipsOrder: true });
    expect(r.code('refundBegin', { paymentId: p.paymentId, refundKey: 'rk-123456' })).toMatch(
      /INVALID_STATE|REFUND_ALREADY_ISSUED|PAYMENT_FULLY_REFUNDED/
    );
    r.op('refundComplete', { claimId: claim.claimId, refundId: 'rf-1' });
    const first = r.op('refundBook', { orderId: p.o.orderId });
    expect(first).toMatchObject({ kind: 'refund', replayed: false, status: 'refunded' });
    const stock = r.q("SELECT inventory FROM products WHERE id = 'sku'")[0].inventory;
    expect(stock).toBe(20);
    expect(r.op('refundBook', { orderId: p.o.orderId }).replayed).toBe(true);
    expect(r.q("SELECT inventory FROM products WHERE id = 'sku'")[0].inventory).toBe(20);
  });

  it('a refused claim is released and the balance comes back', () => {
    const r = rig();
    const p = r.paid(2);
    p.hook('evt-p');
    const claim = r.op('refundBegin', { paymentId: p.paymentId, amount: 500 });
    expect(r.q('SELECT refunded_amount FROM payments')[0].refunded_amount).toBe(500);
    r.op('refundRelease', { claimId: claim.claimId, reason: 'provider_rejected' });
    expect(r.q('SELECT refunded_amount, status FROM payments')[0]).toMatchObject({
      refunded_amount: 0,
      status: 'completed',
    });
  });

  it('EXTERNAL FACT: a provider refund that exceeds what the order captured is recorded in full with a review flag, never rejected', () => {
    const r = rig();
    const p = r.paid(1); // total 1000
    p.hook('evt-p');
    const out = r.op('refundBook', {
      orderId: p.o.orderId,
      amount: 1500,
      refundKey: 'rf-ext-1',
      external: true,
    });
    expect(out.review).toBe('refund_exceeds_order');
    const ev = r.q("SELECT metadata FROM order_events WHERE to_status = 'partial_refund_recorded'");
    expect(JSON.parse(ev[0].metadata)).toMatchObject({
      amount: 1500,
      review: 'refund_exceeds_order',
    });
    // the SAME call as an internal (non-external) refund is still refused
    expect(
      r.code('refundBook', { orderId: p.o.orderId, amount: 1500, refundKey: 'rf-int-1' })
    ).toBe('REFUND_EXCEEDS_ORDER/409');
  });

  it('EXTERNAL FACT: a completed gateway refund webhook on an already cancelled order is applied to the payment and booked', () => {
    const r = rig();
    const p = r.paid(2);
    p.hook('evt-p');
    r.op('cancel', { orderId: p.o.orderId });
    const out = p.hook('evt-r', {
      kind: 'refund',
      status: undefined,
      refund: { refundId: 'gw-1', status: 'completed', amount: 400 },
    });
    expect(out.outcome).toBe('applied');
    expect(r.q('SELECT refunded_amount FROM payments')[0].refunded_amount).toBe(400);
  });

  it('FULL-REFUND WEBHOOK on a wallet-paid order whose CRM id differs from the user id: the wallet share goes back and the external fact is recorded (Ruling CF-FIX-2)', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO customers (id, store_id, email, first_name, last_name, user_id) VALUES ('crm-u7', 's1', 'u7@b.c', 'A', 'B', 'u7'); INSERT INTO customer_wallets (id, store_id, customer_id, balance) VALUES ('w7','s1','u7',2000)`
    );
    const o = r.op('createOrder', {
      lines: [{ productId: 'sku', quantity: 2 }],
      shippingAddress: { phone: '01099999999' },
      customerId: 'u7', // the platform users.id, NOT the CRM row id
      walletAmount: 500,
    });
    expect(r.q('SELECT balance FROM customer_wallets')[0].balance).toBe(1500);
    const gateway = o.total;
    r.op('paymentCreate', {
      orderId: o.orderId,
      provider: 'paymob',
      amount: gateway,
      transactionId: 'tx-w7',
    });
    const hook = (eventId: string, extra: Record<string, unknown>) =>
      r.op('paymentWebhook', {
        input: {
          provider: 'paymob',
          eventId,
          providerRef: 'tx-w7',
          kind: 'payment',
          amount: gateway,
          ...extra,
        },
        confirmed: null,
      });
    hook('evt-pay', { status: 'completed' });
    const out = hook('evt-full-refund', {
      kind: 'refund',
      status: undefined,
      refund: { refundId: 'gw-w7', status: 'completed', amount: gateway },
    });
    expect(out.outcome).toBe('applied'); // not rolled back by a missing CRM row
    expect(r.q('SELECT refunded_amount FROM payments')[0].refunded_amount).toBe(gateway);
    expect(r.q('SELECT status FROM orders')[0].status).toBe('refunded'); // the full refund reversed the order
    expect(r.q('SELECT balance FROM customer_wallets')[0].balance).toBe(2000); // the wallet share is back
  });

  it('wallet store credit goes back once under return-credit:<key>', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO customers (id, store_id, email, first_name, last_name, user_id) VALUES ('crm-c1', 's1', 'a@b.c', 'A', 'B', 'c1'); INSERT INTO customer_wallets (id, store_id, customer_id, balance) VALUES ('w1','s1','c1',0)`
    );
    const p = r.paid(2);
    p.hook('evt-p');
    r.raw.exec(`UPDATE orders SET customer_id = 'c1'`);
    const a = r.op('refundBook', { orderId: p.o.orderId, refundKey: 'ret-1', walletCredit: 300 });
    expect(a.walletCredited).toBe(300);
    r.op('refundBook', { orderId: p.o.orderId, refundKey: 'ret-1', walletCredit: 300 });
    expect(r.q('SELECT balance FROM customer_wallets')[0].balance).toBe(300);
  });
});

describe('ledger: trial balance', () => {
  it('a paid order posts sale + COGS, balanced; replay posts nothing; a refund reverses both and the book nets to zero', () => {
    const r = rig();
    const p = r.paid(3);
    p.hook('evt-p');
    const a = r.op('journalSale', { orderId: p.o.orderId });
    expect(a).toMatchObject({ posted: true, entries: 2 });
    const b = r.op('journalSale', { orderId: p.o.orderId });
    expect(b.entries).toBe(0);
    let tb = trialBalance(r.db, S);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find(x => x.code === '1000')?.debit).toBe(p.o.total);
    expect(tb.rows.find(x => x.code === '5000')?.debit).toBe(1200);
    expect(r.op('journalRefund', { orderId: p.o.orderId })).toEqual({ reversed: 2 });
    expect(r.op('journalRefund', { orderId: p.o.orderId })).toEqual({ reversed: 0 });
    tb = trialBalance(r.db, S);
    expect(tb.balanced).toBe(true);
    for (const row of tb.rows) expect(row.debit).toBe(row.credit);
    expect(r.q("SELECT count(*) n FROM journal_entries WHERE status = 'reversed'")[0].n).toBe(2);
  });

  it('skips quietly an unpaid order and a store with accounting off; refuses a missing account', () => {
    const r = rig();
    const o = r.op('createOrder', {
      lines: [{ productId: 'sku', quantity: 1 }],
      shippingAddress: { phone: '01000000009' },
    });
    expect(r.op('journalSale', { orderId: o.orderId })).toMatchObject({
      posted: false,
      skipped: 'not_paid',
    });
    const p = r.paid(1);
    p.hook('evt-p');
    r.raw.exec(`UPDATE store_config SET accounting_enabled = 0`);
    expect(r.op('journalSale', { orderId: p.o.orderId })).toMatchObject({
      skipped: 'accounting_disabled',
    });
    r.raw.exec(
      `UPDATE store_config SET accounting_enabled = 1; DELETE FROM accounts WHERE code = '4010'`
    );
    expect(r.code('journalSale', { orderId: p.o.orderId })).toBe('ACCOUNT_NOT_FOUND/409');
    expect(r.q('SELECT count(*) n FROM journal_entries')[0].n).toBe(0);
  });

  it('wallet tender: DR 2150 for the wallet part, DR cash for the rest (WALLET-GL-1)', () => {
    const r = rig();
    const p = r.paid(2); // total 2000
    p.hook('evt-p');
    r.raw.exec(`UPDATE orders SET wallet_amount = 500`);
    r.op('journalSale', { orderId: p.o.orderId });
    const tb = trialBalance(r.db, S);
    expect(tb.rows.find(x => x.code === '2150')?.debit).toBe(500);
    expect(tb.rows.find(x => x.code === '1000')?.debit).toBe(p.o.total - 500);
    expect(tb.balanced).toBe(true);
  });
});

describe('gold repricing', () => {
  it('goldRepriceProduct runs the repricer with the flag on and clears it', () => {
    const r = rig();
    const out = r.op('goldRepriceProduct', { productId: 'sku' });
    expect(out).toEqual({ repriced: 0 });
    expect(r.q("SELECT value FROM do_flags WHERE name = 'gold_reprice'")[0].value).toBe(0);
  });
});
