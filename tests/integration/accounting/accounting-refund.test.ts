import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { postOrderPaymentJournal } from '../../../apps/api/src/services/accounting/posting/order-posting';
import { postRefundJournal } from '../../../apps/api/src/services/accounting/posting/refund-posting';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
let storeId: string;
let productId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `refund-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Refund',
      lastName: 'Owner',
    },
  });
  const store = await prisma.store.create({
    data: {
      name: `refund-test-${Date.now()}`,
      slug: `refund-test-${Date.now()}`,
      ownerId: OWNER,
    },
  });
  storeId = store.id;
  await seedCoaForStore(storeId);

  const p = await prisma.product.create({
    data: {
      storeId,
      name: 'Refund Test Product',
      slug: `refund-test-product-${Date.now()}`,
      price: 2000,
      costPrice: 1000,
      inventory: 50,
      status: 'active',
    },
  });
  productId = p.id;
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.payment.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('refund posts a reversal journal entry', () => {
  it('marks original status=reversed and posts a mirror entry per source', async () => {
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: `REFUND-${Date.now()}`,
        status: 'confirmed',
        paymentStatus: 'paid',
        subtotal: 2000,
        tax: 0,
        shipping: 0,
        discount: 0,
        total: 2000,
        currency: 'EGP',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId,
              productName: 'Refund Test Product',
              quantity: 1,
              price: 2000,
              total: 2000,
              costPrice: 1000,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'myfatoorah',
              status: 'completed',
              amount: 2000,
              paidAt: new Date(),
            },
          ],
        },
      },
    });

    await postOrderPaymentJournal({ orderId: order.id });
    const result = await postRefundJournal({ orderId: order.id, reason: 'customer requested' });
    expect(result.reversed).toBe(2); // cash/sales + cogs

    // Original cash/sales entry → status='reversed', reversedById set
    const cashOriginal = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: order.id },
    });
    expect(cashOriginal?.status).toBe('reversed');
    expect(cashOriginal?.reversedById).toBeTruthy();

    // Reversal entry resolves to original via "Reversal" inverse accessor
    const cashReversal = await prisma.journalEntry.findUnique({
      where: { id: cashOriginal!.reversedById! },
      include: { lines: true, reverses: true },
    });
    expect(cashReversal?.reverses?.id).toBe(cashOriginal!.id);
    // Mirror: original had DR Cash 2000 / CR Revenue 2000 → reversal has CR Cash 2000 / DR Revenue 2000
    expect(cashReversal?.lines.find(l => l.credit === 2000)).toBeDefined();
    expect(cashReversal?.lines.find(l => l.debit === 2000)).toBeDefined();

    // COGS entry — same treatment
    const cogsOriginal = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: `${order.id}:cogs` },
    });
    expect(cogsOriginal?.status).toBe('reversed');
    expect(cogsOriginal?.reversedById).toBeTruthy();

    const cogsReversal = await prisma.journalEntry.findUnique({
      where: { id: cogsOriginal!.reversedById! },
      include: { lines: true },
    });
    // Original had DR COGS 1000 / CR Inventory 1000 → reversal has CR COGS 1000 / DR Inventory 1000
    expect(cogsReversal?.lines.find(l => l.credit === 1000)).toBeDefined();
    expect(cogsReversal?.lines.find(l => l.debit === 1000)).toBeDefined();
  });

  it('idempotent — re-calling postRefundJournal does not re-reverse', async () => {
    const order = await prisma.order.findFirst({
      where: { storeId, paymentStatus: 'paid' },
    });
    if (!order) throw new Error('no paid order from previous test');
    const beforeCount = await prisma.journalEntry.count({ where: { storeId } });
    const result = await postRefundJournal({ orderId: order.id, reason: 'duplicate fire' });
    expect(result.reversed).toBe(0); // both already reversed → no-op
    const afterCount = await prisma.journalEntry.count({ where: { storeId } });
    expect(afterCount).toBe(beforeCount);
  });

  it('no-op when order never posted a journal', async () => {
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: `NEVERPAID-${Date.now()}`,
        status: 'pending',
        paymentStatus: 'unpaid',
        subtotal: 1000,
        tax: 0,
        shipping: 0,
        discount: 0,
        total: 1000,
        currency: 'EGP',
        shippingAddress: {},
        billingAddress: {},
      },
    });
    const result = await postRefundJournal({ orderId: order.id, reason: 'never paid' });
    expect(result.reversed).toBe(0);
  });
});
