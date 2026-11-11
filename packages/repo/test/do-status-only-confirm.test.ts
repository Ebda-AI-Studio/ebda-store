// #625 / review of #685: a status poll that stated no amount confirms the order at the payment's own amount, but the
// payment is MARKED as confirmed by status only; a later signed webhook that states a SHORT amount raises the P1
// amount_mismatch (the real backstop), and one that states the right amount clears the mark.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { ensurePaymentSchema } from '../src/do/payments';

function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  ensurePaymentSchema(db);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES ('sku', 's1', 'Widget', 'widget', 1000, 20, 'active', 400);`
  );
  const op = (name: string, args: Record<string, unknown>) =>
    runMoneyOp(db, 's1', name, args) as any;
  const one = (sql: string, ...p: unknown[]) => raw.prepare(sql).get(...(p as never[])) as any;
  const o = op('createOrder', {
    lines: [{ productId: 'sku', quantity: 3 }],
    shippingAddress: { phone: '01000000001' },
  });
  const { paymentId } = op('paymentCreate', {
    orderId: o.orderId,
    provider: 'kashier',
    amount: o.total,
    transactionId: 'tx-1',
  });
  const hook = (eventId: string, extra: Record<string, unknown>) =>
    op('paymentWebhook', {
      input: {
        provider: 'kashier',
        eventId,
        providerRef: 'tx-1',
        kind: 'payment',
        status: 'completed',
        amount: o.total,
        currency: 'EGP',
        ...extra,
      },
      confirmed: { kind: 'payment', status: 'SUCCESS' },
    });
  const meta = () => JSON.parse(one('SELECT metadata m FROM payments WHERE id = ?', paymentId).m);
  return { o, paymentId, hook, meta, one };
}

describe('status-only confirmation (#625)', () => {
  it('confirms the order and marks the payment amountUnverified, with a timeline event saying so', () => {
    const r = rig();
    const out = r.hook('status-poll:tx-1:completed', { amountUnverified: true });
    expect(out.outcome).toBe('applied');
    expect(r.one(`SELECT payment_status s FROM orders WHERE id = ?`, r.o.orderId).s).toBe('paid');
    expect(r.meta()).toMatchObject({
      amountUnverified: true,
      amountSource: 'status_poll_expected',
    });
    const ev = r.one(
      `SELECT details FROM payment_events WHERE payment_id = ? AND event_type = 'webhook' ORDER BY rowid DESC`,
      r.paymentId
    );
    expect(JSON.parse(ev.details)).toMatchObject({ reason: 'confirmed_by_status_only' });
  });

  it('a SHORT signed webhook after a status-only confirmation raises the P1 amount_mismatch, naming the status-only confirm', () => {
    const r = rig();
    r.hook('status-poll:tx-1:completed', { amountUnverified: true });
    const out = r.hook('kashier:tx-1:SUCCESS', { amount: r.o.total - 1000 });
    expect(out.outcome).toBe('held');
    expect(out.alerts).toEqual([
      expect.objectContaining({
        kind: 'amount_mismatch',
        context: expect.objectContaining({
          confirmedByStatusOnly: true,
          reason: 'paid_amount_mismatch',
        }),
      }),
    ]);
    expect(out.alerts[0].body).toMatch(/ALREADY confirmed by a status-only check/);
    expect(r.meta()).toMatchObject({ amountMismatch: true });
  });

  it('a signed webhook stating the right amount clears the mark', () => {
    const r = rig();
    r.hook('status-poll:tx-1:completed', { amountUnverified: true });
    r.hook('kashier:tx-1:SUCCESS', {});
    expect(r.meta()).toMatchObject({ amountUnverified: false, amountSource: 'signed_webhook' });
  });
});
