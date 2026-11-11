// StoreDO payments (node:sqlite, real schema): webhooks, confirm-before-apply, the refund claim protocol and the
// reconcile-by-claim rule. The concurrency twins on a real Durable Object are in workers-test.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { placeOrder, type CheckoutInput } from '../src/do/checkout';
import {
  applyPaymentEvent,
  beginRefund,
  completeRefund,
  confirmInstapay,
  createPayment,
  ensurePaymentSchema,
  expireInstapay,
  markRefundIndeterminate,
  matchRefundToClaim,
  recordInstapayRefund,
  releaseRefund,
  type PaymentWebhookInput,
} from '../src/do/payments';
import { MoneyError } from '../src/do/sync-sql';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
function fx() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensurePaymentSchema(db);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('sku', 's1', 'Widget', 'widget', 1000, 20, 'active')`
  );
  raw.exec(
    `INSERT INTO coupons (id, store_id, code, name, type, value, scope_product_ids, scope_category_ids) VALUES ('c', 's1', 'TEN', 'ten', 'fixed', 100, '[]', '[]')`
  );
  let n = 0;
  const order = (qty = 3, over: Partial<CheckoutInput> = {}) =>
    placeOrder(db, {
      storeId: 's1',
      lines: [{ productId: 'sku', quantity: qty }],
      shippingAddress: { phone: `010${String(++n).padStart(8, '0')}` },
      idempotencyKey: `k${n}`,
      now: NOW,
      ...over,
    });
  /** an order with a payment of its full total, marked completed through a real webhook */
  const paid = async (qty = 3, provider = 'paymob', over: Partial<CheckoutInput> = {}) => {
    const o = order(qty, over);
    const { paymentId } = createPayment(db, {
      storeId: 's1',
      orderId: o.orderId,
      provider,
      amount: o.total,
      transactionId: `tx-${n}`,
      now: NOW,
    });
    await applyPaymentEvent(
      db,
      wh({
        providerRef: `tx-${n}`,
        eventId: `pay-${n}`,
        kind: 'payment',
        status: 'completed',
        amount: o.total,
        currency: 'EGP',
        provider,
      }),
      { confirm: async () => ({ kind: 'payment', status: 'SUCCESS' }) } // only Kashier asks for it
    );
    return { ...o, paymentId, ref: `tx-${n}` };
  };
  const one = (q: string, ...p: unknown[]) =>
    raw.prepare(q).get(...(p as never[])) as Record<string, number & string>;
  const rows = (q: string, ...p: unknown[]) =>
    raw.prepare(q).all(...(p as never[])) as Record<string, number & string>[];
  return { raw, db, order, paid, one, rows };
}
const wh = (
  o: Partial<PaymentWebhookInput> & Pick<PaymentWebhookInput, 'providerRef' | 'eventId' | 'kind'>
): PaymentWebhookInput => ({ storeId: 's1', provider: 'paymob', now: NOW, ...o });
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as MoneyError).code ?? (e as Error).message;
  }
  return 'NO_ERROR';
};

describe('payment rows', () => {
  it('the amount must equal the order total; webhook references and the payment are queued for the D1 entity index in the same section', async () => {
    const f = fx();
    const o = f.order();
    expect(
      await code(() =>
        createPayment(f.db, {
          storeId: 's1',
          orderId: o.orderId,
          provider: 'paymob',
          amount: o.total + 1,
        })
      )
    ).toBe('PAYMENT_AMOUNT_MISMATCH');
    expect(f.one('SELECT count(*) n FROM payments').n).toBe(0);
    createPayment(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'T1',
      invoiceId: 'I1',
    });
    const q = f
      .rows("SELECT payload FROM d1_outbox WHERE kind = 'entity_index'")
      .map(r => JSON.parse(r.payload));
    expect(q.map(x => `${x.kind}:${x.id.includes(':') ? x.id : 'pay'}`).sort()).toEqual([
      'order:pay', // queued by the checkout in the same section as the order (audit DB-2)
      'payment:pay',
      'webhook:paymob:I1',
      'webhook:paymob:T1',
    ]);
    expect(
      await code(() =>
        createPayment(f.db, {
          storeId: 's2',
          orderId: o.orderId,
          provider: 'paymob',
          amount: o.total,
        })
      )
    ).toBe('ORDER_NOT_FOUND');
  });
});

describe('payment webhook', () => {
  it('completed: payment completed, order confirmed + paid; replayed 3 times = ONE effect', async () => {
    const f = fx();
    const o = f.order();
    createPayment(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'T1',
    });
    const ev = wh({
      providerRef: 'T1',
      eventId: 'e1',
      kind: 'payment',
      status: 'completed',
      amount: o.total,
      currency: 'EGP',
    });
    const first = await applyPaymentEvent(f.db, ev);
    expect(first).toMatchObject({
      outcome: 'applied',
      paymentStatus: 'completed',
      orderStatus: 'confirmed',
      postCommit: ['order_paid'],
    });
    const again = [await applyPaymentEvent(f.db, ev), await applyPaymentEvent(f.db, ev)];
    expect(again.map(r => r.outcome)).toEqual(['replayed', 'replayed']);
    expect(f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'webhook'`).n).toBe(1);
    expect(f.one(`SELECT count(*) n FROM order_events WHERE to_status = 'confirmed'`).n).toBe(1);
    expect(f.one('SELECT payment_status ps FROM orders').ps).toBe('paid');
  });

  it('an unknown reference or another store is PAYMENT_NOT_FOUND and writes nothing', async () => {
    const f = fx();
    const o = f.order();
    createPayment(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'T1',
    });
    expect(
      await code(() =>
        applyPaymentEvent(
          f.db,
          wh({ providerRef: 'nope', eventId: 'e', kind: 'payment', status: 'completed' })
        )
      )
    ).toBe('PAYMENT_NOT_FOUND');
    expect(
      await code(() =>
        applyPaymentEvent(
          f.db,
          wh({
            storeId: 's2',
            providerRef: 'T1',
            eventId: 'e',
            kind: 'payment',
            status: 'completed',
          })
        )
      )
    ).toBe('PAYMENT_NOT_FOUND');
    expect(f.one('SELECT count(*) n FROM payment_event_log').n).toBe(0);
  });

  it('a short payment never confirms the order (held + alert); within the 5-piastre tolerance it does', async () => {
    const f = fx();
    const o = f.order();
    createPayment(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'T1',
    });
    const r = await applyPaymentEvent(
      f.db,
      wh({
        providerRef: 'T1',
        eventId: 'e1',
        kind: 'payment',
        status: 'completed',
        amount: o.total - 100,
        currency: 'EGP',
      })
    );
    expect(r).toMatchObject({ outcome: 'held', paymentStatus: 'pending', orderStatus: 'pending' });
    expect(r.alerts[0].kind).toBe('amount_mismatch');
    const ok = await applyPaymentEvent(
      f.db,
      wh({
        providerRef: 'T1',
        eventId: 'e2',
        kind: 'payment',
        status: 'completed',
        amount: o.total - 3,
        currency: 'EGP',
      })
    );
    expect(ok).toMatchObject({ outcome: 'applied', orderStatus: 'confirmed' });
  });

  it('a cancelled order rejects the capture BEFORE any write (nothing half-applied, the event stays retryable)', async () => {
    const f = fx();
    const o = f.order();
    createPayment(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'T1',
    });
    f.raw.exec(`UPDATE orders SET status = 'cancelled'`);
    expect(
      await code(() =>
        applyPaymentEvent(
          f.db,
          wh({
            providerRef: 'T1',
            eventId: 'e1',
            kind: 'payment',
            status: 'completed',
            amount: o.total,
            currency: 'EGP',
          })
        )
      )
    ).toBe('NO_ERROR'); // an external money fact is never rejected (Opus I3, Ruling CF-OPUS-3)
    expect(f.one('SELECT status s FROM payments').s).toBe('completed');
    expect(f.one('SELECT status s FROM orders').s).toBe('cancelled');
    expect(f.one('SELECT count(*) n FROM payment_event_log').n).toBe(1);
    expect(f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'webhook'`).n).toBe(1);
  });

  it('a late failed/expired notice never downgrades a captured payment; failed on an unpaid one marks it failed', async () => {
    const f = fx();
    const p = await f.paid();
    const r = await applyPaymentEvent(
      f.db,
      wh({ providerRef: p.ref, eventId: 'late', kind: 'payment', status: 'failed' })
    );
    expect(r).toMatchObject({ outcome: 'ignored', paymentStatus: 'completed' });
    expect(r.alerts[0].kind).toBe('payment_downgrade_ignored');
    const g = fx();
    const o = g.order();
    createPayment(g.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'T1',
    });
    const bad = await applyPaymentEvent(
      g.db,
      wh({ providerRef: 'T1', eventId: 'f1', kind: 'payment', status: 'failed' })
    );
    expect(bad).toMatchObject({ paymentStatus: 'failed', postCommit: ['payment_failed'] });
    expect(g.one('SELECT payment_status ps FROM orders').ps).toBe('failed');
  });

  it('P08: a fulfilled order (processing / shipped) is marked PAID without moving its status; a cancelled one is recorded and flagged, never refused', async () => {
    for (const st of ['processing', 'shipped'] as const) {
      const f = fx();
      const o = f.order();
      createPayment(f.db, {
        storeId: 's1',
        orderId: o.orderId,
        provider: 'paymob',
        amount: o.total,
        transactionId: 'T1',
      });
      f.raw.exec(`UPDATE orders SET status = '${st}'`);
      const r = await applyPaymentEvent(
        f.db,
        wh({
          providerRef: 'T1',
          eventId: 'e1',
          kind: 'payment',
          status: 'completed',
          amount: o.total,
          currency: 'EGP',
        })
      );
      expect(r).toMatchObject({
        outcome: 'applied',
        paymentStatus: 'completed',
        postCommit: ['order_paid'],
      });
      expect(f.one('SELECT status s, payment_status ps FROM orders')).toMatchObject({
        s: st,
        ps: 'paid',
      });
    }
    const g = fx();
    const o = g.order();
    createPayment(g.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'T1',
    });
    g.raw.exec(`UPDATE orders SET status = 'cancelled'`);
    expect(
      await code(() =>
        applyPaymentEvent(
          g.db,
          wh({
            providerRef: 'T1',
            eventId: 'e1',
            kind: 'payment',
            status: 'completed',
            amount: o.total,
            currency: 'EGP',
          })
        )
      )
    ).toBe('NO_ERROR'); // recorded and flagged, not refused (Opus I3)
    expect(g.one('SELECT payment_status ps FROM orders').ps).toBe('paid');
    expect(g.one('SELECT status s FROM orders').s).toBe('cancelled');
  });

  it('P08: a second completed event (a verify after a webhook) does not fan out twice; a completed replay never overwrites a refunded payment', async () => {
    const f = fx();
    const p = await f.paid();
    const second = await applyPaymentEvent(
      f.db,
      wh({
        providerRef: p.ref,
        eventId: 'again',
        kind: 'payment',
        status: 'completed',
        amount: p.total,
        currency: 'EGP',
      })
    );
    expect(second.postCommit).toEqual([]); // the order was already paid
    f.raw.exec(`UPDATE payments SET status = 'refunded'`);
    const replay = await applyPaymentEvent(
      f.db,
      wh({
        providerRef: p.ref,
        eventId: 'again2',
        kind: 'payment',
        status: 'completed',
        amount: p.total,
        currency: 'EGP',
      })
    );
    expect(replay).toMatchObject({ outcome: 'ignored', paymentStatus: 'refunded' });
    expect(f.one('SELECT status s FROM payments').s).toBe('refunded');
  });

  it('P08: a failed notice for a payment row that is not live but whose order is PAID leaves the order paid and pushes nothing', async () => {
    const f = fx();
    const o = f.order();
    createPayment(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'paymob',
      amount: o.total,
      transactionId: 'T1',
    });
    f.raw.exec(`UPDATE orders SET payment_status = 'paid', status = 'confirmed'`); // paid through another payment row
    const r = await applyPaymentEvent(
      f.db,
      wh({ providerRef: 'T1', eventId: 'f1', kind: 'payment', status: 'expired' })
    );
    expect(r.postCommit).toEqual([]);
    expect(f.one('SELECT payment_status ps FROM orders').ps).toBe('paid');
  });

  it('a second captured payment on one order raises a duplicate-capture alert', async () => {
    const f = fx();
    const p = await f.paid();
    createPayment(f.db, {
      storeId: 's1',
      orderId: p.orderId,
      provider: 'paymob',
      amount: p.total,
      transactionId: 'T2',
    });
    const r = await applyPaymentEvent(
      f.db,
      wh({
        providerRef: 'T2',
        eventId: 'dup',
        kind: 'payment',
        status: 'completed',
        amount: p.total,
        currency: 'EGP',
      })
    );
    expect(r.alerts.map(a => a.kind)).toContain('duplicate_capture');
  });
});

describe('confirm-before-apply (PROVIDERS-17)', () => {
  const kashier = (f: ReturnType<typeof fx>) => {
    const o = f.order();
    createPayment(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'kashier',
      amount: o.total,
      transactionId: 'K1',
    });
    return o;
  };
  const ev = (o: { total: number }, over: Partial<PaymentWebhookInput> = {}) =>
    wh({
      provider: 'kashier',
      providerRef: 'K1',
      eventId: 'k-e1',
      kind: 'payment',
      status: 'completed',
      amount: o.total,
      currency: 'EGP',
      ...over,
    });

  it('no confirm dependency, or a gateway that does not answer = nothing applied (503, retryable)', async () => {
    const f = fx();
    const o = kashier(f);
    expect(await code(() => applyPaymentEvent(f.db, ev(o)))).toBe('WEBHOOK_UNCONFIRMED');
    expect(
      await code(() =>
        applyPaymentEvent(f.db, ev(o), {
          confirm: async () => {
            throw new Error('timeout');
          },
        })
      )
    ).toBe('WEBHOOK_UNCONFIRMED');
    expect(f.one('SELECT status s FROM payments').s).toBe('pending');
    expect(f.one('SELECT count(*) n FROM payment_event_log').n).toBe(0);
  });
  it('the gateway record wins: a relabelled delivery (claims paid, gateway says refund/failure) is corrected', async () => {
    const f = fx();
    const o = kashier(f);
    const r = await applyPaymentEvent(f.db, ev(o), {
      confirm: async () => ({ kind: 'payment', status: 'FAILURE' }),
    });
    expect(r.paymentStatus).toBe('failed');
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'webhook_corrected'`).n
    ).toBe(1);
  });
  it('an authorization is not a payment: recorded, no money state', async () => {
    const f = fx();
    const o = kashier(f);
    const r = await applyPaymentEvent(f.db, ev(o), {
      confirm: async () => ({ kind: 'authorize', status: 'SUCCESS' }),
    });
    expect(r.outcome).toBe('ignored');
    expect(f.one('SELECT status s FROM payments').s).toBe('pending');
  });
  it('a confirmed delivery applies and is idempotent by event id', async () => {
    const f = fx();
    const o = kashier(f);
    const confirm = async () => ({ kind: 'payment' as const, status: 'SUCCESS' as const });
    expect((await applyPaymentEvent(f.db, ev(o), { confirm })).orderStatus).toBe('confirmed');
    expect((await applyPaymentEvent(f.db, ev(o), { confirm })).outcome).toBe('replayed');
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'webhook_confirmed'`).n
    ).toBe(1);
  });
});

describe('refund claim protocol', () => {
  it('claim is committed BEFORE the provider call: balance and status move, an event marks it; the cap and the key are enforced', async () => {
    const f = fx();
    const p = await f.paid(3);
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    expect(f.one('SELECT refunded_amount a, status s FROM payments')).toMatchObject({
      a: 1000,
      s: 'partially_refunded',
    });
    expect(c.flipsOrder).toBe(false);
    expect(
      await code(() =>
        beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: p.total, now: NOW })
      )
    ).toBe('REFUND_EXCEEDS_REMAINING');
    expect(
      await code(() => beginRefund(f.db, { storeId: 's2', paymentId: p.paymentId, amount: 10 }))
    ).toBe('PAYMENT_NOT_FOUND');
    beginRefund(f.db, {
      storeId: 's1',
      paymentId: p.paymentId,
      amount: 500,
      refundKey: 'ret-1',
      now: NOW,
    });
    expect(
      await code(() =>
        beginRefund(f.db, {
          storeId: 's1',
          paymentId: p.paymentId,
          amount: 500,
          refundKey: 'ret-1',
          now: NOW,
        })
      )
    ).toBe('REFUND_ALREADY_ISSUED');
    const full = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, now: NOW });
    expect(full).toMatchObject({ amount: p.total - 1500, isFullRefund: true, flipsOrder: true });
    expect(
      await code(() => beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1 }))
    ).toBe('INVALID_STATE');
  });

  it('release gives the amount back and restores the status; a refused retry with the same key is then allowed; indeterminate keeps the claim', async () => {
    const f = fx();
    const p = await f.paid(3);
    const c = beginRefund(f.db, {
      storeId: 's1',
      paymentId: p.paymentId,
      amount: 700,
      refundKey: 'k',
      now: NOW,
    });
    expect(
      releaseRefund(f.db, { storeId: 's1', claimId: c.claimId, reason: 'provider_rejected' })
    ).toEqual({ released: true, review: false });
    expect(f.one('SELECT refunded_amount a, status s FROM payments')).toMatchObject({
      a: 0,
      s: 'completed',
    });
    expect(
      releaseRefund(f.db, { storeId: 's1', claimId: c.claimId, reason: 'again' }).released
    ).toBe(false);
    const c2 = beginRefund(f.db, {
      storeId: 's1',
      paymentId: p.paymentId,
      amount: 700,
      refundKey: 'k',
      now: NOW,
    });
    markRefundIndeterminate(f.db, { storeId: 's1', claimId: c2.claimId, error: 'timeout' });
    expect(
      await code(() =>
        beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 700, refundKey: 'k' })
      )
    ).toBe('REFUND_ALREADY_ISSUED');
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(700);
  });

  it('complete records the provider id + executed event together, books a non-return partial once, flips the order for a full refund; replay is a no-op', async () => {
    const f = fx();
    const p = await f.paid(3);
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    expect(
      completeRefund(f.db, { storeId: 's1', claimId: c.claimId, refundId: 'R1', now: NOW })
    ).toMatchObject({ booked: true });
    expect(
      completeRefund(f.db, { storeId: 's1', claimId: c.claimId, refundId: 'R1', now: NOW }).booked
    ).toBe(false);
    expect(f.one('SELECT refund_id r FROM payments').r).toBe('R1');
    expect(
      f.one(`SELECT count(*) n FROM order_events WHERE to_status = 'partial_refund_recorded'`).n
    ).toBe(1);
    const full = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: full.claimId, refundId: 'R2', now: NOW });
    expect(f.one('SELECT status s, payment_status ps FROM orders')).toMatchObject({
      s: 'refunded',
      ps: 'refunded',
    });
  });
});

describe('refund webhook reconciled with the in-band claim', () => {
  const refundEv = (
    ref: string,
    id: string,
    amount: number | null,
    over: Partial<PaymentWebhookInput> = {}
  ) =>
    wh({
      providerRef: ref,
      eventId: `rw-${id}`,
      kind: 'refund',
      refund: { refundId: id, status: 'completed', amount },
      ...over,
    });

  it('the settle webhook outruns the id write: absorbed by the claim (total unchanged), the claim is CONSUMED, the later complete is a clean no-add', async () => {
    const f = fx();
    const p = await f.paid(5);
    // a first accounted refund so the payment has a ledger (provenance known)
    const c0 = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c0.claimId, refundId: 'R0', now: NOW });
    const c1 = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    const r = await applyPaymentEvent(f.db, refundEv(p.ref, 'R1', 1000, { now: NOW + 1000 }));
    expect(r.outcome).toBe('applied');
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(2000);
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_webhook_absorbed'`).n
    ).toBe(1);
    completeRefund(f.db, { storeId: 's1', claimId: c1.claimId, refundId: 'R1', now: NOW + 2000 });
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(2000);
    // a replay of the same webhook (x2): nothing more
    for (let i = 0; i < 2; i++)
      expect(
        (await applyPaymentEvent(f.db, refundEv(p.ref, 'R1', 1000, { now: NOW + 3000 }))).outcome
      ).toBe('replayed');
  });

  it('two concurrent same-amount refunds are BOTH booked: each webhook consumes its own claim', async () => {
    const f = fx();
    const p = await f.paid(6);
    const c0 = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 500, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c0.claimId, refundId: 'R0', now: NOW });
    const a = beginRefund(f.db, {
      storeId: 's1',
      paymentId: p.paymentId,
      amount: 1000,
      refundKey: 'ra',
      now: NOW + 10,
    });
    const b = beginRefund(f.db, {
      storeId: 's1',
      paymentId: p.paymentId,
      amount: 1000,
      refundKey: 'rb',
      now: NOW + 20,
    });
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(2500);
    await applyPaymentEvent(f.db, refundEv(p.ref, 'RA', 1000, { now: NOW + 100 }));
    await applyPaymentEvent(f.db, refundEv(p.ref, 'RB', 1000, { now: NOW + 200 }));
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(2500);
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_webhook_absorbed'`).n
    ).toBe(2);
    completeRefund(f.db, { storeId: 's1', claimId: a.claimId, refundId: 'RA', now: NOW + 300 });
    completeRefund(f.db, { storeId: 's1', claimId: b.claimId, refundId: 'RB', now: NOW + 310 });
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(2500);
  });

  it('a GENUINE second refund of the same amount (dashboard) is not swallowed by an already-consumed claim: it is added', async () => {
    const f = fx();
    const p = await f.paid(6);
    const c0 = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 500, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c0.claimId, refundId: 'R0', now: NOW });
    beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW + 10 });
    await applyPaymentEvent(f.db, refundEv(p.ref, 'R1', 1000, { now: NOW + 100 })); // absorbed
    await applyPaymentEvent(f.db, refundEv(p.ref, 'R9', 1000, { now: NOW + 200 })); // dashboard refund, same amount
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(2500);
  });

  it('a stale claim (older than the window) cannot absorb: the webhook is a new refund and adds', async () => {
    const f = fx();
    const p = await f.paid(6);
    const c0 = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 500, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c0.claimId, refundId: 'R0', now: NOW });
    beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    await applyPaymentEvent(f.db, refundEv(p.ref, 'R1', 1000, { now: NOW + 10 * 60_000 }));
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(2500);
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_webhook_absorbed'`).n
    ).toBe(0);
  });

  it('a claim released AFTER a webhook absorbed it is not decremented: it is marked for review', async () => {
    const f = fx();
    const p = await f.paid(6);
    const c0 = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 500, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c0.claimId, refundId: 'R0', now: NOW });
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    await applyPaymentEvent(f.db, refundEv(p.ref, 'R1', 1000, { now: NOW + 100 }));
    expect(
      releaseRefund(f.db, { storeId: 's1', claimId: c.claimId, reason: 'provider_rejected' })
    ).toEqual({ released: false, review: true });
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(1500);
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_reconcile_review'`).n
    ).toBe(1);
  });

  it('a dashboard refund with no claim applies exactly once: full refund reverses stock + coupon + wallet once; partial books once', async () => {
    const f = fx();
    const p = await f.paid(3, 'paymob', { couponCode: 'TEN' });
    expect(f.one(`SELECT inventory i FROM products WHERE id='sku'`).i).toBe(17);
    const half = await applyPaymentEvent(f.db, refundEv(p.ref, 'RP', 1000));
    expect(half.paymentStatus).toBe('partially_refunded');
    expect(
      f.one(`SELECT count(*) n FROM order_events WHERE to_status = 'partial_refund_recorded'`).n
    ).toBe(1);
    expect((await applyPaymentEvent(f.db, refundEv(p.ref, 'RP', 1000))).outcome).toBe('replayed');
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(1000);
    const rest = p.total - 1000;
    const full = await applyPaymentEvent(f.db, refundEv(p.ref, 'RF', rest));
    expect(full).toMatchObject({
      paymentStatus: 'refunded',
      orderStatus: 'refunded',
      postCommit: ['order_reversed'],
    });
    expect(f.one(`SELECT inventory i FROM products WHERE id='sku'`).i).toBe(20);
    expect(f.one(`SELECT usage_count u FROM coupons WHERE id='c'`).u).toBe(0);
    // 3 deliveries of the same full-refund event (distinct delivery ids, same refund id+status): no second reversal
    await applyPaymentEvent(
      f.db,
      wh({
        providerRef: p.ref,
        eventId: 'rw-again',
        kind: 'refund',
        refund: { refundId: 'RF', status: 'completed', amount: rest },
      })
    );
    expect(f.one(`SELECT inventory i FROM products WHERE id='sku'`).i).toBe(20);
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(p.total);
  });

  it('the cumulative cap: webhook refunds can never push the total past the payment', async () => {
    const f = fx();
    const p = await f.paid(3);
    await applyPaymentEvent(f.db, refundEv(p.ref, 'A', 2000));
    await applyPaymentEvent(f.db, refundEv(p.ref, 'B', p.total)); // gateway echoes the invoice amount: not a settling refund once something is accounted
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBeLessThanOrEqual(p.total);
  });

  it('Fawry: an amount-less settle notice for OUR in-band refund is correlated (no alert); one with no refund of ours alerts', async () => {
    const f = fx();
    const p = await f.paid(5, 'fawry');
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    completeRefund(f.db, {
      storeId: 's1',
      claimId: c.claimId,
      refundId: 'fawry-refund-F1-1000',
      now: NOW,
    });
    const notice = (id: string, now: number) =>
      wh({
        provider: 'fawry',
        providerRef: p.ref,
        eventId: `f-${id}`,
        kind: 'refund',
        refund: { refundId: `fawry-refund-F1-${id}`, status: 'completed', amount: 0 },
        now,
      });
    const near = await applyPaymentEvent(f.db, notice('PARTIAL_REFUNDED', NOW + 60_000));
    expect(near.alerts).toEqual([]);
    const far = await applyPaymentEvent(f.db, notice('REFUNDED2', NOW + 7 * 3600_000));
    expect(far.alerts.map(a => a.kind)).toContain('held_unaccounted');
  });
});

