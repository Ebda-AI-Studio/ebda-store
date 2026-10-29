// INFRA-CF-1 R3 (Ruling INSTAPAY-DO-1): the InstaPay order receipt engine on the real DO schema (node:sqlite).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { ensurePaymentSchema } from '../src/do/payments';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  ensurePaymentSchema(db);
  const order = (id: string, expires: number | null = Date.now() + 3_600_000) => {
    raw.exec(
      `INSERT INTO orders (id, store_id, order_number, status, payment_status, subtotal, total, shipping_address, billing_address, payment_confirmation_expires_at)
       VALUES ('${id}', 's1', '${id}', 'awaiting_payment_confirmation', 'unpaid', 1000, 1000, '{}', '{}', ${expires})`
    );
    raw.exec(
      `INSERT INTO payments (id, order_id, provider, status, amount, currency, metadata, created_at, updated_at)
       VALUES ('p-${id}', '${id}', 'instapay', 'pending', 1000, 'EGP', '{"handle":"a@instapay","expiresAt":"2030-01-01T00:00:00.000Z"}', 1, 1)`
    );
  };
  const op = (name: string, args: Record<string, unknown>) =>
    runMoneyOp(db, S, name, args, undefined) as any;
  const code = (name: string, args: Record<string, unknown>) => {
    try {
      op(name, args);
    } catch (e) {
      return `${(e as MoneyError).code}/${(e as MoneyError).status}`;
    }
    return 'no error';
  };
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  const draft = (orderId: string, sha = 'sha-' + Math.random()) =>
    op('receiptCreate', {
      orderId,
      paymentId: `p-${orderId}`,
      storageKey: `k-${Math.random()}`,
      mimeType: 'image/png',
      sizeBytes: 10,
      sha256: sha,
    });
  const fields = {
    amountMinor: 1000,
    reference: '123456789012',
    transferredAt: Date.now(),
    payerName: 'Payer',
    payerAddress: null,
    payerMobile: null,
    payerBank: null,
    receiverName: null,
    receiverHandle: 'a@instapay',
    receiverMobile: null,
    note: null,
  };
  const submit = (orderId: string, receiptId: string, referenceKey = '123456789012') =>
    op('receiptSubmit', {
      orderId,
      receiptId,
      fields: { ...fields, reference: referenceKey },
      referenceKey,
      flags: ['AI_UNAVAILABLE'],
      extractionStatus: 'pending',
      expectedAmountMinor: 1000,
      expectedReceiver: 'a@instapay',
    });
  const exec = (sql: string) => raw.exec(sql);
  return { op, code, q, exec, order, draft, submit, fields };
}

