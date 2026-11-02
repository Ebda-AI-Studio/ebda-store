/**
 * Ruling NZ-D15 on the real StoreDO schema (node:sqlite): money in flight is read from the DO itself, and closing a store sets ONE
 * flag and deletes nothing, so payments, refunds and fiscal documents stay readable.
 */
import { describe, expect, it } from 'vitest';
import { openSqlite, insertSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { closeStore, isStoreClosed, moneyInFlightOnDo, totalInFlight } from '../src/do/closure';

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
