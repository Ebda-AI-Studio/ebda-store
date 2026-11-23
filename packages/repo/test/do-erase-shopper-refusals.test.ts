// CLOSE-ACCOUNT-2: a shopper closing their own account is refused (409, nothing written) while an order or return is in flight,
// and a shopper with no orders / wallet / loyalty row erases cleanly.
import { describe, expect, it, vi } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { eraseShopper } from '../src/do/erase-shopper';
import { ensureCustomerAuthSchema } from '../src/do/customer-auth';
import { ensureReceiptSchema } from '../src/do/instapay-receipts';

vi.mock('@ebda/shared', async () => await import('../../shared/src/region'));

const input = (over: object = {}) =>
  ({
    storeId: 's1',
    userId: 'a',
    role: 'customer',
    email: 'a@x.test',
    phone: null,
    smsPhoneKey: null,
    provenBuyerKey: null,
    actorId: 'a',
    capWindowMs: 1000,
    refuseOpen: true,
    now: 1_700_000_000_000,
    ...over,
  }) as never;
function setup() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureCustomerAuthSchema(db);
  ensureReceiptSchema(db);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
  return { db, x, n };
}
const order = (x: ReturnType<typeof setup>['x'], status: string) =>
  x(
    `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, total, shipping_address, billing_address, status) VALUES ('o1','s1','a','EB-1',100,100,'{}','{}',?)`,
    status
  );

describe('eraseShopper refusals', () => {
  it.each(['pending', 'awaiting_payment_confirmation', 'confirmed', 'processing', 'shipped'])(
    'refuses 409 ACCOUNT_HAS_OPEN_ORDERS for a %s order and writes nothing',
    status => {
      const { db, x, n } = setup();
      order(x, status);
      let e: { code?: string; status?: number } = {};
      try {
        eraseShopper(db, input());
      } catch (err) {
        e = err as never;
      }
      expect([e.code, e.status]).toEqual(['ACCOUNT_HAS_OPEN_ORDERS', 409]);
      // the refusal runs before the ledger DDL: no ledger table, no ledger row
      expect(n(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'erasure_ledger'`)).toBe(0);
      expect(n(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = 'a'`)).toBe(1);
    }
  );
  it('refuses 409 ACCOUNT_HAS_OPEN_RETURN while a return is not settled', () => {
    const { db, x } = setup();
    order(x, 'delivered');
    x(
      `INSERT INTO returns (id, store_id, order_id, customer_id, return_number, type, status, reason, refund_amount, created_at, updated_at) VALUES ('r1','s1','o1','a','R-1','return','approved','x',100,1,1)`
    );
    expect(() => eraseShopper(db, input())).toThrow(/open return/);
  });
  it('a no-orders, no-wallet, no-loyalty shopper erases cleanly; delivered orders do not block', () => {
    const { db, x, n } = setup();
    expect(eraseShopper(db, input()).walletForfeited).toBe(0);
    order(x, 'delivered');
    expect(() => eraseShopper(db, input())).not.toThrow();
    expect(n(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = 'a'`)).toBe(0);
  });
  it('the cron / merchant route (no refuseOpen) erases regardless of an open order', () => {
    const { db, x } = setup();
    order(x, 'pending');
    expect(() => eraseShopper(db, input({ refuseOpen: false }))).not.toThrow();
  });
});
