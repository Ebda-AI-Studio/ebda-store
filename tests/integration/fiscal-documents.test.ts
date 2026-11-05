/**
 * Money fixes batch B — fiscal documents, COD fee, VAT base, store deletion,
 * shipping lifecycle (rulings MONEYB-1..5, MONEYB-7). Real Postgres (local
 * container in dev, the CI service container in CI — never Neon).
 *
 *  1. A COD checkout freezes the COD fee (fixed + %), taxes goods + fee, and
 *     issues a tax invoice whose number is a gap-free serial (not the order no.).
 *  2. Serials are gap-free under concurrency and a rolled-back sale burns none.
 *  3. Refunds issue credit notes (partial, then the remainder) naming the
 *     original number and date; a replayed refund issues nothing new.
 *  4. An unpaid cancel keeps the number and marks the document cancelled.
 *  5. Issued documents are immutable (DB trigger).
 *  6. Store deletion keeps issued documents and archives legacy orders + Ebda's
 *     billing ledger (no buyer data); money in flight refuses the deletion.
 *  7. Shipping: delivered via the shipment flow runs the status fan-out
 *     (deliveredAt, COD settled); return to origin cancels the order and the
 *     COD payment.
 *  8. Phones are stored as E.164.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, runInTenantContext, withMoneyTx } from '@ebda/database';
import { OrderService } from '@api/services/order.service';
import { CartService } from '@api/services/cart.service';
import { StoreService } from '@api/services/store.service';
import { FiscalDocumentService } from '@api/services/fiscal-document.service';
import { shippingCarrierService } from '@api/services/shipping-carrier.service';
import { handleOrderRefunded } from '@api/lib/inngest/functions/order-refunded';
import { cartSessionId, hasDb } from '../helpers/bundle-fixtures';
import { configureIdentityClient } from '@api/lib/identity-client';

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };
const TAG = `fiscal-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
let seq = 0;
const uid = (label: string) => `${TAG}-${label}-${++seq}`;

const PRICE = 10_000; // 100 EGP
const address = (phone = '٠١٠١٢٣٤٥٦٧٨', email = 'mona@example.test') => ({
  firstName: 'Mona',
  lastName: 'Adel',
  address1: 'شارع النصر، مبنى 5',
  address2: 'بجوار المسجد',
  city: '',
  state: '',
  postalCode: '',
  country: 'Egypt',
  governorate: 'Cairo',
  governorateAr: 'القاهرة',
  area: 'Nasr City',
  areaAr: 'مدينة نصر',
  phone,
  email,
});

async function mkStore(opts: { vat: boolean; cod: { fixedFee: number; percentBps: number } }) {
  const owner = await prisma.user.create({
    data: {
      email: `${uid('owner')}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'Owner',
      lastName: 'Fiscal',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  const store = await prisma.store.create({
    data: {
      name: 'Fiscal Store',
      slug: uid('store'),
      ownerId: owner.id,
      status: 'active',
      taxEnabled: opts.vat,
    },
  });
  if (opts.vat) {
    await prisma.taxRate.create({ data: { storeId: store.id, name: 'VAT', rate: 14 } });
    await prisma.storeTaxProfile.create({
      data: {
        storeId: store.id,
        status: 'verified',
        taxRegistrationNumber: '123456789',
        legalName: 'Fiscal Store LLC',
        verifiedAt: new Date(),
      },
    });
  }
  await prisma.paymentConfig.create({
    data: {
      storeId: store.id,
      provider: 'cod',
      isEnabled: true,
      fixedFee: opts.cod.fixedFee,
      settings: { percentBps: opts.cod.percentBps },
    },
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      name: 'Tee',
      slug: uid('tee'),
      price: PRICE,
      status: 'active',
      inventory: 1000,
      trackInventory: true,
    },
  });
  return { storeId: store.id, ownerId: owner.id, productId: product.id };
}

/**
 * Each call is a DIFFERENT customer by default (stock-hold cap,
 * lib/stock-hold-cap.ts: default2 per phone/email and8 per server-observed IP) —
 * this suite places many sequential COD orders against the same
 * `beforeAll`-shared store across many `it` blocks, none of which ever pay or
 * cancel a prior one, so reusing one literal contact for every call would
 * read as the SAME shopper accumulating unlimited open holds. Pass an
 * explicit `phone`/`email` only for a test that specifically needs to share
 * identity with another call (none here do).
 */
async function checkout(
  s: { storeId: string; productId: string },
  paymentMethod = 'cod',
  phone?: string,
  email?: string
) {
  const sessionId = cartSessionId('fiscal');
  const cart = await CartService.getOrCreate(s.storeId, sessionId, undefined);
  await prisma.cartItem.create({ data: { cartId: cart.id, productId: s.productId, quantity: 1 } });
  return OrderService.create(s.storeId, undefined, sessionId, {
    shippingAddress: address(
      phone ?? `+2010${(1_000_000 + ++seq).toString().slice(-7)}`,
      email ?? `${uid('mona')}@example.test`
    ),
    paymentMethod,
  });
}

