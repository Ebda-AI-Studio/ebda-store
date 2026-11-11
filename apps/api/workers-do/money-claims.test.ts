import { beforeAll, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import { INSTAPAY_DEFAULT_EXPIRY_HOURS } from '@ebda/shared';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { ensurePlatformIndex } from './platform-index';

// Money-verify (audit rows M-049, S3-O8, S3-O1, FIX-006) on real workerd: the order payment "claim" (a webhook settling an order
// exactly once, whatever its state), the COD mark-paid guard, and the InstaPay hold expiry. The StoreDO is single threaded, so
// each rule below is one section; every test drives the real moneyOp entry (no mock of the thing under test).
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
beforeAll(ensurePlatformIndex);
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Stub = ReturnType<typeof stubFor>;
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (stub: Stub, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const val = (a: Answer) => {
  if (!a.ok) throw new Error(`refused ${a.code}`);
  return decodeRpc<any>(a.json);
};
const sql = <T>(stub: Stub, q: string, ...p: unknown[]) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(q, ...p).toArray() as T[]);
const num = async (stub: Stub, q: string) => (await sql<{ n: number }>(stub, q))[0]!.n;
const codes = (a: Answer[]) =>
  a.reduce<Record<string, number>>((m, x) => {
    const k = x.ok ? 'ok' : x.code;
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

/** A store with a 1000-priced widget (stock 20) and one order of 3 (total 3000), bound to this store id. */
async function seed(store: string) {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store
  await runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(
      `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner')`,
      store,
      store
    );
    s.storage.sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', ?, 'Widget', 'widget', 1000, 20, 'active')`,
      store
    );
  });
  const o = val(
    await op(stub, store, 'createOrder', {
      lines: [{ productId: 'p1', quantity: 3 }],
      shippingAddress: { phone: '01000000001' },
    })
  );
  return { stub, orderId: o.orderId as string, total: o.total as number };
}
const ref = (store: string) => `tx-${store}`;
async function withPaymobPayment(store: string) {
  const s = await seed(store);
  const p = val(
    await op(s.stub, store, 'paymentCreate', {
      orderId: s.orderId,
      provider: 'paymob',
      amount: s.total,
      transactionId: ref(store),
    })
  );
  return { ...s, paymentId: p.paymentId as string };
}
const hook = (store: string, eventId: string, status = 'completed') => ({
  input: {
    provider: 'paymob',
    eventId,
    providerRef: ref(store),
    kind: 'payment',
    status,
    amount: 3000,
    currency: 'EGP',
  },
});
const fanouts = (answers: Answer[], what: string) =>
  answers.filter(a => a.ok && (val(a).postCommit as string[]).includes(what)).length;

