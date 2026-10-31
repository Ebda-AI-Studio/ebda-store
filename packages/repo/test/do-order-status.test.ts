// PR D2b-4 (Ruling CF-FINAL-1): every remaining order status transition as one money operation (`orderStatus`).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';
import { ensurePaymentSchema } from '../src/do/payments';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  ensurePaymentSchema(db);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'Widget', 'widget', 1500, 10, 'active')`
  );
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, S, name, args, key) as any;
  const code = (name: string, args: Record<string, unknown>, key?: string): string => {
    try {
      op(name, args, key);
    } catch (e) {
      return (e as MoneyError).code;
    }
    return 'no error';
  };
  const place = (paymentMethod = 'cod') =>
    op('createOrder', {
      lines: [{ productId: 'sku', quantity: 1 }],
      shippingAddress: { name: 'A' },
      paymentMethod,
    });
  const row = (sql: string) => raw.prepare(sql).get() as Record<string, any>;
  return { raw, db, op, code, place, row };
}

describe('orderStatus: remaining order status transitions', () => {
  it('is registered', () => {
    expect(MONEY_OP_NAMES).toContain('orderStatus');
  });

  it('moves pending -> confirmed -> processing -> shipped, writes an event per step and arms the fanout', () => {
    const r = rig();
    const { orderId } = r.place();
    const a = r.op('orderStatus', { orderId, status: 'confirmed' });
    expect(a).toMatchObject({ from: 'pending', status: 'confirmed', codSettled: null });
    r.op('orderStatus', { orderId, status: 'processing' });
    r.op('orderStatus', { orderId, status: 'shipped' });
    const o = r.row(`SELECT * FROM orders WHERE id = '${orderId}'`);
    expect(o.status).toBe('shipped');
    expect(o.status_fanout_requested_status).toBe('shipped');
    expect(o.status_fanout_requested_at).toBeGreaterThan(1_700_000_000_000);
    expect(o.status_fanout_claimed_at).toBeNull();
    expect(o.delivered_at).toBeNull();
    expect(
      r.row(
        `SELECT count(*) n FROM order_events WHERE order_id = '${orderId}' AND to_status IN ('confirmed','processing','shipped')`
      ).n
    ).toBe(3);
  });

  it('refuses a backwards or unknown move with the Postgres code, and writes nothing', () => {
    const r = rig();
    const { orderId } = r.place();
    r.op('orderStatus', { orderId, status: 'shipped' });
    expect(r.code('orderStatus', { orderId, status: 'confirmed' })).toBe(
      'INVALID_STATUS_TRANSITION'
    );
    expect(r.code('orderStatus', { orderId, status: 'bogus' })).toBe('BAD_ARGS');
    // cancelled and refunded keep their own reversal operations
    expect(r.code('orderStatus', { orderId, status: 'cancelled' })).toBe('BAD_ARGS');
    expect(r.code('orderStatus', { orderId, status: 'refunded' })).toBe('BAD_ARGS');
    expect(r.row(`SELECT status FROM orders`).status).toBe('shipped');
    expect(r.code('orderStatus', { orderId: 'nope', status: 'confirmed' })).toBe('ORDER_NOT_FOUND');
  });

  it('an InstaPay hold cannot be confirmed by a bare status write', () => {
    const r = rig();
    const { orderId } = r.place();
    r.raw.exec(`UPDATE orders SET status = 'awaiting_payment_confirmation'`);
    expect(r.code('orderStatus', { orderId, status: 'confirmed' })).toBe(
      'INSTAPAY_CONFIRM_REQUIRED'
    );
    expect(r.code('orderStatus', { orderId, status: 'shipped' })).toBe('INVALID_STATUS_TRANSITION');
  });

  it('delivered stamps delivered_at once and settles an unpaid COD payment (MONEYB-7)', () => {
    const r = rig();
    const { orderId, total } = r.place('cod');
    r.op('paymentCreate', { orderId, provider: 'cod', amount: total });
    const a = r.op('orderStatus', { orderId, status: 'delivered' });
    expect(a.codSettled).toEqual(expect.any(String));
    const o = r.row(`SELECT * FROM orders`);
    expect(o).toMatchObject({ status: 'delivered', payment_status: 'paid' });
    expect(o.delivered_at).toBeGreaterThan(1_700_000_000_000);
    expect(r.row(`SELECT status, paid_at FROM payments`)).toMatchObject({ status: 'completed' });
    expect(
      r.row(`SELECT from_status, to_status FROM payment_events WHERE event_type = 'status_change'`)
    ).toEqual({ from_status: 'cod_pending', to_status: 'completed' });
  });

  it('delivered on a paid order or a non-COD order settles nothing', () => {
    const r = rig();
    const { orderId, total } = r.place('card');
    r.op('paymentCreate', { orderId, provider: 'paymob', amount: total });
    const a = r.op('orderStatus', { orderId, status: 'delivered' });
    expect(a.codSettled).toBeNull();
    expect(r.row(`SELECT payment_status FROM orders`).payment_status).toBe('unpaid');
    expect(r.row(`SELECT status FROM payments`).status).toBe('pending');
  });

  it('a keyed replay returns the stored answer and writes no second event', () => {
    const r = rig();
    const { orderId } = r.place();
    const a = r.op('orderStatus', { orderId, status: 'confirmed' }, 'status:abcdefgh');
    const b = r.op('orderStatus', { orderId, status: 'confirmed' }, 'status:abcdefgh');
    expect(b).toEqual(a);
    expect(r.row(`SELECT count(*) n FROM order_events WHERE to_status = 'confirmed'`).n).toBe(1);
  });

  it('a same-status write is a safe no-op for money (Postgres writes the row again)', () => {
    const r = rig();
    const { orderId } = r.place();
    r.op('orderStatus', { orderId, status: 'confirmed' });
    expect(r.code('orderStatus', { orderId, status: 'confirmed' })).toBe('no error');
    expect(r.row(`SELECT status FROM orders`).status).toBe('confirmed');
  });
});