describe('InstaPay order receipts on the DO', () => {
  it('submit freezes the hold, remembers the reference on the payment and writes an event, in one step', () => {
    const r = rig();
    r.order('o1');
    const d = r.draft('o1');
    const row = r.submit('o1', d.id);
    expect(row.status).toBe('submitted');
    expect(row.flags).toEqual(['AI_UNAVAILABLE']);
    expect(r.q('SELECT payment_confirmation_expires_at e FROM orders')[0].e).toBeNull();
    expect(JSON.parse(r.q('SELECT metadata m FROM payments')[0].m)).toMatchObject({
      customerReference: '123456789012',
      receiptId: d.id,
    });
    expect(
      r.q("SELECT details FROM payment_events WHERE event_type = 'status_change'")
    ).toHaveLength(1);
  });

  it('the same reference cannot be used by a second receipt (another order of the store); the refusal changes nothing', () => {
    const r = rig();
    const { fields } = r;
    r.order('o1');
    r.order('o2');
    r.submit('o1', r.draft('o1').id);
    const d2 = r.draft('o2');
    expect(
      r.code('receiptSubmit', {
        orderId: 'o2',
        receiptId: d2.id,
        fields,
        referenceKey: '123456789012',
        flags: [],
        extractionStatus: 'pending',
        expectedAmountMinor: 1000,
        expectedReceiver: null,
      })
    ).toBe('DUPLICATE_REFERENCE/409');
    expect(r.q('SELECT status s FROM instapay_order_receipts WHERE id = ?', d2.id)[0].s).toBe(
      'draft'
    );
    expect(
      r.q('SELECT payment_confirmation_expires_at e FROM orders WHERE id = ?', 'o2')[0].e
    ).not.toBeNull();
  });

  it('refusals come in the Postgres order: a waiting receipt first, then not a draft; a stale AI read is RECEIPT_CHANGED', () => {
    const r = rig();
    const { fields } = r;
    r.order('o1');
    const d = r.draft('o1');
    const d2 = r.draft('o1');
    expect(
      r.code('receiptSubmit', {
        orderId: 'o1',
        receiptId: d.id,
        fields,
        referenceKey: 'k1',
        flags: [],
        extractionStatus: 'done',
        expectedAmountMinor: null,
        expectedReceiver: null,
      })
    ).toBe('RECEIPT_CHANGED/409');
    r.submit('o1', d.id);
    expect(
      r.code('receiptSubmit', {
        orderId: 'o1',
        receiptId: d2.id,
        fields,
        referenceKey: 'k2',
        flags: [],
        extractionStatus: 'pending',
        expectedAmountMinor: null,
        expectedReceiver: null,
      })
    ).toBe('PROOF_PENDING_REVIEW/409');
  });

  it('reject frees the reference and restarts the hold at max(original, now + 24 h); the shopper can refile', () => {
    const r = rig();
    r.order('o1', null);
    const d = r.draft('o1');
    r.submit('o1', d.id);
    const out = r.op('receiptReject', {
      orderId: 'o1',
      receiptId: d.id,
      note: 'wrong amount',
      actorId: 'u1',
    });
    expect(out.referenceKey).toBe('123456789012');
    expect(out.expiresAt).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(
      r.q('SELECT reference_key k FROM instapay_order_receipts WHERE id = ?', d.id)[0].k
    ).toBeNull();
    expect(
      r.code('receiptReject', { orderId: 'o1', receiptId: d.id, note: 'again', actorId: 'u1' })
    ).toBe('RECEIPT_NOT_PENDING/409');
    expect(r.submit('o1', r.draft('o1').id).status).toBe('submitted');
  });

  it('the merchant confirm approves the submitted receipts in the same section and returns their ids', () => {
    const r = rig();
    r.order('o1');
    const d = r.draft('o1');
    r.submit('o1', d.id);
    const c = r.op('confirmPayment', { orderId: 'o1', actorUserId: 'u1' });
    expect(c).toMatchObject({ changed: true, approvedReceiptIds: [d.id] });
    expect(r.q('SELECT status s FROM instapay_order_receipts')[0].s).toBe('approved');
    expect(r.op('confirmPayment', { orderId: 'o1', actorUserId: 'u1' }).changed).toBe(false);
  });

  it('a submitted receipt is proof: a confirm past the window works without the caller saying so', () => {
    const r = rig();
    r.order('o1');
    const d = r.draft('o1');
    r.submit('o1', d.id);
    // the window closed (a reject restarts it; here it is closed by hand)
    r.exec('UPDATE orders SET payment_confirmation_expires_at = 1');
    expect(r.op('confirmPayment', { orderId: 'o1', actorUserId: 'u1' }).changed).toBe(true);
  });

  it('cap of six per order, AI read written once, retention scrubs and lists images, erasure scrub', () => {
    const r = rig();
    r.order('o1');
    for (let i = 0; i < 6; i++) r.draft('o1');
    expect(
      r.code('receiptCreate', {
        orderId: 'o1',
        storageKey: 'k',
        mimeType: 'image/png',
        sizeBytes: 1,
        sha256: 'x',
      })
    ).toBe('TOO_MANY_RECEIPTS/429');
    const id = r.q('SELECT id FROM instapay_order_receipts LIMIT 1')[0].id as string;
    expect(
      r.op('receiptExtraction', {
        receiptId: id,
        status: 'done',
        extracted: { a: 1 },
        confidence: 0.9,
      }).updated
    ).toBe(true);
    expect(r.op('receiptExtraction', { receiptId: id, status: 'failed', error: 'x' }).updated).toBe(
      false
    );
    expect(r.op('receiptGet', { receiptId: id }).extracted).toEqual({ a: 1 });
    expect(r.op('receiptScrub', { orderIds: ['o1'] }).scrubbed).toBe(6);
    expect(r.op('receiptGet', { receiptId: id }).extracted).toBeNull();
    expect(r.op('receiptSweep', {}).dueImages).toHaveLength(6); // scrubbed rows keep an image until it is deleted
    expect(r.op('receiptImageDeleted', { receiptId: id }).alreadyDeleted).toBe(false);
    expect(r.op('receiptImageDeleted', { receiptId: id }).alreadyDeleted).toBe(true);
  });
});