describe('M-049: the order payment claim settles an order exactly once', () => {
  it('20 DIFFERENT paid events racing for one unpaid order: one claim wins, one order_paid fan-out, the order ends confirmed + paid', async () => {
    const store = 'mv-claim-race';
    const { stub, orderId } = await withPaymobPayment(store);
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => op(stub, store, 'paymentWebhook', hook(store, `e${i}`)))
    );
    expect(codes(answers)).toEqual({ ok: 20 });
    expect(fanouts(answers, 'order_paid')).toBe(1);
    const [o] = await sql<{ status: string; payment_status: string }>(
      stub,
      `SELECT status, payment_status FROM orders WHERE id = '${orderId}'`
    );
    expect(o).toEqual({ status: 'confirmed', payment_status: 'paid' });
  });

  it('an order already paid by one event is not claimed again by a later event: no second fan-out, state unchanged', async () => {
    const store = 'mv-claim-twice';
    const { stub } = await withPaymobPayment(store);
    const first = await op(stub, store, 'paymentWebhook', hook(store, 'a'));
    const second = await op(stub, store, 'paymentWebhook', hook(store, 'b'));
    expect(fanouts([first], 'order_paid')).toBe(1);
    expect(fanouts([second], 'order_paid')).toBe(0);
    expect(val(second).orderStatus).toBe('confirmed');
  });

  it('a capture on a CANCELLED order is recorded in full but never revives the order or fans out; a P1 alert names it', async () => {
    const store = 'mv-claim-cancelled';
    const { stub, orderId } = await withPaymobPayment(store);
    val(await op(stub, store, 'cancel', { orderId }));
    const r = await op(stub, store, 'paymentWebhook', hook(store, 'late'));
    const v = val(r);
    expect(v.outcome).toBe('applied');
    expect(v.orderStatus).toBe('cancelled'); // not flipped to confirmed
    expect(v.paymentStatus).toBe('completed'); // the money fact is kept
    expect(v.postCommit).not.toContain('order_paid');
    expect(v.alerts.map((a: { kind: string }) => a.kind)).toContain(
      'captured_on_unconfirmable_order'
    );
  });

  it('a payment on an order the merchant already shipped marks it paid WITHOUT moving the fulfilment status', async () => {
    const store = 'mv-claim-shipped';
    const { stub, orderId } = await withPaymobPayment(store);
    await sql(stub, `UPDATE orders SET status = 'shipped' WHERE id = '${orderId}'`);
    const v = val(await op(stub, store, 'paymentWebhook', hook(store, 'ship')));
    expect(v.orderStatus).toBe('shipped');
    expect(v.postCommit).toContain('order_paid');
    expect(await num(stub, `SELECT count(*) AS n FROM orders WHERE payment_status = 'paid'`)).toBe(
      1
    );
  });

  it('a late FAILED event after the order was paid never un-pays it (the paid state is final for the pull paths)', async () => {
    const store = 'mv-claim-nodowngrade';
    const { stub } = await withPaymobPayment(store);
    await op(stub, store, 'paymentWebhook', hook(store, 'ok'));
    const v = val(await op(stub, store, 'paymentWebhook', hook(store, 'bad', 'failed')));
    expect(v.outcome).toBe('ignored');
    expect(v.alerts.map((a: { kind: string }) => a.kind)).toContain('payment_downgrade_ignored');
    expect(await num(stub, `SELECT count(*) AS n FROM orders WHERE payment_status = 'paid'`)).toBe(
      1
    );
    expect(await num(stub, `SELECT count(*) AS n FROM payments WHERE status = 'completed'`)).toBe(
      1
    );
  });
});

/** an order with a COD payment row, in the given state */
async function codOrder(store: string, status: string, paymentStatus = 'unpaid', provider = 'cod') {
  const s = await seed(store);
  await runInDurableObject(s.stub, (_i, st) => {
    st.storage.sql.exec(
      `UPDATE orders SET status = ?, payment_status = ? WHERE id = ?`,
      status,
      paymentStatus,
      s.orderId
    );
    st.storage.sql.exec(
      `INSERT INTO payments (id, order_id, provider, status, amount, currency, metadata, created_at, updated_at) VALUES ('cod-pay', ?, ?, 'pending', ?, 'EGP', '{}', 1, 1)`,
      s.orderId,
      provider,
      s.total
    );
  });
  return s;
}
const orderRow = async (stub: Stub, id: string) =>
  (
    await sql<{ status: string; payment_status: string }>(
      stub,
      `SELECT status, payment_status FROM orders WHERE id = '${id}'`
    )
  )[0]!;
const payRow = async (stub: Stub) =>
  (await sql<{ status: string }>(stub, `SELECT status FROM payments WHERE id = 'cod-pay'`))[0]!;

