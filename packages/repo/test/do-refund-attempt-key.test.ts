// #628: a provider refund retried under the same client attempt (Idempotency-Key) never claims twice while the first
// claim is open (sent or indeterminate); a provider refusal releases it. node:sqlite on the real StoreDO schema.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { MoneyError } from '../src/do/sync-sql';

function fixture() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const one = (sql: string, ...p: unknown[]) => raw.prepare(sql).get(...(p as never[])) as any;
  x(
    `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, discount, tax, shipping, total, wallet_amount, shipping_address, billing_address, updated_at, created_at)
     VALUES ('o1', 's1', 'cust', 'ORD-1', 'delivered', 'paid', 100000, 0, 0, 0, 100000, 0, '{}', '{}', ?, ?)`,
    Date.now(),
    Date.now()
  );
  x(
    `INSERT INTO payments (id, order_id, provider, status, amount, transaction_id, created_at, updated_at) VALUES ('pay1', 'o1', 'kashier', 'completed', 100000, 'tx1', ?, ?)`,
    Date.now(),
    Date.now()
  );
  const op = (name: string, args: Record<string, unknown>) =>
    runMoneyOp(db, 's1', name, args) as any;
  return { op, one };
}
const refusal = (fn: () => unknown): MoneyError => {
  try {
    fn();
  } catch (e) {
    return e as MoneyError;
  }
  throw new Error('expected a refusal');
};

describe('refundBegin attemptKey (#628)', () => {
  it('an indeterminate first attempt keeps its claim: the retry under the same key is refused, nothing double-refunded', () => {
    const f = fixture();
    const first = f.op('refundBegin', { paymentId: 'pay1', amount: 30000, attemptKey: 'att-1' });
    f.op('refundIndeterminate', { claimId: first.claimId, error: 'timeout' });
    const e = refusal(() =>
      f.op('refundBegin', { paymentId: 'pay1', amount: 30000, attemptKey: 'att-1' })
    );
    expect(e.code).toBe('REFUND_ALREADY_ISSUED');
    expect(f.one(`SELECT refunded_amount r FROM payments WHERE id = 'pay1'`).r).toBe(30000);
  });

  it('a provider refusal releases the claim: the same attempt may try again; a different attempt is a new refund', () => {
    const f = fixture();
    const first = f.op('refundBegin', { paymentId: 'pay1', amount: 30000, attemptKey: 'att-2' });
    f.op('refundRelease', { claimId: first.claimId, reason: 'declined' });
    f.op('refundBegin', { paymentId: 'pay1', amount: 30000, attemptKey: 'att-2' });
    f.op('refundBegin', { paymentId: 'pay1', amount: 10000, attemptKey: 'att-3' });
    expect(f.one(`SELECT refunded_amount r FROM payments WHERE id = 'pay1'`).r).toBe(40000);
  });
});
