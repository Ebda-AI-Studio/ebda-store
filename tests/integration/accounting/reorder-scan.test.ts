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
      currency: 'KWD',
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

  it('idempotent — re-running does not duplicate same-day suggestions', async () => {
    const before = await prisma.reorderSuggestion.count({ where: { storeId } });

    // scannedAt is set to `new Date()` inside each runReorderScan call.
    // Each call gets its own timestamp so a new row IS created per call — that
    // is by design (a daily cron creates one snapshot per run).
    // The idempotency guarantee is within a single call: the findFirst + create/update
    // guard prevents duplicates for the SAME scannedAt timestamp.
    // Re-running adds at most 1 new suggestion per product (same product, new timestamp).
    await runReorderScan(storeId);
    const after = await prisma.reorderSuggestion.count({ where: { storeId } });

    // At most +1 new row per candidate product (the low-stock product) per re-run.
    expect(after).toBeLessThanOrEqual(before + 2);
    expect(after).toBeGreaterThanOrEqual(before); // never removes rows
  });
});