describe('S3-O8: COD mark-paid is guarded by the order status', () => {
  it('a pending COD order becomes confirmed + paid and its payment completed', async () => {
    const store = 'mv-cod-ok';
    const { stub, orderId } = await codOrder(store, 'pending');
    const r = val(await op(stub, store, 'codMarkPaid', { orderIds: [orderId] }));
    expect(r.updated).toHaveLength(1);
    expect(await orderRow(stub, orderId)).toEqual({ status: 'confirmed', payment_status: 'paid' });
    expect((await payRow(stub)).status).toBe('completed');
  });

  it('a shipped COD order is marked paid but keeps its fulfilment status (cash is collected at delivery)', async () => {
    const store = 'mv-cod-shipped';
    const { stub, orderId } = await codOrder(store, 'shipped');
    expect(val(await op(stub, store, 'codMarkPaid', { orderIds: [orderId] })).updated).toHaveLength(
      1
    );
    expect(await orderRow(stub, orderId)).toEqual({ status: 'shipped', payment_status: 'paid' });
  });

  it.each(['cancelled', 'refunded'])(
    'a %s order is SKIPPED: nothing is booked as a sale that never happened',
    async status => {
      const store = `mv-cod-${status}`;
      const { stub, orderId } = await codOrder(store, status);
      expect(val(await op(stub, store, 'codMarkPaid', { orderIds: [orderId] })).updated).toEqual(
        []
      );
      expect(await orderRow(stub, orderId)).toEqual({ status, payment_status: 'unpaid' });
      expect((await payRow(stub)).status).toBe('pending');
    }
  );

  it('an already paid order is skipped, and a non-COD order is skipped', async () => {
    const paid = await codOrder('mv-cod-paid', 'confirmed', 'paid');
    expect(
      val(await op(paid.stub, 'mv-cod-paid', 'codMarkPaid', { orderIds: [paid.orderId] })).updated
    ).toEqual([]);
    const card = await codOrder('mv-cod-card', 'pending', 'unpaid', 'paymob');
    expect(
      val(await op(card.stub, 'mv-cod-card', 'codMarkPaid', { orderIds: [card.orderId] })).updated
    ).toEqual([]);
    expect(await orderRow(card.stub, card.orderId)).toEqual({
      status: 'pending',
      payment_status: 'unpaid',
    });
  });

  it('20 concurrent mark-paid clicks book it once (the API turns the empty answer into 409 ORDER_NOT_PAYABLE)', async () => {
    const store = 'mv-cod-race';
    const { stub, orderId } = await codOrder(store, 'pending');
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => op(stub, store, 'codMarkPaid', { orderIds: [orderId] }))
    );
    expect(answers.map(a => val(a).updated.length).reduce((s, n) => s + n, 0)).toBe(1);
  });
});

/** an InstaPay order on hold whose window ended 1 s ago (the order was placed through the real createOrder) */
async function heldOrder(store: string, expiresAt = Date.now() - 1000) {
  const s = await seed(store);
  val(
    await op(s.stub, store, 'instapayInitiate', {
      orderId: s.orderId,
      expiresAt,
      providerRef: null,
      metadata: {},
    })
  );
  return s;
}

