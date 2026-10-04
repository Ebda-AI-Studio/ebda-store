import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@force/database';

// vi.mock is hoisted by vitest before imports — must appear at module top-level.
// The path resolves to the same module that reorder-scan.service.ts imports via './gemini-ai.service'.
vi.mock('../../../apps/api/src/services/accounting/gemini-ai.service', () => ({
  callGemini: vi.fn(async () => ({
    items: [
      {
        productId: 'mock-product-id',
        reasoningEn: 'AI test reasoning EN',
        reasoningAr: 'AI test reasoning AR',
      },
    ],
  })),
  callGeminiBatch: vi.fn(async () => []),
}));

import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { runReorderScan } from '../../../apps/api/src/services/accounting/reorder-scan.service';

// Dedicated owner UUID — isolated from all other accounting test suites.
// NOTE: '...0000aa' is used by accounting-expense-lifecycle; use a fresh suffix.
const OWNER = '00000000-0000-0000-0000-0000000000ee';
let storeId: string;
let lowStockProductId: string;
let healthyProductId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `reorder-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'O',
    },
  });

  const s = await prisma.store.create({
    data: {
      name: `reorder-test-${Date.now()}`,
      slug: `reorder-test-${Date.now()}`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
    },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);

  // Product 1: needs reorder — low on-hand, threshold high, has sales velocity.
  const lowStock = await prisma.product.create({
    data: {
      storeId,
      name: 'Low Stock Test Product',
      slug: `low-${Date.now()}`,
      price: 5000,
      costPrice: 2000,
      inventory: 2, // very low
      lowStockThreshold: 10, // minQty=10 (no ReorderRule → uses this)
      trackInventory: true,
      status: 'active',
    },
  });
  lowStockProductId = lowStock.id;

  // Product 2: healthy — abundant stock, threshold low.
  const healthy = await prisma.product.create({
    data: {
      storeId,
      name: 'Healthy Stock Product',
      slug: `healthy-${Date.now()}`,
      price: 3000,
      costPrice: 1500,
      inventory: 500,
      lowStockThreshold: 5,
      trackInventory: true,
      status: 'active',
    },
  });
  healthyProductId = healthy.id;

  // Seed 10 units sold 5 days ago for the low-stock product.
  // 5 days ago is within the 7-day window → velocity7d = 10/7 ≈ 1.43/day.
  // demandDuringLead = 1.43 * (7+7) ≈ 20 → projectedStock = 2 - 20 = -18 < 10 → candidate.
  const orderDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  await prisma.order.create({
    data: {
      storeId,
      orderNumber: `REORDER-VEL-${Date.now()}`,
      status: 'confirmed',
      paymentStatus: 'paid',
      subtotal: 50000,
      tax: 0,
      shipping: 0,
      discount: 0,
      total: 50000,
      currency: 'EGP',
      shippingAddress: {},
      billingAddress: {},
      createdAt: orderDate,
      items: {
        create: [
          {
            productId: lowStockProductId,
            productName: 'Low Stock Test Product',
            quantity: 10,
            price: 5000,
            total: 50000,
            costPrice: 2000,
          },
        ],
      },
    },
  });
});

afterAll(async () => {
  await prisma.reorderSuggestion.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
  // Leave the user row — other tests may reuse upserted users.
});

describe('reorder scan', () => {
  it('creates ReorderSuggestion for low-stock product with sales velocity and skips healthy products', async () => {
    const result = await runReorderScan(storeId);

    // At least the 2 seeded products were evaluated.
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.suggested).toBeGreaterThanOrEqual(1);

    const suggestions = await prisma.reorderSuggestion.findMany({
      where: { storeId, status: 'open' },
    });

    // Low-stock product MUST get an open suggestion.
    const lowStockSug = suggestions.find(s => s.productId === lowStockProductId);
    expect(lowStockSug).toBeDefined();

    // Healthy product (inventory=500, threshold=5, no sales velocity outside lead) MUST NOT.
    const healthySug = suggestions.find(s => s.productId === healthyProductId);
    expect(healthySug).toBeUndefined();

    // Spot-check the suggestion fields.
    expect(lowStockSug!.suggestedQty).toBeGreaterThan(0);
    expect(lowStockSug!.urgencyDays).toBeGreaterThanOrEqual(0);
    expect(lowStockSug!.reasoningEn).toBeTruthy();
    expect(lowStockSug!.onHand).toBe(2);
  });

  it("re-running refreshes the item's ONE open suggestion instead of adding another", async () => {
    // Before 2026-09-30 the upsert looked the row up by the per-run scannedAt,
    // so every daily run inserted a new open suggestion for the same item —
    // 4156 open suggestions for 143 items on a live store. The scan must now
    // find the item's existing OPEN suggestion and refresh it (scannedAt too).
    const openFor = () =>
      prisma.reorderSuggestion.findMany({
        where: { storeId, productId: lowStockProductId, status: 'open' },
      });

    const before = await openFor();
    expect(before).toHaveLength(1);

    await new Promise(r => setTimeout(r, 5)); // distinct scannedAt
    await runReorderScan(storeId);
    await runReorderScan(storeId);

    const after = await openFor();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].scannedAt.getTime()).toBeGreaterThan(before[0].scannedAt.getTime());
  });

  it('a dismissed suggestion is not reopened — the next run creates a fresh open one', async () => {
    await prisma.reorderSuggestion.updateMany({
      where: { storeId, productId: lowStockProductId, status: 'open' },
      data: { status: 'dismissed' },
    });
    await runReorderScan(storeId);
    const rows = await prisma.reorderSuggestion.findMany({
      where: { storeId, productId: lowStockProductId },
    });
    expect(rows.filter(r => r.status === 'dismissed')).toHaveLength(1);
    expect(rows.filter(r => r.status === 'open')).toHaveLength(1);
  });
});
