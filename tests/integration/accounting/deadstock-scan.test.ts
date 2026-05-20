import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@force/database';

// vi.mock is hoisted by vitest before imports — must appear at module top-level.
vi.mock('../../../apps/api/src/services/accounting/gemini-ai.service', () => ({
  callGemini: vi.fn(async () => ({
    items: [
      {
        productId: 'mock-product-id',
        discountPercent: 25,
        copyEn: 'Test clearance',
        copyAr: 'تخفيض تجريبي',
      },
    ],
  })),
  callGeminiBatch: vi.fn(async () => []),
}));

import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { runDeadstockScan } from '../../../apps/api/src/services/accounting/deadstock-scan.service';

// Isolated OWNER — '...00ff' is not used by any other accounting test suite.
const OWNER = '00000000-0000-0000-0000-0000000000ff';
let storeId: string;
let deadProductId: string;
let freshProductId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `deadstock-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'D',
      lastName: 'S',
    },
  });

  const s = await prisma.store.create({
    data: {
      name: `deadstock-test-${Date.now()}`,
      slug: `deadstock-test-${Date.now()}`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
    },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);

  // Dead product: inventory=20, costPrice=5000 fils → value=100000 fils > 50000 threshold.
  // No paid sales ever → daysSinceSale = 9999 ≥ 90.
  const dead = await prisma.product.create({
    data: {
      storeId,
      name: 'Dead Stock Product',
      slug: `dead-${Date.now()}`,
      price: 10000,
      costPrice: 5000,
      inventory: 20,
      trackInventory: true,
      status: 'active',
    },
  });
  deadProductId = dead.id;

  // Fresh product: inventory=10, costPrice=3000 fils → value=30000 fils < 50000 threshold.
  // Has a recent paid order → daysSinceSale < 90.
  const fresh = await prisma.product.create({
    data: {
      storeId,
      name: 'Fresh Product',
      slug: `fresh-${Date.now()}`,
      price: 6000,
      costPrice: 3000,
      inventory: 10,
      trackInventory: true,
      status: 'active',
    },
  });
  freshProductId = fresh.id;

  // Seed a recent paid order for the fresh product (7 days ago — well within 90d threshold).
  const recentDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await prisma.order.create({
    data: {
      storeId,
      orderNumber: `DSS-FRESH-${Date.now()}`,
      status: 'confirmed',
      paymentStatus: 'paid',
      subtotal: 30000,
      tax: 0,
      shipping: 0,
      discount: 0,
      total: 30000,
      currency: 'KWD',
      shippingAddress: {},
      billingAddress: {},
      createdAt: recentDate,
      items: {
        create: [
          {
            productId: freshProductId,
            productName: 'Fresh Product',
            quantity: 5,
            price: 6000,
            total: 30000,
            costPrice: 3000,
          },
        ],
      },
    },
  });
});

afterAll(async () => {
  await prisma.deadStockFlag.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('deadstock scan', () => {
  it('flags dead product and skips fresh product', async () => {
    const result = await runDeadstockScan(storeId);

    // Service returns a structured result with at least the scanned count.
    expect(result.scanned).toBeGreaterThanOrEqual(1);

    const allFlags = await prisma.deadStockFlag.findMany({ where: { storeId } });

    // Dead product (no sales, value ≥ 50000 fils) MUST get a flag.
    const deadFlag = allFlags.find(f => f.productId === deadProductId);
    expect(deadFlag).toBeDefined();
    expect(deadFlag!.status).toBe('open');
    expect(deadFlag!.stockValueFils).toBeGreaterThanOrEqual(50_000);
    expect(deadFlag!.daysSinceSale).toBeGreaterThanOrEqual(90);

    // Fresh product (recent sale) MUST NOT be flagged.
    const freshFlag = allFlags.find(f => f.productId === freshProductId);
    expect(freshFlag).toBeUndefined();
  });

  it('result shape includes flagged count', async () => {
    // Run again to verify idempotent re-run still returns a valid shape.
    const result = await runDeadstockScan(storeId);
    expect(typeof result.scanned).toBe('number');
    expect(typeof result.flagged).toBe('number');
    expect(typeof result.expiredCount).toBe('number');
    expect(result.scanned).toBeGreaterThanOrEqual(0);
    expect(result.flagged).toBeGreaterThanOrEqual(0);
  });
});