const docsOf = (storeId: string, orderId?: string) =>
  prisma.fiscalDocument.findMany({
    where: { storeId, ...(orderId ? { orderId } : {}) },
    orderBy: [{ issuedAt: 'asc' }, { serial: 'asc' }],
  });

describe.skipIf(!hasDb)('fiscal documents — integration', () => {
  let vatStore: Awaited<ReturnType<typeof mkStore>>;
  let plainStore: Awaited<ReturnType<typeof mkStore>>;

  beforeAll(async () => {
    vatStore = await mkStore({ vat: true, cod: { fixedFee: 500, percentBps: 200 } });
    plainStore = await mkStore({ vat: false, cod: { fixedFee: 1_000, percentBps: 0 } });
  });

  afterAll(async () => {
    // Issued documents are immutable and retained 7 years by design; the test
    // database is disposable, so they are left in place.
  });

  it('COD checkout: fee frozen (fixed + %), VAT on goods + fee, tax invoice INV-000001 that balances', async () => {
    const order = await checkout(vatStore);
    // fee = 5 EGP + 2% of 100 EGP = 7 EGP
    expect(order.codFee).toBe(700);
    // VAT 14% on (100 + 7) = 14.98 EGP
    expect(order.tax).toBe(1_498);
    expect(order.taxableAmount).toBe(10_700);
    expect(order.total).toBe(10_700 + 1_498);
    const [doc] = await docsOf(vatStore.storeId, order.id);
    expect(doc).toMatchObject({
      docType: 'tax_invoice',
      serial: 1,
      number: 'INV-000001',
      status: 'issued',
      netAmount: 10_700,
      vatAmount: 1_498,
      totalAmount: order.total,
      sellerTrn: '123456789',
    });
    expect(doc.number).not.toBe(order.orderNumber);
    const payload = doc.payload as { lines: Array<{ kind: string; amount: number }> };
    expect(payload.lines.map(l => l.kind)).toEqual(['item', 'cod_fee']);
  });

  it('a non-VAT store issues a plain receipt with its own series and no buyer data', async () => {
    const order = await checkout(plainStore);
    expect(order.codFee).toBe(1_000);
    expect(order.tax).toBe(0);
    const [doc] = await docsOf(plainStore.storeId, order.id);
    expect(doc).toMatchObject({ docType: 'receipt', number: 'RCT-000001', vatAmount: 0 });
    expect((doc.payload as { buyer: { name: string } }).buyer.name).toBe('');
  });

  it('stores the phone as E.164 whatever digits the shopper typed', async () => {
    const order = await checkout(plainStore, 'cod', '٠١١ ٢٣٤٥ ٦٧٨٩');
    expect((order.shippingAddress as { phone: string }).phone).toBe('+201123456789');
  });

  it('serials are gap-free under concurrent checkouts and a rolled-back sale burns none', async () => {
    const before = await prisma.fiscalDocumentCounter.findUnique({
      where: { storeId_docType: { storeId: vatStore.storeId, docType: 'tax_invoice' } },
    });
    const start = before?.lastSerial ?? 0;

    // A sale whose transaction rolls back after its number was allocated.
    const orphan = await prisma.order.create({
      data: {
        storeId: vatStore.storeId,
        orderNumber: uid('ROLLBACK'),
        subtotal: PRICE,
        total: PRICE,
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId: vatStore.productId,
              productName: 'Tee',
              quantity: 1,
              price: PRICE,
              total: PRICE,
            },
          ],
        },
      },
    });
    await expect(
      runInTenantContext(vatStore.storeId, () =>
        withMoneyTx(prisma, async tx => {
          await FiscalDocumentService.issueSaleDocument(tx, vatStore.storeId, orphan.id);
          throw new Error('boom after allocation');
        })
      )
    ).rejects.toThrow('boom after allocation');

    // Six DIFFERENT customers checking out concurrently (proving invoice
    // serials never collide/skip under concurrency) — distinct phones so the
    // stock-hold cap (lib/stock-hold-cap.ts, max 2 open COD holds per
    // identity) sees six separate shoppers rather than one shopper racing
    // six holds against themselves.
    const orders = await Promise.all(
      Array.from({ length: 6 }, (_, i) => checkout(vatStore, 'cod', `+2010${2000000 + i}`))
    );
    const docs = await prisma.fiscalDocument.findMany({
      where: { storeId: vatStore.storeId, orderId: { in: orders.map(o => o.id) } },
      select: { serial: true, number: true },
    });
    const serials = docs.map(d => d.serial!).sort((a, b) => a - b);
    expect(serials).toEqual(Array.from({ length: 6 }, (_, i) => start + 1 + i));
    expect(new Set(docs.map(d => d.number)).size).toBe(6);
    expect(await docsOf(vatStore.storeId, orphan.id)).toHaveLength(0);
  });

  it('refunds issue credit notes naming the original; replay issues nothing; notes sum to the invoice', async () => {
    const order = await checkout(vatStore);
    // Delivered and paid (COD collected).
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'delivered', paymentStatus: 'paid' },
    });
    await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'cod',
        method: 'cod',
        status: 'completed',
        amount: order.total,
        currency: 'EGP',
      },
    });
    const [invoice] = await docsOf(vatStore.storeId, order.id);

    const partial = {
      items: [],
      refundKey: `refund:${uid('r')}`,
      refundAmount: 4_000,
      amountOnly: true,
    };
    await handleOrderRefunded(order.id, vatStore.storeId, false, false, stepStub, partial, false);
    await handleOrderRefunded(order.id, vatStore.storeId, false, false, stepStub, partial, false); // replay

    let docs = await docsOf(vatStore.storeId, order.id);
    const notes = docs.filter(d => d.docType === 'credit_note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      totalAmount: 4_000,
      originalNumber: invoice.number,
      originalDocumentId: invoice.id,
    });
    expect(notes[0].originalIssuedAt?.toISOString()).toBe(invoice.issuedAt.toISOString());
    expect(notes[0].number).toMatch(/^CRN-\d{6}$/);

    // The rest of the order is refunded: one more note for the remainder.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'refunded', paymentStatus: 'refunded' },
    });
    await handleOrderRefunded(order.id, vatStore.storeId, true, false, stepStub, undefined, true);
    await handleOrderRefunded(order.id, vatStore.storeId, true, false, stepStub, undefined, true); // replay
    docs = await docsOf(vatStore.storeId, order.id);
    const all = docs.filter(d => d.docType === 'credit_note');
    expect(all).toHaveLength(2);
    expect(all.reduce((n, d) => n + d.totalAmount, 0)).toBe(invoice.totalAmount);
    expect(all.reduce((n, d) => n + d.vatAmount, 0)).toBe(invoice.vatAmount);
    expect(all[1].serial).toBe(all[0].serial! + 1);
  });

  it('an unpaid cancel keeps the number and marks the document cancelled (no credit note)', async () => {
    const order = await checkout(plainStore);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'cancelled' } });
    await handleOrderRefunded(order.id, plainStore.storeId, true, false, stepStub, undefined, true);
    const docs = await docsOf(plainStore.storeId, order.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ docType: 'receipt', status: 'cancelled' });
    expect(docs[0].cancelledAt).not.toBeNull();
  });

  it('issued documents are immutable: no edit, no delete', async () => {
    const order = await checkout(plainStore);
    const [doc] = await docsOf(plainStore.storeId, order.id);
    await expect(
      prisma.fiscalDocument.update({ where: { id: doc.id }, data: { totalAmount: 1 } })
    ).rejects.toThrow(/immutable/);
    await expect(prisma.fiscalDocument.delete({ where: { id: doc.id } })).rejects.toThrow(
      /retained until/
    );
  });

  it('the shipment flow runs the status fan-out: delivered settles COD; return to origin cancels it', async () => {
    const delivered = await checkout(plainStore);
    await prisma.payment.create({
      data: {
        orderId: delivered.id,
        provider: 'cod',
        method: 'cod',
        status: 'cod_pending',
        amount: delivered.total,
        currency: 'EGP',
      },
    });
    await prisma.order.update({ where: { id: delivered.id }, data: { status: 'shipped' } });
    const shipA = await prisma.shipment.create({
      data: {
        storeId: plainStore.storeId,
        orderId: delivered.id,
        carrier: 'manual',
        status: 'in_transit',
        pickupAddress: {},
        deliveryAddress: {},
        codAmount: delivered.total,
      },
    });
    await runInTenantContext(plainStore.storeId, () =>
      shippingCarrierService.manualUpdateStatus(shipA.id, 'delivered')
    );
    const afterDelivered = await prisma.order.findUniqueOrThrow({
      where: { id: delivered.id },
      include: { payments: true },
    });
    expect(afterDelivered.status).toBe('delivered');
    expect(afterDelivered.deliveredAt).not.toBeNull();
    expect(afterDelivered.paymentStatus).toBe('paid');
    expect(afterDelivered.payments[0].status).toBe('completed');
    expect(
      await prisma.orderEvent.count({ where: { orderId: delivered.id, toStatus: 'delivered' } })
    ).toBe(1);

    const returned = await checkout(plainStore);
    await prisma.payment.create({
      data: {
        orderId: returned.id,
        provider: 'cod',
        method: 'cod',
        status: 'cod_pending',
        amount: returned.total,
        currency: 'EGP',
      },
    });
    await prisma.order.update({ where: { id: returned.id }, data: { status: 'shipped' } });
    const shipB = await prisma.shipment.create({
      data: {
        storeId: plainStore.storeId,
        orderId: returned.id,
        carrier: 'manual',
        status: 'in_transit',
        pickupAddress: {},
        deliveryAddress: {},
        codAmount: returned.total,
      },
    });
    await runInTenantContext(plainStore.storeId, () =>
      shippingCarrierService.manualUpdateStatus(shipB.id, 'returned', { restock: true })
    );
    const afterReturn = await prisma.order.findUniqueOrThrow({
      where: { id: returned.id },
      include: { payments: true },
    });
    expect(afterReturn.status).toBe('cancelled');
    expect(afterReturn.paymentStatus).toBe('unpaid');
    expect(afterReturn.payments[0].status).toBe('cancelled');
  });

  it('store deletion is refused while money is in flight', async () => {
    const s = await mkStore({ vat: false, cod: { fixedFee: 0, percentBps: 0 } });
    const order = await checkout(s);
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'confirmed', paymentStatus: 'paid' },
    });
    const operator = await prisma.user.create({
      data: {
        email: `${uid('op')}@test.local`,
        passwordHash: 'x',
        firstName: 'Op',
        lastName: 'Er',
        role: 'super_admin',
      },
    });
    await expect(StoreService.delete(s.storeId, operator.id)).rejects.toMatchObject({
      code: 'STORE_HAS_MONEY_IN_FLIGHT',
    });
    expect(await prisma.store.count({ where: { id: s.storeId } })).toBe(1);
  });

  it('store deletion keeps issued documents and archives legacy orders + the billing ledger, without buyer data', async () => {
    const s = await mkStore({ vat: false, cod: { fixedFee: 0, percentBps: 0 } });
    const issued = await checkout(s);
    await prisma.order.update({
      where: { id: issued.id },
      data: { status: 'delivered', paymentStatus: 'paid' },
    });
    // A legacy order from before numbering (no document).
    const legacy = await prisma.order.create({
      data: {
        storeId: s.storeId,
        orderNumber: uid('LEGACY'),
        status: 'delivered',
        paymentStatus: 'paid',
        subtotal: PRICE,
        total: PRICE,
        shippingAddress: address(),
        billingAddress: address(),
        items: {
          create: [
            { productId: s.productId, productName: 'Tee', quantity: 1, price: PRICE, total: PRICE },
          ],
        },
      },
    });
    await prisma.billingEvent.create({
      data: {
        storeId: s.storeId,
        type: 'checkout',
        planCode: 'growth',
        amountMinor: 349_000,
        vatMinor: 0,
        provider: 'manual_payment',
        idempotencyKey: uid('bill'),
        status: 'succeeded',
      },
    });
    const operator = await prisma.user.create({
      data: {
        email: `${uid('op')}@test.local`,
        passwordHash: 'x',
        firstName: 'Op',
        lastName: 'Er',
        role: 'super_admin',
      },
    });

    // Deleting a store flips its identity-managed owner at the identity service (store.service.ts); the Postgres tier has no
    // ACCOUNTS binding, so answer as the service would for an active account.
    configureIdentityClient({
      getAccountState: async () => ({ status: 'active' }) as never,
      setStatus: async () => undefined,
      revokeUser: async () => undefined,
      deleteStoreClients: async () => ({ clients: 0 }),
    });
    try {
      await StoreService.delete(s.storeId, operator.id);
    } finally {
      configureIdentityClient(undefined);
    }

    expect(await prisma.store.count({ where: { id: s.storeId } })).toBe(0);
    expect(await prisma.order.count({ where: { storeId: s.storeId } })).toBe(0);
    const archive = await docsOf(s.storeId);
    const byType = (t: string) => archive.filter(d => d.docType === t);
    expect(byType('receipt')).toHaveLength(1);
    expect(byType('receipt')[0].orderId).toBe(issued.id);
    expect(byType('order_record')).toHaveLength(1);
    expect(byType('order_record')[0]).toMatchObject({ orderId: legacy.id, totalAmount: PRICE });
    expect(byType('billing_record')).toHaveLength(1);
    expect(byType('billing_record')[0].totalAmount).toBe(349_000);
    // PDPL minimisation: the archive record carries no buyer data.
    const legacyPayload = JSON.stringify(byType('order_record')[0].payload);
    expect(legacyPayload).not.toContain('Mona');
    expect(legacyPayload).not.toContain('+20');
    expect(legacyPayload).not.toContain('mona@example.test');
    // Retained for 7 years (Ruling RETENTION-1).
    expect(byType('order_record')[0].retainUntil.getUTCFullYear()).toBe(
      legacy.createdAt.getUTCFullYear() + 7
    );
  });
});
