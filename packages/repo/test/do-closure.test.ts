/**
 * Ruling NZ-D15 on the real StoreDO schema (node:sqlite): money in flight is read from the DO itself, and closing a store sets ONE
 * flag and deletes nothing, so payments, refunds and fiscal documents stay readable.
 */
import { describe, expect, it } from 'vitest';
import { openSqlite, insertSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import {
  closeIfNoMoneyInFlight,
  closeStore,
  isStoreClosed,
  moneyInFlightOnDo,
  reopenAfterFailedDelete,
  totalInFlight,
} from '../src/do/closure';

const S = 's1';
const order = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  storeId: S,
  orderNumber: id,
  status: 'delivered',
  paymentStatus: 'paid',
  subtotal: 1000,
  discount: 0,
  tax: 0,
  shipping: 0,
  total: 1000,
  shippingAddress: {},
  billingAddress: {},
  updatedAt: new Date(),
  createdAt: new Date(),
  ...over,
});

function rig() {
  const db = openSqlite();
  return { db, sql: nodeSyncSql(db) };
}

describe('moneyInFlightOnDo', () => {
  it('a clean store has nothing in flight', () => {
    const { db, sql } = rig();
    insertSqlite(db, 'Order', [order('o1')]);
    expect(totalInFlight(moneyInFlightOnDo(sql))).toBe(0);
  });
  it('counts a paid-but-undelivered order, a transfer awaiting confirmation, an open return, a disputed payment, a payout and a wallet', () => {
    const { db, sql } = rig();
    db.exec('PRAGMA foreign_keys = OFF'); // wallets / payouts reference customers / affiliates this test does not need
    insertSqlite(db, 'Order', [
      order('o-paid', { status: 'processing' }),
      order('o-wait', { status: 'awaiting_payment_confirmation', paymentStatus: 'unpaid' }),
      order('o-pay', { status: 'delivered' }),
    ]);
    db.prepare(
      "INSERT INTO payments (id, order_id, provider, method, status, amount, currency, created_at, updated_at) VALUES ('p1','o-pay','x','card','disputed',1000,'EGP',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO customer_wallets (id, store_id, customer_id, balance, created_at, updated_at) VALUES ('w1','s1','c1',500,1,1)"
    ).run();
    db.prepare(
      "INSERT INTO affiliate_payouts (id, store_id, affiliate_id, amount, method, status, created_at, updated_at) VALUES ('ap1','s1','a1',100,'bank','pending',1,1)"
    ).run();
    const f = moneyInFlightOnDo(sql);
    expect(f).toMatchObject({
      paidUndelivered: 1,
      awaitingTransferConfirmation: 1,
      paymentsInDispute: 1,
      unsettledPayouts: 1,
      walletBalances: 1,
    });
    expect(totalInFlight(f)).toBeGreaterThanOrEqual(5);
  });
});

describe('closeStore', () => {
  it('sets one flag, is idempotent, and deletes nothing (payments, fiscal documents stay readable)', () => {
    const { db, sql } = rig();
    insertSqlite(db, 'Order', [order('o1')]);
    db.prepare(
      "INSERT INTO payments (id, order_id, provider, method, status, amount, currency, created_at, updated_at) VALUES ('p1','o1','x','card','completed',1000,'EGP',1,1)"
    ).run();
    const count = (t: string) =>
      (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;
    const before = {
      orders: count('orders'),
      payments: count('payments'),
      fiscal: count('fiscal_documents'),
    };
    expect(isStoreClosed(sql)).toBe(false);
    closeStore(sql);
    closeStore(sql);
    expect(isStoreClosed(sql)).toBe(true);
    expect({
      orders: count('orders'),
      payments: count('payments'),
      fiscal: count('fiscal_documents'),
    }).toEqual(before);
    expect(count('do_flags')).toBe(1);
  });
});

describe('closeIfNoMoneyInFlight: atomic gate + close (Ruling NZ-D17)', () => {
  /** A write path as the DO runs it: refused once the store is closed, otherwise it lands. */
  const placeOrder = (
    db: ReturnType<typeof rig>['db'],
    sql: ReturnType<typeof rig>['sql'],
    id: string
  ) => {
    if (isStoreClosed(sql)) return 'refused-410';
    insertSqlite(db, 'Order', [order(id, { status: 'processing' })]); // paid, not delivered = money in flight
    return 'landed';
  };

  it('order lands first: the close is REFUSED, the store stays open, nothing is flagged', () => {
    const { db, sql } = rig();
    expect(placeOrder(db, sql, 'o1')).toBe('landed');
    const r = closeIfNoMoneyInFlight(sql);
    expect(r).toMatchObject({ refused: true, counts: { paidUndelivered: 1 } });
    expect(isStoreClosed(sql)).toBe(false);
    expect((db.prepare('SELECT count(*) n FROM do_flags').get() as { n: number }).n).toBe(0);
  });
  it('close lands first: the closed store REFUSES the order (410), and it is never both', () => {
    const { db, sql } = rig();
    expect(closeIfNoMoneyInFlight(sql)).toEqual({ closed: true, transitioned: true });
    expect(placeOrder(db, sql, 'o2')).toBe('refused-410');
    expect((db.prepare('SELECT count(*) n FROM orders').get() as { n: number }).n).toBe(0);
  });
  it('the check and the flag are ONE transaction: a failure after the check rolls the close back', () => {
    const { db, sql } = rig();
    const failing = {
      ...sql,
      run: (q: string, p: unknown[]) => {
        if (/closed_by_delete/.test(q)) throw new Error('boom');
        return sql.run(q, p);
      },
    };
    expect(() => closeIfNoMoneyInFlight(failing)).toThrow('boom');
    expect(isStoreClosed(sql)).toBe(false);
  });
  it('an already closed store: closed, transitioned false', () => {
    const { sql } = rig();
    closeStore(sql);
    expect(closeIfNoMoneyInFlight(sql)).toEqual({ closed: true, transitioned: false });
  });
  it('reopenAfterFailedDelete clears only the flags the close set; a store closed earlier stays closed', () => {
    const { sql } = rig();
    expect(closeIfNoMoneyInFlight(sql)).toMatchObject({ transitioned: true });
    expect(reopenAfterFailedDelete(sql)).toEqual({ reopened: true });
    expect(isStoreClosed(sql)).toBe(false);
    closeStore(sql); // closed by something else
    expect(reopenAfterFailedDelete(sql)).toEqual({ reopened: false });
    expect(isStoreClosed(sql)).toBe(true);
  });
});
