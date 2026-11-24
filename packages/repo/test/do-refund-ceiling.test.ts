// #624: ONE refundable balance per order across every refund channel (provider/card, InstaPay, store credit, wallet
// share, manual returns), enforced inside the DO section of every refund writer. node:sqlite on the real StoreDO schema.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { ensurePaymentSchema } from '../src/do/payments';
import { refundableBalance } from '../src/do/refundable';
import { MoneyError } from '../src/do/sync-sql';

const DAY = 86_400_000;
const TOTAL = 25650;

function fixture(over: { walletAmount?: number; provider?: string; status?: string } = {}) {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  ensurePaymentSchema(db);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const one = (sql: string, ...p: unknown[]) => raw.prepare(sql).get(...(p as never[])) as any;
  const wallet = over.walletAmount ?? 0;
  x(`INSERT INTO store_config (store_id, return_window_days) VALUES ('s1', NULL)`);
  x(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', 's1', 'Tee', 'tee', 10000, 5, 'active')`
  );
  x(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p2', 's1', 'Cap', 'cap', 5000, 5, 'active')`
  );
  x(
    `INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES ('crm-cust', 's1', 'A', 'B', 'cust')`
  );
  x(
    `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, discount, tax, shipping, total, wallet_amount, shipping_address, billing_address, delivered_at, updated_at, created_at)
     VALUES ('o1', 's1', 'cust', 'ORD-1', ?, 'paid', 25000, 2500, 3150, 0, ?, ?, '{}', '{}', ?, ?, ?)`,
    over.status ?? 'delivered',
    TOTAL,
    wallet,
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
    `INSERT INTO payments (id, order_id, provider, status, amount, created_at, updated_at) VALUES ('pay1', 'o1', ?, 'completed', ?, ?, ?)`,
    over.provider ?? 'paymob',
    TOTAL - wallet,
    Date.now(),
    Date.now()
  );
  if (wallet > 0) {
    x(
      `INSERT INTO customer_wallets (id, store_id, customer_id, balance, created_at, updated_at) VALUES ('w1', 's1', 'cust', 0, ?, ?)`,
      Date.now(),
      Date.now()
    );
    x(
      `INSERT INTO wallet_transactions (id, store_id, wallet_id, customer_id, amount, balance_after, type, idempotency_key, order_id, created_at)
       VALUES ('wt-spend', 's1', 'w1', 'cust', ?, 0, 'order_payment', 'order-payment:o1', 'o1', ?)`,
      -wallet,
      Date.now()
    );
  }
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, 's1', name, args, key) as any;
  const returnFor = (items: Array<[string, string, number]>) => {
    const id = op('returnCreate', {
      orderId: 'o1',
      customerId: 'cust',
      type: 'return',
      reason: 'wrong size',
      items: items.map(([orderItemId, productId, quantity]) => ({
        orderItemId,
        productId,
        quantity,
        productName: 'x',
      })),
    }).returnId as string;
    op('returnStatus', { returnId: id, status: 'approved', userId: 'u1' });
    op('returnStatus', { returnId: id, status: 'received', userId: 'u1' });
    return id;
  };
  const storeCredit = (returnId: string) => {
    op('returnClaim', { returnId, refundMethod: 'store_credit', walletFeature: true });
    return op('returnFinish', {
      returnId,
      refundMethod: 'store_credit',
      walletFeature: true,
      userId: 'u1',
    });
  };
  const providerRefund = (amount?: number, refundId = `rf-${Math.random()}`) => {
    const claim = op('refundBegin', { paymentId: 'pay1', ...(amount ? { amount } : {}) });
    op('refundComplete', { claimId: claim.claimId, refundId });
    return claim;
  };
  const paidOut = () =>
    (one(
      `SELECT COALESCE(SUM(amount), 0) s FROM wallet_transactions WHERE order_id = 'o1' AND amount > 0`
    ).s as number) + (one(`SELECT refunded_amount r FROM payments WHERE id = 'pay1'`).r as number);
  return { raw, db, x, one, op, returnFor, storeCredit, providerRefund, paidOut };
}

const refusal = (fn: () => unknown): MoneyError => {
  try {
    fn();
  } catch (e) {
    return e as MoneyError;
  }
  throw new Error('expected a refusal');
};
const ALL: Array<[string, string, number]> = [
  ['i1', 'p1', 2],
  ['i2', 'p2', 1],
];

