// WAREHOUSE-ROUTE-3 (W2): an unpaid COD / InstaPay order routed to warehouse B gives its units back to B exactly once when it is
// expired (expireInstapay) or auto-cancelled (the `cancel` money op with unpaidOnly, what order-auto-cancel-unpaid calls).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { placeOrder } from '../src/do/checkout';
import { createPayment, ensurePaymentSchema, expireInstapay } from '../src/do/payments';
import { runMoneyOp } from '../src/do/money-ops';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

function fx() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensurePaymentSchema(db);
  raw.exec(`INSERT INTO store_config (store_id) VALUES ('s1')`);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', 's1', 'Widget', 'widget', 1000, 10, 'active')`
  );
  raw.exec(
    `INSERT INTO warehouses (id, store_id, name, code, priority, is_default) VALUES ('w-A', 's1', 'A', 'A', 1, 1), ('w-B', 's1', 'B', 'B', 5, 0)`
  );
  raw.exec(
    `INSERT INTO warehouse_stock (id, warehouse_id, product_id, quantity, store_id) VALUES ('ws-A', 'w-A', 'p1', 4, 's1'), ('ws-B', 'w-B', 'p1', 6, 's1')`
  );
  const order = () =>
    placeOrder(db, {
      storeId: 's1',
      lines: [{ productId: 'p1', quantity: 2 }],
      shippingAddress: { phone: '01000000001' },
      now: NOW,
    });
  const state = () => {
    const wh = Object.fromEntries(
      (
        raw
          .prepare(
            'SELECT w.code, ws.quantity FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id'
          )
          .all() as Array<{ code: string; quantity: number }>
      ).map(r => [r.code, r.quantity])
    );
    const agg = (
      raw.prepare(`SELECT inventory FROM products WHERE id='p1'`).get() as { inventory: number }
    ).inventory;
    const released = (
      raw
        .prepare(`SELECT count(*) n FROM order_events WHERE to_status='warehouse_released'`)
        .get() as {
        n: number;
      }
    ).n;
    return { wh, agg, released, sum: Object.values(wh).reduce((n, q) => n + q, 0) };
  };
  return { raw, db, order, state };
}

describe('unpaid orders routed to warehouse B restore to B exactly once', () => {
  it('InstaPay hold expiry (expireInstapay), replayed', () => {
    const f = fx();
    const o = f.order();
    f.raw.exec(
      `UPDATE orders SET status = 'awaiting_payment_confirmation', payment_confirmation_expires_at = ${NOW - 1}`
    );
    createPayment(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'instapay',
      amount: o.total,
    });
    expect(f.state().wh).toEqual({ A: 4, B: 4 });
    const args = { storeId: 's1', orderId: o.orderId, proofSubmitted: false, now: NOW };
    expect(expireInstapay(f.db, args)).toBe('expired');
    expect(f.state()).toEqual({ wh: { A: 4, B: 6 }, agg: 10, released: 1, sum: 10 });
    expect(expireInstapay(f.db, args)).toBe('skipped');
    expect(f.state()).toEqual({ wh: { A: 4, B: 6 }, agg: 10, released: 1, sum: 10 });
  });

  it('auto-cancel of an unpaid COD order (cancel money op, unpaidOnly), replayed', () => {
    const f = fx();
    const o = f.order();
    const cancel = () => runMoneyOp(f.db, 's1', 'cancel', { orderId: o.orderId, unpaidOnly: true });
    cancel();
    expect(f.state()).toEqual({ wh: { A: 4, B: 6 }, agg: 10, released: 1, sum: 10 });
    cancel();
    expect(f.state()).toEqual({ wh: { A: 4, B: 6 }, agg: 10, released: 1, sum: 10 });
  });

  it('auto-cancel of an unpaid InstaPay order (cancel money op, unpaidOnly), replayed', () => {
    const f = fx();
    const o = f.order();
    f.raw.exec(`UPDATE orders SET status = 'awaiting_payment_confirmation'`);
    createPayment(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'instapay',
      amount: o.total,
    });
    const cancel = () => runMoneyOp(f.db, 's1', 'cancel', { orderId: o.orderId, unpaidOnly: true });
    cancel();
    cancel();
    expect(f.state()).toEqual({ wh: { A: 4, B: 6 }, agg: 10, released: 1, sum: 10 });
  });
});