describe('settlement rules (mirror of the Postgres settleRefund)', () => {
  const refundEv = (
    ref: string,
    id: string,
    amount: number | null,
    over: Partial<PaymentWebhookInput> = {}
  ) =>
    wh({
      providerRef: ref,
      eventId: `rw-${id}-${over.refund?.status ?? 'completed'}`,
      kind: 'refund',
      refund: { refundId: id, status: 'completed', amount },
      ...over,
    });
  const ledger = async (f: ReturnType<typeof fx>, provider = 'paymob', qty = 6) => {
    const p = await f.paid(qty, provider);
    const c0 = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 500, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c0.claimId, refundId: 'R0', now: NOW });
    return p;
  };

  it('absorb vs release in BOTH orders: absorb-first -> release is a review (balance stays); release-first -> the webhook is a real refund and adds', async () => {
    const a = fx();
    const p = await ledger(a);
    const c = beginRefund(a.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    await applyPaymentEvent(a.db, refundEv(p.ref, 'R1', 1000, { now: NOW + 100 }));
    expect(releaseRefund(a.db, { storeId: 's1', claimId: c.claimId, reason: 'x' })).toEqual({
      released: false,
      review: true,
    });
    expect(a.one('SELECT refunded_amount a FROM payments').a).toBe(1500);
    const b = fx();
    const q = await ledger(b);
    const d = beginRefund(b.db, { storeId: 's1', paymentId: q.paymentId, amount: 1000, now: NOW });
    expect(releaseRefund(b.db, { storeId: 's1', claimId: d.claimId, reason: 'x' }).released).toBe(
      true
    );
    await applyPaymentEvent(b.db, refundEv(q.ref, 'R1', 1000, { now: NOW + 100 }));
    expect(b.one('SELECT refunded_amount a FROM payments').a).toBe(1500);
    expect(
      b.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_webhook_absorbed'`).n
    ).toBe(0);
  });

  it('a pending refund notice never consumes a claim; the completed one does', async () => {
    const f = fx();
    const p = await ledger(f);
    beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    await applyPaymentEvent(
      f.db,
      refundEv(p.ref, 'R1', 1000, {
        now: NOW + 100,
        refund: { refundId: 'R1', status: 'pending', amount: 1000 },
      })
    );
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_webhook_absorbed'`).n
    ).toBe(0);
    await applyPaymentEvent(f.db, refundEv(p.ref, 'R1', 1000, { now: NOW + 200 }));
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_webhook_absorbed'`).n
    ).toBe(1);
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(1500);
  });

  it('the database refuses a second absorb/release outcome for one claim (unique index)', async () => {
    const f = fx();
    const p = await ledger(f);
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    await applyPaymentEvent(f.db, refundEv(p.ref, 'R1', 1000, { now: NOW + 100 }));
    expect(() =>
      f.raw
        .prepare(
          `INSERT INTO payment_events (id, payment_id, store_id, order_id, event_type, details) VALUES ('x', ?, 's1', ?, 'refund_failed', ?)`
        )
        .run(p.paymentId, p.orderId, JSON.stringify({ claimId: c.claimId }))
    ).toThrow(/UNIQUE/);
  });

  it('Kashier: an unknown id while our own executed refund is open is HELD (alert, nothing booked); the operator match settles it; replay-safe', async () => {
    const f = fx();
    const p = await f.paid(6, 'kashier');
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c.claimId, refundId: 'API-ID', now: NOW });
    const r = await applyPaymentEvent(
      f.db,
      refundEv(p.ref, 'WEBHOOK-ID', 1000, { provider: 'kashier', now: NOW + 60_000 }),
      {
        confirm: async () => ({ kind: 'refund', status: 'SUCCESS' }),
      }
    );
    expect(r.alerts.map(a => a.kind)).toEqual(['held_open_claim_id_unverified']);
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(1000);
    expect(
      matchRefundToClaim(f.db, {
        storeId: 's1',
        claimId: c.claimId,
        providerRefundId: 'WEBHOOK-ID',
        actorUserId: 'op',
        now: NOW + 70_000,
      })
    ).toBe('matched');
    expect(
      matchRefundToClaim(f.db, {
        storeId: 's1',
        claimId: c.claimId,
        providerRefundId: 'WEBHOOK-ID',
        actorUserId: 'op',
      })
    ).toBe('already_matched');
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(1000);
    // a later delivery with that id is now known: no hold, no add
    const again = await applyPaymentEvent(
      f.db,
      {
        ...refundEv(p.ref, 'WEBHOOK-ID', 1000, { provider: 'kashier', now: NOW + 80_000 }),
        eventId: 'rw-again',
      },
      { confirm: async () => ({ kind: 'refund', status: 'SUCCESS' }) }
    );
    expect(again.alerts).toEqual([]);
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(1000);
  });

  it('Kashier: AGE never closes the hold - an unknown id 2 days later with an unconsumed executed claim is held + P1, not booked', async () => {
    const f = fx();
    const p = await f.paid(6, 'kashier');
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c.claimId, refundId: 'API-ID', now: NOW });
    const confirm = async () => ({ kind: 'refund' as const, status: 'SUCCESS' as const });
    const late = await applyPaymentEvent(
      f.db,
      refundEv(p.ref, 'LATE-ID', 1000, { provider: 'kashier', now: NOW + 2 * 86_400_000 }),
      { confirm }
    );
    expect(late.alerts.map(a => a.kind)).toEqual(['held_open_claim_id_unverified']);
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(1000);
  });

  it("Kashier: the refund's OWN webhook (the API id) closes the claim; afterwards an unknown id is a genuine refund and is booked", async () => {
    const f = fx();
    const p = await f.paid(6, 'kashier');
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c.claimId, refundId: 'API-ID', now: NOW });
    const confirm = async () => ({ kind: 'refund' as const, status: 'SUCCESS' as const });
    await applyPaymentEvent(
      f.db,
      refundEv(p.ref, 'API-ID', 1000, { provider: 'kashier', now: NOW + 5000 }),
      { confirm }
    );
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_webhook_absorbed'`).n
    ).toBe(1);
    const later = await applyPaymentEvent(
      f.db,
      {
        ...refundEv(p.ref, 'DASH', 700, { provider: 'kashier', now: NOW + 2 * 86_400_000 }),
        eventId: 'rw-dash',
      },
      { confirm }
    );
    expect(later.alerts).toEqual([]);
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(1700);
  });

  it('Kashier with NO open own claim: an unknown id is a genuine dashboard refund and is booked', async () => {
    const f = fx();
    const p = await f.paid(6, 'kashier');
    await applyPaymentEvent(f.db, refundEv(p.ref, 'DASH', 700, { provider: 'kashier' }), {
      confirm: async () => ({ kind: 'refund', status: 'SUCCESS' }),
    });
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(700);
  });

  it('operator match refuses an unexecuted or closed claim', async () => {
    const f = fx();
    const p = await f.paid(6, 'kashier');
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    expect(
      await code(() =>
        matchRefundToClaim(f.db, {
          storeId: 's1',
          claimId: c.claimId,
          providerRefundId: 'X',
          actorUserId: 'op',
        })
      )
    ).toBe('CLAIM_NOT_EXECUTED');
    expect(
      await code(() =>
        matchRefundToClaim(f.db, {
          storeId: 's1',
          claimId: 'nope',
          providerRefundId: 'X',
          actorUserId: 'op',
        })
      )
    ).toBe('CLAIM_NOT_FOUND');
  });

  it('Fawry: a missing / unparseable reference is held + alerted; a matching executed claim is consumed ONCE', async () => {
    const f = fx();
    const p = await ledger(f, 'fawry');
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    completeRefund(f.db, {
      storeId: 's1',
      claimId: c.claimId,
      refundId: 'fawry-refund-F9-1500',
      now: NOW,
    });
    const n = (id: string, eventId: string) =>
      wh({
        provider: 'fawry',
        providerRef: p.ref,
        eventId,
        kind: 'refund',
        refund: { refundId: id, status: 'completed', amount: 0 },
        now: NOW + 60_000,
      });
    const bad = await applyPaymentEvent(f.db, n('garbage', 'f-bad'));
    expect(bad.alerts.map(a => a.kind)).toContain('held_unaccounted');
    const good = await applyPaymentEvent(f.db, n('fawry-refund-F9-PARTIAL_REFUNDED', 'f-good'));
    expect(good.alerts).toEqual([]);
    // a second, different notice id cannot ride the same (now consumed) claim
    const second = await applyPaymentEvent(f.db, n('fawry-refund-F9-PARTIAL_REFUNDED#2', 'f-2'));
    expect(second.alerts.map(a => a.kind)).toContain('held_unaccounted');
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_webhook_absorbed'`).n
    ).toBe(1);
  });
});

