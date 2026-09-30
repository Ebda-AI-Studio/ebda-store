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
let costlessProductId: string;
let variantProductId: string;
let newProductId: string;
const bulkIds: string[] = [];

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

  // Costless product: in stock, never sold, NO cost price. Before 2026-09-30
  // the scan filtered on costPrice > 0 and never saw it, which made the scan
  // blind on stores that never entered costs. It must be flagged with an
  // UNKNOWN (null) stock value — not skipped, and not valued at 0.
  const costless = await prisma.product.create({
    data: {
      storeId,
      name: 'Costless Product',
      slug: `costless-${Date.now()}`,
      price: 4000,
      inventory: 12,
      trackInventory: true,
      status: 'active',
    },
  });
  costlessProductId = costless.id;

  // Variant product: the cost lives on the variants, the parent has none.
  // Valued per active variant at the variant's own cost (STOCK_VALUE_SQL rule,
  // ruling AP-10): 10×3000 + 10×4000 = 70000. The disabled variant is not
  // stock. Valuing at the parent cost alone made this "unknown".
  const variantProduct = await prisma.product.create({
    data: {
      storeId,
      name: 'Variant Product',
      slug: `variant-${Date.now()}`,
      price: 9000,
      inventory: 0,
      trackInventory: true,
      status: 'active',
      variants: {
        create: [
          { title: 'S', price: 9000, inventory: 10, costPrice: 3000 },
          { title: 'M', price: 9000, inventory: 10, costPrice: 4000 },
          { title: 'L', price: 9000, inventory: 50, costPrice: 9000, isActive: false },
        ],
      },
    },
  });
  variantProductId = variantProduct.id;

  // Issue 2271: a never-sold product is aged from its LISTING date. The
  // fixtures above that must be flagged as never-sold dead stock were listed
  // 120 days ago; the one below was listed today and must NOT be flagged.
  const listed120dAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
  await prisma.product.updateMany({
    where: { id: { in: [deadProductId, costlessProductId, variantProductId] } },
    data: { createdAt: listed120dAgo },
  });
  const brandNew = await prisma.product.create({
    data: {
      storeId,
      name: 'Brand New Product',
      slug: `brand-new-${Date.now()}`,
      price: 4000,
      inventory: 12,
      trackInventory: true,
      status: 'active',
    },
  });
  newProductId = brandNew.id;

  // Issue 2259: enough aged candidates to span more than one phase-3 chunk
  // (25 per transaction), so "one OPEN flag per product" is exercised across
  // a chunk boundary.
  for (let i = 0; i < 30; i++) {
    const p = await prisma.product.create({
      data: {
        storeId,
        name: `Bulk Stale ${i}`,
        slug: `bulk-stale-${i}-${Date.now()}`,
        price: 1000,
        inventory: 3,
        trackInventory: true,
        status: 'active',
        createdAt: listed120dAgo,
      },
    });
    bulkIds.push(p.id);
  }

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

  it('flags a never-sold product with no cost price, value unknown (null)', async () => {
    const flags = await prisma.deadStockFlag.findMany({
      where: { storeId, productId: costlessProductId },
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].status).toBe('open');
    expect(flags[0].stockValueFils).toBeNull();
    expect(flags[0].stockOnHand).toBe(12);
  });

  it('does NOT flag a never-sold product listed less than 90 days ago (issue 2271)', async () => {
    const flags = await prisma.deadStockFlag.findMany({
      where: { storeId, productId: newProductId },
    });
    expect(flags).toHaveLength(0);
  });

  it("values a variant product at each active variant's own cost", async () => {
    const flags = await prisma.deadStockFlag.findMany({
      where: { storeId, productId: variantProductId },
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].stockOnHand).toBe(20);
    expect(flags[0].stockValueFils).toBe(70_000);
  });

  it("re-running refreshes each product's ONE open flag instead of adding another", async () => {
    // Before 2026-09-30 the lookup keyed on the per-run scannedAt, so every
    // weekly run inserted another open flag (5 open cards for 1 product live).
    const openFor = (productId: string) =>
      prisma.deadStockFlag.findMany({ where: { storeId, productId, status: 'open' } });
    const before = await openFor(deadProductId);
    expect(before).toHaveLength(1);

    await new Promise(r => setTimeout(r, 5)); // distinct scannedAt
    await runDeadstockScan(storeId);
    await runDeadstockScan(storeId);

    const after = await openFor(deadProductId);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].scannedAt.getTime()).toBeGreaterThan(before[0].scannedAt.getTime());
    expect(await openFor(costlessProductId)).toHaveLength(1);
    // Across the phase-3 chunk boundary too (issue 2259): every bulk product
    // has exactly one open flag after three runs.
    const bulkOpen = await prisma.deadStockFlag.groupBy({
      by: ['productId'],
      where: { storeId, productId: { in: bulkIds }, status: 'open' },
      _count: { _all: true },
    });
    expect(bulkOpen).toHaveLength(30);
    expect(bulkOpen.every(g => g._count._all === 1)).toBe(true);
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
