import { beforeAll, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { ensurePlatformIndex } from './platform-index';

// M-025 (retention, docs/RETENTION.md) on the Durable Object: the DO-lane replacement of the Postgres-only, skipped
// tests/integration/instapay-receipt-retention.test.ts. `receiptSweep` (the op the retention job and the DO alarm call) lists the
// screenshots that are due and scrubs the personal fields; money evidence (amount, reference, time, status) stays.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
beforeAll(ensurePlatformIndex);
const DAY = 86_400_000;
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Stub = ReturnType<typeof stubFor>;
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };

async function bound(store: string) {
  const stub = stubFor(store);
  await stub.moneyOp(store, 'cancel', encodeRpc({ orderId: 'nope' })); // binds the store
  return stub;
}
interface R {
  status: string;
  reviewedAt?: number | null;
  createdAt?: number;
  submittedAt?: number | null;
  imageDeletedAt?: number | null;
  personalScrubbedAt?: number | null;
}
let n = 0;
async function receipt(stub: Stub, store: string, r: R) {
  const id = `r${++n}`;
  await runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(
      `INSERT INTO orders (id, store_id, order_number, status, payment_status, subtotal, total, shipping_address, billing_address)
       VALUES (?, ?, ?, 'awaiting_payment_confirmation', 'unpaid', 1, 1, '{}', '{}')`,
      `o-${id}`,
      store,
      `o-${id}`
    );
    s.storage.sql.exec(
      `INSERT INTO instapay_order_receipts (id, store_id, order_id, storage_key, mime_type, size_bytes, sha256, status, amount_minor, reference,
         transferred_at, payer_name, payer_mobile, payer_bank, receiver_name, note, extracted, reviewed_at, submitted_at, image_deleted_at,
         personal_scrubbed_at, created_at)
       VALUES (?, ?, ?, ?, 'image/png', 1, ?, ?, 5000, '123456789012', 5, 'Mona Adel', '01012345678', 'CIB', 'Demo Store', 'rent', '{"a":1}', ?, ?, ?, ?, ?)`,
      id,
      store,
      `o-${id}`,
      `key-${id}`,
      `sha-${id}`,
      r.status,
      r.reviewedAt ?? null,
      r.submittedAt ?? null,
      r.imageDeletedAt ?? null,
      r.personalScrubbedAt ?? null,
      r.createdAt ?? Date.now()
    );
  });
  return id;
}
const sweep = async (stub: Stub, store: string) => {
  const a = (await stub.moneyOp(store, 'receiptSweep', encodeRpc({}))) as Answer;
  if (!a.ok) throw new Error(a.code);
  const v = decodeRpc<{ dueImages: Array<{ id: string; storageKey: string }>; scrubbed: number }>(
    a.json
  );
  return { due: v.dueImages.map(d => d.id).sort(), scrubbed: v.scrubbed };
};
const row = (stub: Stub, id: string) =>
  runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql.exec(`SELECT * FROM instapay_order_receipts WHERE id = ?`, id).one() as any
  );

describe('M-025 InstaPay receipt retention on the store DO', () => {
  it('approved: the screenshot is due at once; rejected only after 30 days; abandoned drafts after 30 days', async () => {
    const store = 'mv-ret-images';
    const stub = await bound(store);
    const approved = await receipt(stub, store, { status: 'approved', reviewedAt: Date.now() });
    const rejNew = await receipt(stub, store, {
      status: 'rejected',
      reviewedAt: Date.now() - 5 * DAY,
    });
    const rejOld = await receipt(stub, store, {
      status: 'rejected',
      reviewedAt: Date.now() - 31 * DAY,
    });
    const voidOld = await receipt(stub, store, {
      status: 'voided',
      reviewedAt: Date.now() - 31 * DAY,
    });
    const draftNew = await receipt(stub, store, { status: 'draft', createdAt: Date.now() - DAY });
    const draftOld = await receipt(stub, store, {
      status: 'draft',
      createdAt: Date.now() - 31 * DAY,
    });
    const r = await sweep(stub, store);
    expect(r.due).toEqual([approved, rejOld, voidOld, draftOld].sort());
    expect(r.due).not.toContain(rejNew);
    expect(r.due).not.toContain(draftNew);
  });

  it('undecided proof loses its image after 90 days and its personal fields after 180; a live claim is untouched', async () => {
    const store = 'mv-ret-undecided';
    const stub = await bound(store);
    const live = await receipt(stub, store, {
      status: 'submitted',
      submittedAt: Date.now() - 5 * DAY,
    });
    const stale = await receipt(stub, store, {
      status: 'submitted',
      submittedAt: Date.now() - 91 * DAY,
    });
    const older = await receipt(stub, store, {
      status: 'submitted',
      submittedAt: Date.now() - 181 * DAY,
    });
    const r = await sweep(stub, store);
    expect(r.due).toEqual([stale, older].sort());
    expect(r.scrubbed).toBe(1);
    expect((await row(stub, stale)).payer_name).toBe('Mona Adel'); // 91 days: image goes, fields stay
    expect((await row(stub, older)).payer_name).toBeNull(); // 181 days: scrubbed
    expect((await row(stub, live)).payer_name).toBe('Mona Adel');
  });

  it('personal fields are scrubbed 180 days after a final decision; amount, reference, time and status stay; a 100-day row is untouched', async () => {
    const store = 'mv-ret-scrub';
    const stub = await bound(store);
    const old = await receipt(stub, store, {
      status: 'approved',
      reviewedAt: Date.now() - 181 * DAY,
      imageDeletedAt: 1,
    });
    const young = await receipt(stub, store, {
      status: 'approved',
      reviewedAt: Date.now() - 100 * DAY,
      imageDeletedAt: 1,
    });
    const r = await sweep(stub, store);
    expect(r.scrubbed).toBe(1);
    const o = await row(stub, old);
    for (const f of [
      'payer_name',
      'payer_mobile',
      'payer_bank',
      'receiver_name',
      'note',
      'extracted',
    ])
      expect(o[f]).toBeNull();
    expect(o.personal_scrubbed_at).not.toBeNull();
    expect(o).toMatchObject({ amount_minor: 5000, reference: '123456789012', status: 'approved' });
    expect(o.transferred_at).not.toBeNull();
    const y = await row(stub, young);
    expect(y.payer_name).toBe('Mona Adel');
    expect(y.personal_scrubbed_at).toBeNull();
  });

  it('an erased receipt whose immediate delete missed, and an approved row whose delete was missed, are listed again (retry); a deleted image is not', async () => {
    const store = 'mv-ret-retry';
    const stub = await bound(store);
    const erased = await receipt(stub, store, {
      status: 'submitted',
      submittedAt: Date.now(),
      personalScrubbedAt: Date.now(),
    });
    const missed = await receipt(stub, store, { status: 'approved', reviewedAt: Date.now() });
    const done = await receipt(stub, store, {
      status: 'approved',
      reviewedAt: Date.now(),
      imageDeletedAt: Date.now(),
    });
    const r = await sweep(stub, store);
    expect(r.due).toEqual([erased, missed].sort());
    expect(r.due).not.toContain(done);
  });

  it('the sweep is idempotent: a second run scrubs nothing more', async () => {
    const store = 'mv-ret-idem';
    const stub = await bound(store);
    await receipt(stub, store, {
      status: 'approved',
      reviewedAt: Date.now() - 200 * DAY,
      imageDeletedAt: 1,
    });
    expect((await sweep(stub, store)).scrubbed).toBe(1);
    expect((await sweep(stub, store)).scrubbed).toBe(0);
  });
});
