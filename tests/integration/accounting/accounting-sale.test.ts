import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { postOrderPaymentJournal } from '../../../apps/api/src/services/accounting/posting/order-posting';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
let storeId: string;
let productId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `sale-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Sale',
      lastName: 'Owner',
    },
  });
  const store = await prisma.store.create({
    data: {
      name: `sale-test-${Date.now()}`,
      slug: `sale-test-${Date.now()}`,
      ownerId: OWNER,
    },
  });
  storeId = store.id;
  await seedCoaForStore(storeId);

  const p = await prisma.product.create({
    data: {
      storeId,
      name: 'Sale Test Product',
      slug: `sale-test-product-${Date.now()}`,
      price: 5000, // 5 KWD
      costPrice: 3000, // 3 KWD COGS
      inventory: 100,
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

describe('order payment posts a balanced journal entry', () => {
  it('posts DR Cash / CR Sales + COGS / Inventory on paid order', async () => {
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: `SALE-${Date.now()}`,
        status: 'confirmed',
        paymentStatus: 'paid',
        subtotal: 5000,
        tax: 0,
        shipping: 0,
        discount: 0,
        total: 5000,
        currency: 'KWD',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId,
              productName: 'Sale Test Product',
              quantity: 1,
              price: 5000,
              total: 5000,
              costPrice: 3000,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'myfatoorah',
              status: 'completed',
              amount: 5000,
              paidAt: new Date(),
            },
          ],
        },
      },
    });

    await postOrderPaymentJournal({ orderId: order.id });

    const entries = await prisma.journalEntry.findMany({
      where: { storeId, source: 'order' },
      include: { lines: true },
      orderBy: { entryNumber: 'asc' },
    });
    expect(entries.length).toBe(2);

    // Both entries must be balanced
    for (const e of entries) {
      const dr = e.lines.reduce((s, l) => s + l.debit, 0);
      const cr = e.lines.reduce((s, l) => s + l.credit, 0);
      expect(dr).toBe(cr);
      expect(dr).toBeGreaterThan(0);
    }

    // Cash/sales entry — DR Cash 5000, CR Revenue 5000
    const cashSales = entries.find(e => e.sourceId === order.id);
    expect(cashSales).toBeDefined();
    expect(cashSales!.lines.find(l => l.debit === 5000)).toBeDefined();
    expect(cashSales!.lines.find(l => l.credit === 5000)).toBeDefined();

    // COGS entry — DR COGS 3000, CR Inventory 3000
    const cogs = entries.find(e => e.sourceId === `${order.id}:cogs`);
    expect(cogs).toBeDefined();
    expect(cogs!.lines.find(l => l.debit === 3000)).toBeDefined();
    expect(cogs!.lines.find(l => l.credit === 3000)).toBeDefined();
  });

  it('idempotent — re-calling postOrderPaymentJournal does not double-post', async () => {
    const order = await prisma.order.findFirst({
      where: { storeId, paymentStatus: 'paid' },
    });
    if (!order) throw new Error('no paid order from previous test');
    const beforeCount = await prisma.journalEntry.count({
      where: { storeId, source: 'order' },
    });

    await postOrderPaymentJournal({ orderId: order.id });

    const afterCount = await prisma.journalEntry.count({
      where: { storeId, source: 'order' },
    });
    expect(afterCount).toBe(beforeCount);
  });

  it('split revenue/tax/shipping when present on the order', async () => {
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: `SPLIT-${Date.now()}`,
        status: 'confirmed',
        paymentStatus: 'paid',
        subtotal: 5000,
        tax: 250, // 5% imaginary tax
        shipping: 500,
        discount: 0,
        total: 5750,
        currency: 'KWD',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId,
              productName: 'Sale Test Product',
              quantity: 1,
              price: 5000,
              total: 5000,
              costPrice: 3000,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'tap', // → Cash Card (1010)
              status: 'completed',
              amount: 5750,
              paidAt: new Date(),
            },
          ],
        },
      },
    });

    await postOrderPaymentJournal({ orderId: order.id });

    const cashSales = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: order.id },
      include: { lines: true },
    });
    expect(cashSales).toBeDefined();
    // DR Cash 5750
    expect(cashSales!.lines.find(l => l.debit === 5750)).toBeDefined();
    // CR Sales Revenue 5000 (net of zero discount)
    expect(cashSales!.lines.find(l => l.credit === 5000)).toBeDefined();
    // CR Tax Payable 250
    expect(cashSales!.lines.find(l => l.credit === 250)).toBeDefined();
    // CR Shipping Income 500
    expect(cashSales!.lines.find(l => l.credit === 500)).toBeDefined();
    // Balanced
    const dr = cashSales!.lines.reduce((s, l) => s + l.debit, 0);
    const cr = cashSales!.lines.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBe(cr);
    expect(dr).toBe(5750);
  });
});