describe('S3-O1 / FIX-006: the InstaPay hold expires only when the shopper sent no proof', () => {
  it('the default hold is 24 hours (the audit row says 48: that number is stale, see INSTAPAY_DEFAULT_EXPIRY_HOURS)', () => {
    expect(INSTAPAY_DEFAULT_EXPIRY_HOURS).toBe(24);
  });

  it('a hold past its deadline with NO proof is cancelled: stock back on sale, payment expired, note written', async () => {
    const store = 'mv-ip-expire';
    const { stub, orderId } = await heldOrder(store);
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(17);
    expect(val(await op(stub, store, 'expireHold', { orderId }))).toBe('expired');
    expect((await orderRow(stub, orderId)).status).toBe('cancelled');
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(20);
    expect(
      (
        await sql<{ status: string }>(
          stub,
          `SELECT status FROM payments WHERE provider = 'instapay'`
        )
      )[0]!.status
    ).toBe('expired');
    expect(
      (await sql<{ notes: string }>(stub, `SELECT notes FROM orders WHERE id = '${orderId}'`))[0]!
        .notes
    ).toContain('auto-cancelled: InstaPay confirmation window expired');
    // a second sweep is a no-op
    expect(val(await op(stub, store, 'expireHold', { orderId }))).toBe('skipped');
  });

  it('a hold that has not reached its deadline is skipped', async () => {
    const store = 'mv-ip-early';
    const { stub, orderId } = await heldOrder(store, Date.now() + 24 * 3_600_000);
    expect(val(await op(stub, store, 'expireHold', { orderId }))).toBe('skipped');
    expect((await orderRow(stub, orderId)).status).toBe('awaiting_payment_confirmation');
  });

  it('a shopper who sent proof is NEVER auto-cancelled, even past the deadline (help: "الطلب مش بيتلغي أوتوماتيك")', async () => {
    const store = 'mv-ip-proof';
    const { stub, orderId } = await heldOrder(store);
    expect(val(await op(stub, store, 'expireHold', { orderId, proofSubmitted: true }))).toBe(
      'skipped'
    );
    expect((await orderRow(stub, orderId)).status).toBe('awaiting_payment_confirmation');
    expect(await num(stub, `SELECT inventory AS n FROM products`)).toBe(17);
  });

  it('submitting a receipt freezes the deadline, so the sweep skips the order on its own', async () => {
    const store = 'mv-ip-freeze';
    const { stub, orderId } = await heldOrder(store);
    const d = val(
      await op(stub, store, 'receiptCreate', {
        orderId,
        storageKey: 'k1',
        mimeType: 'image/png',
        sizeBytes: 10,
        sha256: 'sha-1',
      })
    );
    val(
      await op(stub, store, 'receiptSubmit', {
        orderId,
        receiptId: d.id,
        referenceKey: '123456789012',
        flags: [],
        extractionStatus: 'pending',
        expectedAmountMinor: 3000,
        expectedReceiver: null,
        fields: {
          amountMinor: 3000,
          reference: '123456789012',
          transferredAt: Date.now(),
          payerName: null,
          payerAddress: null,
          payerMobile: null,
          payerBank: null,
          receiverName: null,
          receiverHandle: null,
          receiverMobile: null,
          note: null,
        },
      })
    );
    expect(
      await num(
        stub,
        `SELECT payment_confirmation_expires_at IS NULL AS n FROM orders WHERE id = '${orderId}'`
      )
    ).toBe(1);
    expect(val(await op(stub, store, 'expireHold', { orderId }))).toBe('skipped');
    expect((await orderRow(stub, orderId)).status).toBe('awaiting_payment_confirmation');
  });

  it('a rejected receipt gives the shopper 24 more hours (help: "الطلب بيستنى 24 ساعة زيادة")', async () => {
    const store = 'mv-ip-reject';
    const { stub, orderId } = await heldOrder(store);
    const d = val(
      await op(stub, store, 'receiptCreate', {
        orderId,
        storageKey: 'k2',
        mimeType: 'image/png',
        sizeBytes: 10,
        sha256: 'sha-2',
      })
    );
    await op(stub, store, 'receiptSubmit', {
      orderId,
      receiptId: d.id,
      referenceKey: '999999999999',
      flags: [],
      extractionStatus: 'pending',
      expectedAmountMinor: 3000,
      expectedReceiver: null,
      fields: {
        amountMinor: 3000,
        reference: '999999999999',
        transferredAt: Date.now(),
        payerName: null,
        payerAddress: null,
        payerMobile: null,
        payerBank: null,
        receiverName: null,
        receiverHandle: null,
        receiverMobile: null,
        note: null,
      },
    });
    const before = Date.now();
    val(
      await op(stub, store, 'receiptReject', {
        orderId,
        receiptId: d.id,
        note: 'wrong amount',
        actorId: 'u1',
      })
    );
    const exp = await num(
      stub,
      `SELECT payment_confirmation_expires_at AS n FROM orders WHERE id = '${orderId}'`
    );
    expect(exp).toBeGreaterThanOrEqual(before + 24 * 3_600_000);
    expect(exp).toBeLessThan(Date.now() + 24 * 3_600_000 + 1000);
    // still within the new window: not expirable
    expect(val(await op(stub, store, 'expireHold', { orderId }))).toBe('skipped');
  });

  it('confirming twice (and 20 at once) confirms the order once (help: "الطلب يتأكد مرة واحدة فقط")', async () => {
    const store = 'mv-ip-confirm';
    const { stub, orderId } = await heldOrder(store, Date.now() + 3_600_000);
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(stub, store, 'confirmPayment', { orderId, actorUserId: 'u1', proofSubmitted: true })
      )
    );
    expect(codes(answers)).toEqual({ ok: 20 });
    expect(answers.filter(a => val(a).changed === true)).toHaveLength(1);
    expect(await orderRow(stub, orderId)).toEqual({ status: 'confirmed', payment_status: 'paid' });
  });
});
