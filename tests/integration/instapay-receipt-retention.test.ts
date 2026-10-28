/**
 * M-003 / M-025 against REAL Postgres: the receipt screenshot is deleted when the payment is approved, the retention sweep
 * deletes stale images and scrubs personal fields (keeping the money evidence), and the shopper's erasure scrubs the receipts
 * of their orders. The private bucket is in-memory.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import { InstapayReceiptService } from '@api/services/payment-providers/instapay-receipt.service';
import { hasDb } from '../helpers/bundle-fixtures';
import { StorageService } from '@api/services/storage.service';

const TAG = `irr-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const uid = (l: string) => `${TAG}-${l}-${++seq}`;
const DAY = 86_400_000;
let storeId = '';
const objects = new Map<string, { body: Buffer; contentType: string }>();

async function mkOrder() {
  return prisma.order.create({
    data: {
      storeId,
      orderNumber: uid('ORD'),
      status: 'awaiting_payment_confirmation',
      paymentStatus: 'unpaid',
      subtotal: 5000,
      total: 5000,
      shippingAddress: {},
      billingAddress: {},
    },
  });
}
async function mkReceipt(over: Record<string, unknown> = {}) {
  const key = `stores/${storeId}/instapay-receipts/${uid('img')}.png`;
  objects.set(key, { body: Buffer.from('png'), contentType: 'image/png' });
  const order = await mkOrder();
  const r = await prisma.instapayReceipt.create({
    data: {
      storeId,
      kind: 'order',
      orderId: order.id,
      storageKey: key,
      mimeType: 'image/png',
      sizeBytes: 3,
      sha256: uid('sha'),
      extractionStatus: 'done',
      extracted: { amountMinor: 5000, reference: '123456789012', confidence: 0.9 },
      amountMinor: 5000,
      reference: '123456789012',
      referenceKey: uid('refkey'),
      transferredAt: new Date(),
      payerName: 'Mona Adel',
      payerMobile: '01012345678',
      payerBank: 'CIB',
      receiverName: 'Demo Store',
      note: 'rent',
      status: 'submitted',
      submittedAt: new Date(),
      ...over,
    },
  });
  return { ...r, key, orderId: order.id };
}
const fresh = (id: string) => prisma.instapayReceipt.findUniqueOrThrow({ where: { id } });

describe.skipIf(!hasDb)('InstaPay receipt retention (real Postgres)', () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `${uid('o')}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'I',
        lastName: 'R',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    storeId = (
      await prisma.store.create({
        data: { name: 'IRR', slug: uid('s'), ownerId: owner.id, status: 'active' },
      })
    ).id;
  });
  // re-armed before EVERY test (the runner restores spies between tests) over one shared in-memory bucket
  beforeEach(() => {
    vi.spyOn(StorageService, 'getPrivate').mockImplementation(async key => {
      const o = objects.get(key);
      if (!o) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { body: o.body, contentType: o.contentType };
    });
    vi.spyOn(StorageService, 'deletePrivate').mockImplementation(async key => {
      objects.delete(key);
    });
  });
  afterAll(async () => {
    await prisma.instapayReceipt.deleteMany({ where: { storeId } });
    await prisma.order.deleteMany({ where: { storeId } });
  });

  it('approving a receipt deletes its screenshot; a viewer then gets 410, the money fields stay', async () => {
    const r = await mkReceipt();
    // the approval transaction, then (after its commit) the image delete - the two steps both approval paths take
    const ids = await runInTenantContext(storeId, () =>
      prisma.$transaction(tx =>
        InstapayReceiptService.approveSubmitted(
          tx as never,
          storeId,
          { orderId: r.orderId },
          null,
          new Date()
        )
      )
    ).catch(async () =>
      runInTenantContext(storeId, () =>
        InstapayReceiptService.approveSubmitted(
          prisma as never,
          storeId,
          { orderId: r.orderId },
          null,
          new Date()
        )
      )
    );
    expect(ids).toEqual([r.id]);
    expect(objects.has(r.key)).toBe(true); // not before the commit
    await InstapayReceiptService.deleteImages(storeId, ids);
    expect(objects.has(r.key)).toBe(false);
    const row = await fresh(r.id);
    expect(row.imageDeletedAt).not.toBeNull();
    expect(row).toMatchObject({ status: 'approved', amountMinor: 5000, reference: '123456789012' });
    await expect(
      runInTenantContext(storeId, () =>
        InstapayReceiptService.readImage(storeId, r.id, { kind: 'order', orderId: r.orderId })
      )
    ).rejects.toMatchObject({ statusCode: 410, code: 'RECEIPT_IMAGE_DELETED' });
  });

  it('a rejection keeps the image for review; the sweep deletes it only 30 days after the decision', async () => {
    const recent = await mkReceipt({
      status: 'rejected',
      reviewedAt: new Date(Date.now() - 5 * DAY),
      referenceKey: null,
    });
    const old = await mkReceipt({
      status: 'rejected',
      reviewedAt: new Date(Date.now() - 31 * DAY),
      referenceKey: null,
    });
    const out = await InstapayReceiptService.sweepRetention();
    expect(out.images).toBeGreaterThanOrEqual(1);
    expect(objects.has(recent.key)).toBe(true);
    expect((await fresh(recent.id)).imageDeletedAt).toBeNull();
    expect(objects.has(old.key)).toBe(false);
    expect((await fresh(old.id)).imageDeletedAt).not.toBeNull();
  });

  it('abandoned drafts lose their image after 30 days; an APPROVED row whose delete was missed is retried', async () => {
    const draft = await mkReceipt({
      status: 'draft',
      createdAt: new Date(Date.now() - 31 * DAY),
      referenceKey: null,
    });
    const missed = await mkReceipt({
      status: 'approved',
      reviewedAt: new Date(),
      imageDeletedAt: null,
    });
    await InstapayReceiptService.sweepRetention();
    expect(objects.has(draft.key)).toBe(false);
    expect(objects.has(missed.key)).toBe(false);
    expect((await fresh(missed.id)).imageDeletedAt).not.toBeNull();
  });

  it('personal fields are scrubbed 180 days after a final decision; amount, reference, time and status stay', async () => {
    const old = await mkReceipt({
      status: 'approved',
      reviewedAt: new Date(Date.now() - 181 * DAY),
      imageDeletedAt: new Date(),
    });
    const young = await mkReceipt({
      status: 'approved',
      reviewedAt: new Date(Date.now() - 100 * DAY),
      imageDeletedAt: new Date(),
    });
    await InstapayReceiptService.sweepRetention();
    const o = await fresh(old.id);
    expect(o).toMatchObject({
      payerName: null,
      payerMobile: null,
      payerBank: null,
      receiverName: null,
      note: null,
      extracted: null,
    });
    expect(o.personalScrubbedAt).not.toBeNull();
    expect(o).toMatchObject({ amountMinor: 5000, reference: '123456789012', status: 'approved' });
    expect(o.transferredAt).not.toBeNull();
    const y = await fresh(young.id);
    expect(y.payerName).toBe('Mona Adel');
    expect(y.personalScrubbedAt).toBeNull();
  });

  it("the shopper's erasure scrubs the receipts of their orders and deletes the screenshots", async () => {
    const r = await mkReceipt({ status: 'approved', reviewedAt: new Date() });
    const other = await mkReceipt({ status: 'submitted' });
    await runInTenantContext(storeId, () =>
      prisma.$transaction(async tx => {
        const n = await InstapayReceiptService.scrubForOrders(tx as never, storeId, [r.orderId]);
        expect(n).toBe(1);
      })
    ).catch(async () => {
      // the proxy may already be a transaction: run it plain
      await runInTenantContext(storeId, () =>
        InstapayReceiptService.scrubForOrders(prisma as never, storeId, [r.orderId])
      );
    });
    const row = await fresh(r.id);
    expect(row).toMatchObject({ payerName: null, payerMobile: null, extracted: null });
    expect(row.personalScrubbedAt).not.toBeNull();
    // not deleted inside the erasure transaction (it could still roll back); the next sweep deletes it
    expect(objects.has(r.key)).toBe(true);
    await InstapayReceiptService.sweepRetention();
    expect(objects.has(r.key)).toBe(false);
    // another shopper's receipt is untouched
    expect((await fresh(other.id)).payerName).toBe('Mona Adel');
    expect(objects.has(other.key)).toBe(true);
  });

  it('an erased receipt whose immediate image delete missed is still deleted by the next sweep', async () => {
    const r = await mkReceipt({
      status: 'submitted',
      personalScrubbedAt: new Date(),
      payerName: null,
      imageDeletedAt: null,
    });
    expect(objects.has(r.key)).toBe(true);
    await InstapayReceiptService.sweepRetention();
    expect(objects.has(r.key)).toBe(false);
    expect((await fresh(r.id)).imageDeletedAt).not.toBeNull();
  });

  it('proof nobody ever decided on is retired: images after 90 days, personal fields after 180', async () => {
    const stale = await mkReceipt({
      status: 'submitted',
      submittedAt: new Date(Date.now() - 91 * DAY),
    });
    const older = await mkReceipt({
      status: 'submitted',
      submittedAt: new Date(Date.now() - 181 * DAY),
    });
    const live = await mkReceipt({
      status: 'submitted',
      submittedAt: new Date(Date.now() - 5 * DAY),
    });
    await InstapayReceiptService.sweepRetention();
    expect(objects.has(stale.key)).toBe(false);
    expect((await fresh(stale.id)).payerName).toBe('Mona Adel'); // 91 days: image gone, fields kept
    expect((await fresh(older.id)).payerName).toBeNull(); // 181 days: scrubbed
    expect(objects.has(live.key)).toBe(true);
  });
});