describe('refundableBalance: one ceiling, every channel (#624)', () => {
  it('a full provider refund, then a store-credit return of the same goods, is refused (was 2x the order)', () => {
    const f = fixture();
    const r = f.returnFor(ALL);
    f.providerRefund();
    expect(refusal(() => f.storeCredit(r)).code).toMatch(
      /REFUND_EXCEEDS_ORDER|ORDER_ALREADY_REFUNDED/
    );
    expect(f.paidOut()).toBe(TOTAL);
    expect(refundableBalance(f.db, 's1', 'o1').refundable).toBe(0);
  });

  it('store credit first, then a provider refund: the provider leg is capped at what is left (was 1.6x)', () => {
    const f = fixture();
    const r = f.returnFor([['i1', 'p1', 1]]);
    const credited = f.storeCredit(r).walletCredited as number;
    expect(credited).toBeGreaterThan(0);
    const left = TOTAL - credited;
    expect(refusal(() => f.op('refundBegin', { paymentId: 'pay1', amount: TOTAL })).code).toBe(
      'REFUND_EXCEEDS_REMAINING'
    );
    const claim = f.op('refundBegin', { paymentId: 'pay1' }); // "refund the rest"
    expect(claim.amount).toBe(left);
    f.op('refundComplete', { claimId: claim.claimId, refundId: 'rf-rest' });
    expect(f.paidOut()).toBe(TOTAL);
  });

  it('a wallet + card split order never pays out more than its total (was 1.1x)', () => {
    const f = fixture({ walletAmount: 4000 });
    const r = f.returnFor([['i1', 'p1', 1]]);
    f.storeCredit(r);
    f.providerRefund(); // the rest of the card leg, capped
    // the full reversal's wallet give-back is capped too
    f.op('refundBook', { orderId: 'o1' });
    expect(f.paidOut()).toBeLessThanOrEqual(TOTAL);
    expect(refundableBalance(f.db, 's1', 'o1').refundable).toBe(0);
  });

  it('a merchant-recorded InstaPay refund counts store credit already given', () => {
    const f = fixture({ provider: 'instapay' });
    const r = f.returnFor([['i1', 'p1', 1]]);
    const credited = f.storeCredit(r).walletCredited as number;
    const rec = (amountMinor: number, referenceKey: string) =>
      f.op('instapayRefundRecord', { orderId: 'o1', referenceKey, amountMinor, record: {} });
    expect(refusal(() => rec(TOTAL, 'ref-1')).code).toBe('REFUND_EXCEEDS_ORDER');
    rec(TOTAL - credited, 'ref-2');
    expect(f.paidOut()).toBe(TOTAL);
  });

  it('a manual (cash) return counts against the ceiling too', () => {
    const f = fixture();
    const r = f.returnFor(ALL);
    f.op('returnClaim', { returnId: r, refundMethod: 'cash' });
    f.op('returnFinish', { returnId: r, refundMethod: 'cash', userId: 'u1' });
    const left = refundableBalance(f.db, 's1', 'o1').refundable;
    expect(left).toBeLessThan(TOTAL);
    expect(refusal(() => f.op('refundBegin', { paymentId: 'pay1', amount: left + 1 })).code).toBe(
      'REFUND_EXCEEDS_REMAINING'
    );
  });

  it('a completed EXCHANGE does not lower what is still refundable (it moves no money)', () => {
    const f = fixture();
    f.x(
      `INSERT INTO returns (id, store_id, order_id, customer_id, return_number, type, status, reason, refund_method, refund_amount, refunded_at, created_at, updated_at)
       VALUES ('ex1', 's1', 'o1', 'cust', 'RET-EX', 'exchange', 'completed', 'swap', 'cash', 5000, ?, ?, ?)`,
      Date.now(),
      Date.now(),
      Date.now()
    );
    const b = refundableBalance(f.db, 's1', 'o1');
    expect(b.byChannel.manualReturn).toBe(0);
    expect(b.refundable).toBe(TOTAL);
  });

  it('a return on an order already refunded is refused at the claim', () => {
    const f = fixture();
    const r = f.returnFor(ALL);
    f.providerRefund();
    expect(
      refusal(() =>
        f.op('returnClaim', { returnId: r, refundMethod: 'store_credit', walletFeature: true })
      ).code
    ).toBe('ORDER_ALREADY_REFUNDED');
  });

  it('CONCURRENCY: a provider refund claimed between a store-credit claim and its finish wins; the finish is refused, nothing double-paid', () => {
    const f = fixture();
    const r = f.returnFor(ALL);
    // request A: store-credit return claimed (plan computed, wallet not yet written)
    f.op('returnClaim', { returnId: r, refundMethod: 'store_credit', walletFeature: true });
    // request B interleaves: the admin refunds the whole card payment
    const claim = f.op('refundBegin', { paymentId: 'pay1' });
    expect(claim.amount).toBe(TOTAL);
    // request A finishes: the same section re-reads the balance and refuses
    expect(
      refusal(() =>
        f.op('returnFinish', {
          returnId: r,
          refundMethod: 'store_credit',
          walletFeature: true,
          userId: 'u1',
        })
      ).code
    ).toBe('REFUND_EXCEEDS_ORDER');
    expect(f.one('SELECT count(*) n FROM wallet_transactions').n).toBe(0);
    expect(f.paidOut()).toBe(TOTAL);
  });

  it('CONCURRENCY: open (unanswered) provider claims hold the balance: a second claim gets only the rest, a store-credit return gets nothing', () => {
    const f = fixture();
    const first = f.op('refundBegin', { paymentId: 'pay1', amount: 15000 }); // provider call in flight
    const second = f.op('refundBegin', { paymentId: 'pay1' });
    expect(first.amount + second.amount).toBe(TOTAL);
    const r = f.returnFor([['i1', 'p1', 1]]);
    expect(
      refusal(() =>
        f.op('returnClaim', { returnId: r, refundMethod: 'store_credit', walletFeature: true })
      ).code
    ).toBe('REFUND_EXCEEDS_ORDER');
    // the provider refuses the first: its claim is released and the balance comes back for the return
    f.op('refundRelease', { claimId: first.claimId, reason: 'declined' });
    expect(refundableBalance(f.db, 's1', 'o1').refundable).toBe(15000);
    f.storeCredit(r);
    expect(f.paidOut()).toBeLessThanOrEqual(TOTAL);
  });

  it('the merchant-recorded "I refunded it outside a provider" record only records what is left after store credit', () => {
    const f = fixture();
    const r = f.returnFor([['i1', 'p1', 1]]);
    const credited = f.storeCredit(r).walletCredited as number;
    const rec = () =>
      f.op('manualRefundRecord', {
        orderId: 'o1',
        method: 'cash',
        reference: null,
        actorUserId: 'u1',
      });
    expect(rec()).toEqual({ recorded: TOTAL - credited, payments: 1 });
    expect(f.paidOut()).toBe(TOTAL);
    expect(f.one(`SELECT payment_status s FROM orders WHERE id = 'o1'`).s).toBe('refunded');
    expect(rec()).toEqual({ recorded: 0, payments: 0 }); // replay
    expect(f.paidOut()).toBe(TOTAL);
  });

  it('LEGACY: a provider partial refund booked before the external flag existed is not counted twice', () => {
    const f = fixture();
    const claim = f.op('refundBegin', { paymentId: 'pay1', amount: 5000 });
    f.op('refundComplete', { claimId: claim.claimId, refundId: 'rf-legacy' });
    // the booking event as a pre-#624 writer left it: no `external` flag
    f.x(
      `UPDATE order_events SET metadata = json_remove(metadata, '$.external') WHERE order_id = 'o1' AND to_status = 'partial_refund_recorded'`
    );
    expect(
      f.one(
        `SELECT count(*) n FROM order_events WHERE order_id = 'o1' AND to_status = 'partial_refund_recorded' AND json_extract(metadata, '$.refundKey') = 'rf-legacy'`
      ).n
    ).toBe(1);
    expect(refundableBalance(f.db, 's1', 'o1').refundable).toBe(TOTAL - 5000);
    // a merchant-booked amount (no provider refund id behind it) still counts
    f.op('refundBook', { orderId: 'o1', amount: 1000, refundKey: 'cash-1' });
    expect(refundableBalance(f.db, 's1', 'o1').refundable).toBe(TOTAL - 6000);
  });

  it('REVIEW B1: a dashboard full-refund webhook after a cash return never also hands back the wallet share (was 30780 on 25650)', () => {
    const f = fixture({ walletAmount: 4000 }); // 4000 wallet + 21650 card
    const r = f.returnFor([['i2', 'p2', 1]]);
    f.op('returnClaim', { returnId: r, refundMethod: 'cash' });
    f.op('returnFinish', { returnId: r, refundMethod: 'cash', userId: 'u1' });
    expect(f.one(`SELECT refund_amount a FROM returns WHERE id = ?`, r).a).toBe(5130);
    const out = f.op('paymentWebhook', {
      input: {
        storeId: 's1',
        provider: 'paymob',
        providerRef: 'pay1',
        eventId: 'rw-dash-1',
        kind: 'refund',
        refund: { refundId: 'dash-1', status: 'completed', amount: TOTAL - 4000 },
      },
    });
    // the provider's 21650 is an outside fact and is recorded; the 4000 wallet give-back is money WE start: not paid
    expect(f.one(`SELECT refunded_amount r FROM payments WHERE id = 'pay1'`).r).toBe(TOTAL - 4000);
    expect(
      f.one(
        `SELECT COALESCE(SUM(amount), 0) s FROM wallet_transactions WHERE order_id = 'o1' AND amount > 0`
      ).s
    ).toBe(0);
    // ... and the trim is recorded for review and alerted (B2)
    const ev = f.one(
      `SELECT details FROM payment_events WHERE order_id = 'o1' AND event_type = 'refund_reconcile_review'`
    );
    expect(JSON.parse(ev.details)).toMatchObject({
      reason: 'wallet_giveback_trimmed',
      source: 'order_reversal',
      planned: 4000,
      credited: 0,
      short: 4000,
    });
    expect(out.moneyAlerts).toEqual([
      expect.objectContaining({ kind: 'wallet_giveback_trimmed', orderId: 'o1' }),
    ]);
  });

  it('REVIEW B2: a gateway return whose wallet share is cut by the ceiling records the shortfall and alerts', () => {
    const f = fixture({ walletAmount: 4000 });
    const r = f.returnFor([['i2', 'p2', 1]]);
    const plan = f.op('returnClaim', { returnId: r, refundMethod: 'original' });
    expect(plan.walletShare).toBeGreaterThan(0);
    const claim = f.op('refundBegin', {
      paymentId: 'pay1',
      amount: plan.partial.gatewayShare,
      refundKey: `return:${r}`,
      itemLevel: true,
    });
    f.op('refundComplete', { claimId: claim.claimId, refundId: 'rf-ret' });
    // an earlier give-back (recorded elsewhere) has used up all but 100 of the order
    const left = refundableBalance(f.db, 's1', 'o1').refundable;
    f.x(
      `INSERT INTO wallet_transactions (id, store_id, wallet_id, customer_id, amount, balance_after, type, idempotency_key, order_id, created_at)
       VALUES ('wt-other', 's1', 'w1', 'cust', ?, 0, 'refund_credit', 'return-credit:other', 'o1', ?)`,
      left - 100,
      Date.now()
    );
    const done = f.op('returnFinish', { returnId: r, refundMethod: 'original', userId: 'u1' });
    expect(done.walletShareCredited).toBe(100);
    expect(f.paidOut()).toBeLessThanOrEqual(TOTAL);
    const ev = f.one(
      `SELECT details FROM payment_events WHERE order_id = 'o1' AND event_type = 'refund_reconcile_review'`
    );
    expect(JSON.parse(ev.details)).toMatchObject({
      source: 'return_wallet_share',
      planned: plan.walletShare,
      credited: 100,
    });
    expect(done.moneyAlerts).toHaveLength(1);
  });

  it('REVIEW B2: an alert raised inside an operation that rolls back never leaves the DO', () => {
    const f = fixture({ walletAmount: 4000 });
    // a give-back recorded elsewhere leaves 2650 of the order; the full reversal plans 4000 back to the wallet
    f.x(
      `INSERT INTO wallet_transactions (id, store_id, wallet_id, customer_id, amount, balance_after, type, idempotency_key, order_id, created_at)
       VALUES ('wt-x', 's1', 'w1', 'cust', 23000, 0, 'refund_credit', 'manual-credit:x', 'o1', ?)`,
      Date.now()
    );
    // a failing write after the trim inside the same section
    f.x(
      `CREATE TRIGGER boom BEFORE INSERT ON wallet_transactions WHEN NEW.type = 'order_payment_reversal' BEGIN SELECT RAISE(ABORT, 'boom'); END`
    );
    expect(() => f.op('refundBook', { orderId: 'o1' })).toThrow(/boom/);
    f.x('DROP TRIGGER boom');
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_reconcile_review'`).n
    ).toBe(0);
    const out = f.op('refundBook', { orderId: 'o1' });
    expect(out.moneyAlerts).toHaveLength(1); // the committed retry alerts once, not the rolled-back attempt as well
  });
});
