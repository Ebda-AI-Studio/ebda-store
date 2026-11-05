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
          currency: 'EGP',
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
    // the reversal ran INSIDE refundComplete (Opus I4): stock is back and the keyed refundBook is a replay
    expect(r.q("SELECT inventory FROM products WHERE id = 'sku'")[0].inventory).toBe(20);
    expect(r.op('refundBook', { orderId: p.o.orderId }).replayed).toBe(true);
    expect(r.q("SELECT inventory FROM products WHERE id = 'sku'")[0].inventory).toBe(20);
  });

  it('FAILURE INJECTION (Opus I4): a failing whole-order reversal rolls refundComplete back whole, and the retry converges', () => {
    const r = rig();
    const p = r.paid(3);
    p.hook('evt-p');
    const claim = r.op('refundBegin', { paymentId: p.paymentId, refundKey: 'rk-inject-1' });
    r.raw.exec(
      `CREATE TRIGGER inject_reversal BEFORE UPDATE OF refund_reversed_at ON orders WHEN NEW.refund_reversed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected'); END`
    );
    expect(() => r.op('refundComplete', { claimId: claim.claimId, refundId: 'rf-9' })).toThrow();
    // nothing half-applied: no executed marker, the order was not flipped, stock still held
    expect(
      r.q("SELECT count(*) n FROM payment_events WHERE event_type = 'refund_executed'")[0].n
    ).toBe(0);
    expect(r.q('SELECT status FROM orders')[0].status).not.toBe('refunded');
    expect(r.q("SELECT inventory FROM products WHERE id = 'sku'")[0].inventory).toBe(17);
    r.raw.exec('DROP TRIGGER inject_reversal');
    r.op('refundComplete', { claimId: claim.claimId, refundId: 'rf-9' });
    expect(r.q('SELECT status FROM orders')[0].status).toBe('refunded');
    expect(r.q('SELECT refund_reversed_at FROM orders')[0].refund_reversed_at).not.toBeNull();
    expect(r.q("SELECT inventory FROM products WHERE id = 'sku'")[0].inventory).toBe(20);
    // a second retry changes nothing
    r.op('refundComplete', { claimId: claim.claimId, refundId: 'rf-9' });
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
    // the gateway charges the amount DUE: the wallet part was paid at checkout (Ruling NZ-MONEY-1)
    const gateway = o.total - o.walletAmount;
    expect(gateway).toBe(o.total - 500);
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
          currency: 'EGP',
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

  it('EXTERNAL FACT (Opus I3): a capture on a CANCELLED order is recorded in full, the order is flagged and alerted, nothing rolls back', () => {
    const r = rig();
    const p = r.paid(2);
    r.op('cancel', { orderId: p.o.orderId });
    expect(r.q('SELECT status FROM orders')[0].status).toBe('cancelled');
    const out = p.hook('evt-late');
    expect(out.outcome).toBe('applied');
    expect(out.postCommit ?? []).not.toContain('order_paid');
    expect(out.alerts.map((a: { kind: string }) => a.kind)).toContain(
      'captured_on_unconfirmable_order'
    );
    expect(r.q('SELECT status FROM payments')[0].status).toBe('completed');
    expect(r.q("SELECT count(*) n FROM payment_event_log WHERE event_id = 'evt-late'")[0].n).toBe(
      1
    );
    const o = r.q('SELECT status, payment_status FROM orders')[0];
    expect(o).toEqual({ status: 'cancelled', payment_status: 'paid' });
    expect(
      r.q(
        "SELECT metadata FROM order_events WHERE metadata LIKE '%captured_on_unconfirmable_order%'"
      )
    ).toHaveLength(1);
    // the gateway retrying the same delivery is a replay, not a second record
    expect(p.hook('evt-late').outcome).toBe('replayed');
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

// NEON-ZERO money path (POST /payments/create on a Durable Object store; AffiliateService.createPayout).
describe('payment creation on the DO: amount due, COD once, InstaPay hold, affiliate payout', () => {
  it('paymentCreate charges the amount DUE (total less the wallet part) and stores the metadata', () => {
    const r = rig();
    const o = r.op('createOrder', {
      lines: [{ productId: 'sku', quantity: 2 }],
      shippingAddress: { phone: '01000000011' },
      paymentMethod: 'cod',
    });
    r.raw.exec(`UPDATE orders SET wallet_amount = 300 WHERE id = '${o.orderId}'`);
    expect(
      r.code('paymentCreate', { orderId: o.orderId, provider: 'paymob', amount: o.total })
    ).toBe('PAYMENT_AMOUNT_MISMATCH/409');
    const { paymentId } = r.op('paymentCreate', {
      orderId: o.orderId,
      provider: 'cod',
      method: 'cod',
      amount: o.total - 300,
      metadata: { codFee: 0, walletAmount: 300 },
    });
    const row = r.q(
      'SELECT status, amount, method, metadata FROM payments WHERE id = ?',
      paymentId
    )[0];
    expect(row).toMatchObject({ status: 'cod_pending', amount: o.total - 300, method: 'cod' });
    expect(JSON.parse(row.metadata)).toEqual({ codFee: 0, walletAmount: 300 });
    expect(
      r.code('paymentCreate', {
        orderId: o.orderId,
        provider: 'cod',
        amount: o.total - 300,
        metadata: [1],
      })
    ).toBe('PAYMENT_METADATA_INVALID/400');
  });

  it('a second COD create while one is open returns the SAME row (a double-click cannot mint two); a failed one does not block', () => {
    const r = rig();
    const o = r.op('createOrder', {
      lines: [{ productId: 'sku', quantity: 1 }],
      shippingAddress: { phone: '01000000012' },
      paymentMethod: 'cod',
    });
    const a = r.op('paymentCreate', { orderId: o.orderId, provider: 'cod', amount: o.total });
    const b = r.op('paymentCreate', { orderId: o.orderId, provider: 'cod', amount: o.total });
    expect(b).toEqual({ paymentId: a.paymentId, replayed: true });
    expect(r.q("SELECT COUNT(*) AS n FROM payment_events WHERE event_type = 'created'")[0].n).toBe(
      1
    );
    r.raw.exec(`UPDATE payments SET status = 'failed' WHERE id = '${a.paymentId}'`);
    const c = r.op('paymentCreate', { orderId: o.orderId, provider: 'cod', amount: o.total });
    expect(c.paymentId).not.toBe(a.paymentId);
  });

  it('instapayInitiate: the hold + a pending row + both events in one section; a replay returns the same row; refusals', () => {
    const r = rig();
    const o = r.op('createOrder', {
      lines: [{ productId: 'sku', quantity: 1 }],
      shippingAddress: { phone: '01000000013' },
      paymentMethod: 'instapay',
    });
    const exp = Date.now() + 3_600_000;
    const args = {
      orderId: o.orderId,
      expiresAt: exp,
      providerRef: 'R-1',
      metadata: { handle: 'h@ip' },
    };
    const first = r.op('instapayInitiate', args);
    expect(first).toMatchObject({
      created: true,
      amountMinor: o.total,
      expiresAt: exp,
      metadata: { handle: 'h@ip' },
    });
    const ord = r.q(
      'SELECT status, payment_confirmation_expires_at AS e FROM orders WHERE id = ?',
      o.orderId
    )[0];
    expect(ord).toEqual({ status: 'awaiting_payment_confirmation', e: exp });
    expect(
      r.q('SELECT provider, status, transaction_id FROM payments WHERE order_id = ?', o.orderId)
    ).toEqual([{ provider: 'instapay', status: 'pending', transaction_id: 'R-1' }]);
    expect(
      r.q('SELECT to_status FROM order_events WHERE order_id = ?', o.orderId).map(x => x.to_status)
    ).toContain('awaiting_payment_confirmation');
    const again = r.op('instapayInitiate', { ...args, expiresAt: exp + 999 });
    expect(again).toMatchObject({ created: false, paymentId: first.paymentId, expiresAt: exp });
    expect(r.q('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', o.orderId)[0].n).toBe(1);
    r.raw.exec(`UPDATE orders SET status = 'cancelled' WHERE id = '${o.orderId}'`);
    expect(r.code('instapayInitiate', args)).toBe('ORDER_NOT_PAYABLE/409');
  });

  it('affiliatePayout debits the pending balance once; an amount over it is refused and writes nothing', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO affiliates (id, store_id, name, email, referral_code, status, pending_balance) VALUES ('af1', 's1', 'A', 'a@x', 'RC1', 'approved', 1000)`
    );
    expect(r.code('affiliatePayout', { affiliateId: 'af1', amount: 1001 })).toBe(
      'INSUFFICIENT_BALANCE/400'
    );
    expect(r.code('affiliatePayout', { affiliateId: 'nope', amount: 1 })).toBe('NOT_FOUND/404');
    expect(r.code('affiliatePayout', { affiliateId: 'af1', amount: 0 })).toBe('INVALID_AMOUNT/400');
    const p = r.op('affiliatePayout', { affiliateId: 'af1', amount: 600, method: 'bank' });
    expect(p.payout).toMatchObject({
      affiliateId: 'af1',
      amount: 600,
      method: 'bank',
      status: 'pending',
    });
    expect(r.code('affiliatePayout', { affiliateId: 'af1', amount: 600 })).toBe(
      'INSUFFICIENT_BALANCE/400'
    );
    expect(
      r.q("SELECT pending_balance AS p, total_paid AS t FROM affiliates WHERE id = 'af1'")[0]
    ).toEqual({ p: 400, t: 600 });
    expect(r.q('SELECT COUNT(*) AS n FROM affiliate_payouts')[0].n).toBe(1);
    expect(
      r.q("SELECT COUNT(*) AS n FROM affiliate_events WHERE event_type = 'payout_initiated'")[0].n
    ).toBe(1);
  });
});

// Review I-4 of PR 455: a signed `completed` delivery confirms the order only with the amount due in the payment's currency.
describe('a completed webhook is bound to the amount due and the currency', () => {
  it.each([
    ['an overpayment', { amount: 99_999 }, 'paid_amount_mismatch'],
    ['a short payment', { amount: 1 }, 'paid_amount_mismatch'],
    ['another currency', { currency: 'USD' }, 'paid_currency_mismatch'],
    ['no amount', { amount: undefined }, 'paid_amount_missing'],
    ['no currency', { currency: undefined }, 'paid_currency_mismatch'],
  ] as const)('%s: held, recorded in full, order not paid, alert raised', (_n, extra, reason) => {
    const r = rig();
    const p = r.paid();
    const out = p.hook('evt-mm', { status: 'completed', ...extra });
    expect(out.outcome).toBe('held');
    expect(out.alerts.map((a: { kind: string }) => a.kind)).toContain('amount_mismatch');
    expect(r.q('SELECT payment_status, status FROM orders WHERE id = ?', p.o.orderId)[0]).toEqual({
      payment_status: 'unpaid',
      status: 'pending',
    });
    expect(r.q('SELECT status FROM payments WHERE id = ?', p.paymentId)[0].status).toBe('pending');
    const ev = r.q(
      "SELECT details FROM payment_events WHERE payment_id = ? AND event_type = 'reconciliation'",
      p.paymentId
    );
    expect(JSON.parse(ev[0].details).reason).toBe(reason);
    // the right delivery afterwards still confirms it
    expect(p.hook('evt-ok', { status: 'completed' }).outcome).toBe('applied');
    expect(
      r.q('SELECT payment_status FROM orders WHERE id = ?', p.o.orderId)[0].payment_status
    ).toBe('paid');
  });
});

describe('wallet-split order end to end, keyed payout (review minors)', () => {
  it('a wallet-part-paid order: the gateway charges the due, a webhook for the due confirms it, one for the full total is held', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO customer_wallets (id, store_id, customer_id, balance) VALUES ('w9','s1','u9',2000)`
    );
    const mk = (phone: string) =>
      r.op('createOrder', {
        lines: [{ productId: 'sku', quantity: 2 }],
        shippingAddress: { phone },
        customerId: 'u9',
        walletAmount: 500,
      });
    const o = mk('01000000091');
    const due = o.total - o.walletAmount;
    expect(o.walletAmount).toBe(500);
    expect(
      r.code('paymentCreate', { orderId: o.orderId, provider: 'paymob', amount: o.total })
    ).toBe('PAYMENT_AMOUNT_MISMATCH/409');
    r.op('paymentCreate', {
      orderId: o.orderId,
      provider: 'paymob',
      amount: due,
      transactionId: 'tx-w9',
    });
    const hook = (eventId: string, amount: number) =>
      r.op('paymentWebhook', {
        input: {
          provider: 'paymob',
          eventId,
          providerRef: 'tx-w9',
          kind: 'payment',
          status: 'completed',
          amount,
          currency: 'EGP',
        },
        confirmed: null,
      });
    expect(hook('e-full', o.total).outcome).toBe('held');
    expect(r.q('SELECT payment_status FROM orders WHERE id = ?', o.orderId)[0].payment_status).toBe(
      'unpaid'
    );
    expect(hook('e-due', due).outcome).toBe('applied');
    expect(r.q('SELECT payment_status FROM orders WHERE id = ?', o.orderId)[0].payment_status).toBe(
      'paid'
    );
    expect(r.q("SELECT balance FROM customer_wallets WHERE id = 'w9'")[0].balance).toBe(1500);
  });

  it('a keyed payout replays its first answer and debits once', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO affiliates (id, store_id, name, email, referral_code, status, pending_balance) VALUES ('af2', 's1', 'B', 'b@x', 'RC2', 'approved', 1000)`
    );
    const a = r.op('affiliatePayout', { affiliateId: 'af2', amount: 300 }, 'payout:s1:af2:k1');
    const b = r.op('affiliatePayout', { affiliateId: 'af2', amount: 300 }, 'payout:s1:af2:k1');
    expect(b.payout.id).toBe(a.payout.id);
    expect(r.q("SELECT pending_balance AS p FROM affiliates WHERE id = 'af2'")[0].p).toBe(700);
    expect(r.q("SELECT COUNT(*) AS n FROM affiliate_payouts WHERE affiliate_id = 'af2'")[0].n).toBe(
      1
    );
  });
});

describe('paymentIndexCheck (Ruling NZ-MONEY-2, review NEW-1)', () => {
  it('answers the payment of THIS store and names its index ids; an unknown payment is 404', async () => {
    const r = rig();
    const p = r.paid();
    expect(r.op('paymentIndexCheck', { paymentId: p.paymentId })).toEqual({
      paymentId: p.paymentId,
    });
    expect(r.code('paymentIndexCheck', { paymentId: 'nope' })).toBe('PAYMENT_NOT_FOUND/404');
    const { paymentIndexIds } = await import('../src/platform/entity-index');
    expect(paymentIndexIds(r.db, 's1', p.paymentId)).toEqual([
      { kind: 'payment', id: p.paymentId },
      { kind: 'webhook', id: `paymob:${p.ref}` },
    ]);
    expect(paymentIndexIds(r.db, 'other-store', p.paymentId)).toEqual([]);
  });
});