describe('opus review fixes (DO)', () => {
  const refundEv = (
    ref: string,
    id: string,
    amount: number | null,
    over: Partial<PaymentWebhookInput> = {}
  ) =>
    wh({
      providerRef: ref,
      eventId: `rw-${id}`,
      kind: 'refund',
      refund: { refundId: id, status: 'completed', amount },
      ...over,
    });

  it('confirm-before-apply: a Kashier refund the GATEWAY records as FAILURE or PENDING is applied as such, never as completed', async () => {
    for (const [gw, expected] of [
      ['FAILURE', 'failed'],
      ['PENDING', 'pending'],
    ] as const) {
      const f = fx();
      const p = await f.paid(6, 'kashier');
      await applyPaymentEvent(f.db, refundEv(p.ref, 'RF', 1000, { provider: 'kashier' }), {
        confirm: async () => ({ kind: 'refund', status: gw }),
      });
      expect(f.one('SELECT refunded_amount a FROM payments').a, gw).toBe(0);
      expect(
        f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'webhook_corrected'`).n,
        gw
      ).toBe(1);
      expect(
        JSON.parse((f.one('SELECT metadata m FROM payments').m as unknown as string) ?? '{}')
          .refundStatusById?.RF ?? expected
      ).toBe(expected);
    }
  });
  it('a delivery relabelled payment<->refund applies NOTHING and alerts', async () => {
    const f = fx();
    const p = await f.paid(6, 'kashier');
    const r = await applyPaymentEvent(f.db, refundEv(p.ref, 'RF', 1000, { provider: 'kashier' }), {
      confirm: async () => ({ kind: 'payment', status: 'SUCCESS' }),
    });
    expect(r.outcome).toBe('held');
    expect(r.alerts.map(a => a.kind)).toEqual(['webhook_kind_mismatch']);
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(0);
  });
  it('a claim absorbed under one provider id that the provider then answers with a DIFFERENT id is marked for review (not silently merged)', async () => {
    const f = fx();
    const p = await f.paid(6);
    const c0 = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 500, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c0.claimId, refundId: 'R0', now: NOW });
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    await applyPaymentEvent(f.db, refundEv(p.ref, 'X', 1000, { now: NOW + 10 })); // absorbed as X
    const done = completeRefund(f.db, {
      storeId: 's1',
      claimId: c.claimId,
      refundId: 'Y',
      now: NOW + 20,
    });
    expect(done.review).toBe(true);
    expect(
      f.one(`SELECT count(*) n FROM payment_events WHERE event_type = 'refund_reconcile_review'`).n
    ).toBe(1);
  });
  it('an absorbed id is FILED as accounted (a replay stays seen even if the status map entry is lost)', async () => {
    const f = fx();
    const p = await f.paid(6);
    const c0 = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 500, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c0.claimId, refundId: 'R0', now: NOW });
    beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    await applyPaymentEvent(f.db, refundEv(p.ref, 'R1', 1000, { now: NOW + 10 }));
    expect(
      JSON.parse(f.one('SELECT metadata m FROM payments').m as unknown as string).refundEventIds
    ).toContain('R1');
  });
  it('the operator match refuses an id no held webhook delivered, and an id already accounted', async () => {
    const f = fx();
    const p = await f.paid(6, 'kashier');
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c.claimId, refundId: 'API-ID', now: NOW });
    expect(
      await code(() =>
        matchRefundToClaim(f.db, {
          storeId: 's1',
          claimId: c.claimId,
          providerRefundId: 'TYPO',
          actorUserId: 'op',
        })
      )
    ).toBe('NO_HELD_WEBHOOK');
    expect(
      await code(() =>
        matchRefundToClaim(f.db, {
          storeId: 's1',
          claimId: c.claimId,
          providerRefundId: 'API-ID',
          actorUserId: 'op',
        })
      )
    ).toBe('REFUND_ID_ACCOUNTED');
  });
});

describe('final review fixes (DO)', () => {
  const refundEv = (
    ref: string,
    id: string,
    amount: number | null,
    over: Partial<PaymentWebhookInput> = {}
  ) =>
    wh({
      providerRef: ref,
      eventId: `rw-${id}-${over.now ?? 0}`,
      kind: 'refund',
      refund: { refundId: id, status: 'completed', amount },
      ...over,
    });

  it('operator match refuses a held webhook whose amount differs from the claim', async () => {
    const f = fx();
    const p = await f.paid(6, 'kashier');
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 2000, now: NOW });
    completeRefund(f.db, { storeId: 's1', claimId: c.claimId, refundId: 'API-ID', now: NOW });
    await applyPaymentEvent(
      f.db,
      refundEv(p.ref, 'WH-500', 500, { provider: 'kashier', now: NOW + 5000 }),
      { confirm: async () => ({ kind: 'refund', status: 'SUCCESS' }) }
    );
    expect(
      await code(() =>
        matchRefundToClaim(f.db, {
          storeId: 's1',
          claimId: c.claimId,
          providerRefundId: 'WH-500',
          actorUserId: 'op',
        })
      )
    ).toBe('AMOUNT_MISMATCH');
  });

  it('a claim whose answered id was ALREADY filed under another claim is closed (id_match_reassigned), not left open forever', async () => {
    const f = fx();
    const p = await f.paid(8, 'kashier');
    const seed = beginRefund(f.db, {
      storeId: 's1',
      paymentId: p.paymentId,
      amount: 500,
      now: NOW,
    });
    completeRefund(f.db, { storeId: 's1', claimId: seed.claimId, refundId: 'SEED', now: NOW });
    const a = beginRefund(f.db, {
      storeId: 's1',
      paymentId: p.paymentId,
      amount: 1000,
      now: NOW + 1,
    });
    const b = beginRefund(f.db, {
      storeId: 's1',
      paymentId: p.paymentId,
      amount: 1000,
      now: NOW + 2,
    });
    // the seed refund's own webhook (same id as its API answer) closes the seed claim
    await applyPaymentEvent(
      f.db,
      {
        ...refundEv(p.ref, 'SEED', 500, { provider: 'kashier', now: NOW + 50 }),
        eventId: 'rw-seed',
      },
      { confirm: async () => ({ kind: 'refund', status: 'SUCCESS' }) }
    );
    // B's webhook arrives first (id YB) and absorbs the OLDER claim A
    await applyPaymentEvent(
      f.db,
      refundEv(p.ref, 'YB', 1000, { provider: 'kashier', now: NOW + 100 }),
      { confirm: async () => ({ kind: 'refund', status: 'SUCCESS' }) }
    );
    completeRefund(f.db, { storeId: 's1', claimId: a.claimId, refundId: 'YA', now: NOW + 200 }); // A's answer: review (absorbed as YB)
    const doneB = completeRefund(f.db, {
      storeId: 's1',
      claimId: b.claimId,
      refundId: 'YB',
      now: NOW + 300,
    }); // B answers with the id already filed
    expect(doneB.review).toBe(false);
    expect(
      f.one(
        `SELECT count(*) n FROM payment_events WHERE event_type = 'refund_webhook_absorbed' AND json_extract(details, '$.via') = 'id_match_reassigned'`
      ).n
    ).toBe(1);
    // no claim is left open: a later genuine dashboard refund with an unknown id is booked, not held
    const later = await applyPaymentEvent(
      f.db,
      refundEv(p.ref, 'DASH', 700, { provider: 'kashier', now: NOW + 5 * 86_400_000 }),
      { confirm: async () => ({ kind: 'refund', status: 'SUCCESS' }) }
    );
    expect(later.alerts).toEqual([]);
  });

  it('Fawry: a repeated amount-less partial notice is never silently seen: the 2nd is held + alerted', async () => {
    const f = fx();
    const p = await f.paid(6, 'fawry');
    const seed = beginRefund(f.db, {
      storeId: 's1',
      paymentId: p.paymentId,
      amount: 500,
      now: NOW,
    });
    completeRefund(f.db, {
      storeId: 's1',
      claimId: seed.claimId,
      refundId: 'fawry-refund-F9-1500',
      now: NOW,
    });
    const n = (eventId: string) =>
      wh({
        provider: 'fawry',
        providerRef: p.ref,
        eventId,
        kind: 'refund',
        refund: { refundId: 'fawry-refund-F9-PARTIAL_REFUNDED', status: 'completed', amount: 0 },
        now: NOW + 60_000,
      });
    expect((await applyPaymentEvent(f.db, n('f1'))).alerts).toEqual([]);
    expect((await applyPaymentEvent(f.db, n('f2'))).alerts.map(a => a.kind)).toContain(
      'held_unaccounted'
    );
  });
});

describe('InstaPay', () => {
  const awaiting = (f: ReturnType<typeof fx>, expiresAt: number) => {
    const o = f.order();
    f.raw.exec(
      `UPDATE orders SET status = 'awaiting_payment_confirmation', payment_confirmation_expires_at = ${expiresAt}`
    );
    createPayment(f.db, {
      storeId: 's1',
      orderId: o.orderId,
      provider: 'instapay',
      amount: o.total,
    });
    return o;
  };
  it('confirm: exactly once (second tap is a no-op), refuses after the window unless proof was sent', async () => {
    const f = fx();
    const o = awaiting(f, NOW + 3600_000);
    expect(
      confirmInstapay(f.db, {
        storeId: 's1',
        orderId: o.orderId,
        actorUserId: 'm',
        proofSubmitted: false,
        now: NOW,
      })
    ).toMatchObject({ changed: true, status: 'confirmed' });
    expect(
      confirmInstapay(f.db, {
        storeId: 's1',
        orderId: o.orderId,
        actorUserId: 'm',
        proofSubmitted: false,
        now: NOW,
      })
    ).toMatchObject({ changed: false });
    expect(f.one(`SELECT count(*) n FROM order_events WHERE to_status = 'confirmed'`).n).toBe(1);
    const g = fx();
    const o2 = awaiting(g, NOW - 1);
    expect(
      await code(() =>
        confirmInstapay(g.db, {
          storeId: 's1',
          orderId: o2.orderId,
          actorUserId: 'm',
          proofSubmitted: false,
          now: NOW,
        })
      )
    ).toBe('INSTAPAY_CONFIRMATION_EXPIRED');
    expect(
      confirmInstapay(g.db, {
        storeId: 's1',
        orderId: o2.orderId,
        actorUserId: 'm',
        proofSubmitted: true,
        now: NOW,
      }).changed
    ).toBe(true);
  });
  it('expiry cancels + restocks once, skips an order with proof or an unexpired one, and loses to a confirm that ran first', async () => {
    const f = fx();
    const o = awaiting(f, NOW - 1);
    expect(
      expireInstapay(f.db, { storeId: 's1', orderId: o.orderId, proofSubmitted: true, now: NOW })
    ).toBe('skipped');
    expect(
      expireInstapay(f.db, { storeId: 's1', orderId: o.orderId, proofSubmitted: false, now: NOW })
    ).toBe('expired');
    expect(f.one(`SELECT inventory i FROM products WHERE id='sku'`).i).toBe(20);
    expect(f.one('SELECT status s FROM payments').s).toBe('expired');
    expect(
      expireInstapay(f.db, { storeId: 's1', orderId: o.orderId, proofSubmitted: false, now: NOW })
    ).toBe('skipped');
    const g = fx();
    const o2 = awaiting(g, NOW - 1);
    confirmInstapay(g.db, {
      storeId: 's1',
      orderId: o2.orderId,
      actorUserId: 'm',
      proofSubmitted: true,
      now: NOW,
    });
    expect(
      expireInstapay(g.db, { storeId: 's1', orderId: o2.orderId, proofSubmitted: false, now: NOW })
    ).toBe('skipped');
  });
});

describe('recordInstapayRefund (merchant-recorded InstaPay refund, Ruling NZ-MONEY-6)', () => {
  const instapayPaid = async () => {
    const f = fx();
    const p = await f.paid(3, 'paymob');
    f.raw.prepare("UPDATE payments SET provider = 'instapay' WHERE id = ?").run(p.paymentId);
    const amount = f.one('SELECT amount a FROM payments').a as number;
    return { f, p, amount };
  };
  const rec = (
    f: ReturnType<typeof fx>,
    orderId: string,
    referenceKey: string,
    amountMinor: number
  ) =>
    recordInstapayRefund(f.db, {
      storeId: 's1',
      orderId,
      referenceKey,
      amountMinor,
      record: { reference: referenceKey },
      actorUserId: 'm1',
      now: NOW,
    });

  it('partial, replay, over-remaining, full: one section each; a replay never refunds twice', async () => {
    const { f, p, amount } = await instapayPaid();
    expect(rec(f, p.orderId, 'R-1', 100)).toMatchObject({
      duplicate: false,
      full: false,
      status: 'partially_refunded',
    });
    expect(rec(f, p.orderId, 'R-1', 100)).toMatchObject({ duplicate: true, refundedAmount: 100 });
    expect(f.one('SELECT refunded_amount a FROM payments').a).toBe(100);
    expect(() => rec(f, p.orderId, 'R-2', amount)).toThrow(/between 1 and/);
    const full = rec(f, p.orderId, 'R-3', amount - 100);
    expect(full).toMatchObject({
      duplicate: false,
      full: true,
      status: 'refunded',
      refundedAmount: amount,
    });
    expect(f.one('SELECT payment_status s FROM orders WHERE id = ?', p.orderId).s).toBe('refunded');
    expect(() => rec(f, p.orderId, 'R-4', 1)).toThrow(/fully refunded/);
    expect(
      f.one(
        "SELECT count(*) n FROM payment_events WHERE event_type = 'refund' AND payment_id = ?",
        p.paymentId
      ).n
    ).toBe(2);
    // a replay of the full refund says `full` so the caller can finish the order status flip (forward completion)
    expect(rec(f, p.orderId, 'R-3', amount - 100)).toMatchObject({ duplicate: true, full: true });
  });

  it('refuses an order with no confirmed InstaPay payment, an unknown order, a bad amount', async () => {
    const f = fx();
    const p = await f.paid(3, 'paymob');
    expect(() => rec(f, p.orderId, 'R-1', 100)).toThrow(/no confirmed InstaPay payment/);
    expect(() => rec(f, 'nope', 'R-1', 100)).toThrow(/order not found/);
    expect(() => rec(f, p.orderId, 'R-1', 0)).toThrow(MoneyError);
  });

  it('matchRefundToClaim refuses a claim of another order when the route names its order', async () => {
    const f = fx();
    const p = await f.paid(6, 'kashier');
    const c = beginRefund(f.db, { storeId: 's1', paymentId: p.paymentId, amount: 1000, now: NOW });
    expect(() =>
      matchRefundToClaim(f.db, {
        storeId: 's1',
        claimId: c.claimId,
        providerRefundId: 'X',
        actorUserId: 'op',
        orderId: 'another-order',
      })
    ).toThrow(/no such refund claim on this order/);
  });
});
