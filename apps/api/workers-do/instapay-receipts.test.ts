import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 R3 (Ruling INSTAPAY-DO-1): InstaPay order receipts on real workerd. The Postgres `lockOrder` (FOR UPDATE) and the
// UNIQUE reference_key are the DO's single thread and its partial unique index.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (stub: ReturnType<typeof stubFor>, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const val = (a: Answer) => {
  if (!a.ok) throw new Error(`refused ${a.code}`);
  return decodeRpc<any>(a.json);
};
const num = (stub: ReturnType<typeof stubFor>, sql: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql).one().n as number);
const codes = (a: Answer[]) =>
  a.reduce<Record<string, number>>((m, x) => {
    const k = x.ok ? 'ok' : x.code;
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

async function seed(store: string, orders: string[]) {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store
  await runInDurableObject(stub, (_i, s) => {
    for (const id of orders) {
      s.storage.sql.exec(
        `INSERT INTO orders (id, store_id, order_number, status, payment_status, subtotal, total, shipping_address, billing_address, payment_confirmation_expires_at)
         VALUES (?, ?, ?, 'awaiting_payment_confirmation', 'unpaid', 1000, 1000, '{}', '{}', ?)`,
        id,
        store,
        id,
        Date.now() + 3_600_000
      );
      s.storage.sql.exec(
        `INSERT INTO payments (id, order_id, provider, status, amount, currency, metadata, created_at, updated_at) VALUES (?, ?, 'instapay', 'pending', 1000, 'EGP', '{}', 1, 1)`,
        `p-${id}`,
        id
      );
    }
  });
  return stub;
}
const draft = async (stub: ReturnType<typeof stubFor>, store: string, orderId: string) =>
  val(
    await op(stub, store, 'receiptCreate', {
      orderId,
      storageKey: `k-${crypto.randomUUID()}`,
      mimeType: 'image/png',
      sizeBytes: 10,
      sha256: crypto.randomUUID(),
    })
  );
const submit = (
  stub: ReturnType<typeof stubFor>,
  store: string,
  orderId: string,
  receiptId: string,
  ref: string
) =>
  op(stub, store, 'receiptSubmit', {
    orderId,
    receiptId,
    referenceKey: ref,
    flags: [],
    extractionStatus: 'pending',
    expectedAmountMinor: 1000,
    expectedReceiver: null,
    fields: {
      amountMinor: 1000,
      reference: ref,
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

describe('InstaPay order receipts on the store DO', () => {
  it('20 concurrent submits of one transfer reference from 20 orders: one wins, 19 are DUPLICATE_REFERENCE', async () => {
    const store = 'ipr-ref';
    const orders = Array.from({ length: 20 }, (_, i) => `o${i}`);
    const stub = await seed(store, orders);
    const drafts = await Promise.all(orders.map(o => draft(stub, store, o)));
    const r = await Promise.all(
      drafts.map((d, i) => submit(stub, store, orders[i], d.id, '123456789012'))
    );
    expect(codes(r)).toEqual({ ok: 1, DUPLICATE_REFERENCE: 19 });
    expect(
      await num(stub, "SELECT COUNT(*) n FROM instapay_order_receipts WHERE status = 'submitted'")
    ).toBe(1);
  });

  it('20 concurrent submits of the same receipt: one wins, the rest wait for the store; one payment event', async () => {
    const store = 'ipr-same';
    const stub = await seed(store, ['o1']);
    const d = await draft(stub, store, 'o1');
    const r = await Promise.all(
      Array.from({ length: 20 }, () => submit(stub, store, 'o1', d.id, '999999999999'))
    );
    expect(codes(r)).toEqual({ ok: 1, PROOF_PENDING_REVIEW: 19 });
    expect(
      await num(stub, "SELECT COUNT(*) n FROM payment_events WHERE event_type = 'status_change'")
    ).toBe(1);
  });

  it('confirm racing reject: exactly one decision stands, and the receipt agrees with the order', async () => {
    const store = 'ipr-race';
    const stub = await seed(store, ['o1']);
    const d = await draft(stub, store, 'o1');
    val(await submit(stub, store, 'o1', d.id, '555555555555'));
    const answers = await Promise.all([
      ...Array.from({ length: 10 }, () =>
        op(stub, store, 'confirmPayment', { orderId: 'o1', actorUserId: 'u1' })
      ),
      ...Array.from({ length: 10 }, () =>
        op(stub, store, 'receiptReject', {
          orderId: 'o1',
          receiptId: d.id,
          note: 'no good',
          actorId: 'u1',
        })
      ),
    ]);
    const confirmed =
      (await num(stub, "SELECT COUNT(*) n FROM orders WHERE status = 'confirmed'")) === 1;
    expect(
      await num(
        stub,
        `SELECT COUNT(*) n FROM instapay_order_receipts WHERE status = '${confirmed ? 'approved' : 'rejected'}'`
      )
    ).toBe(1);
    expect(
      answers.filter(a => a.ok && 'json' in a && decodeRpc<any>(a.json).changed === true).length +
        answers.filter(a => a.ok && 'json' in a && decodeRpc<any>(a.json).receiptId).length
    ).toBe(1);
  });
});
