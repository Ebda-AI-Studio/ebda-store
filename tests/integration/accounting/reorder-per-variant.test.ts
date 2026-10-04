/**
 * Owner decision 2026-10-01 — reorder suggestions per VARIANT.
 *
 * Before: the scan produced one suggestion per product, so a variant product
 * got a product-level suggestion; drafting a PO from it created a line with no
 * variant, and receiving that line wrote the parent `products.inventory`
 * column — which must stay 0 for a variant product
 * (docs/architecture/inventory-model.md).
 *
 * After, proven here against a real Postgres:
 *   - one suggestion per ACTIVE variant of a variant product, one per product
 *     with no variants; dedupe key (store, product, variant);
 *   - a legacy open product-level suggestion for a variant product (and an
 *     open one for a since-disabled variant) is expired by the scan itself;
 *   - drafting a PO from a variant suggestion carries the variant and its cost,
 *     and receiving it moves the variant's stock, never the parent's;
 *   - a PO line for a variant product without a variantId is refused at draft
 *     AND at receive (the old shape), and a variant must belong to its line's
 *     product.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@force/database';

vi.mock('../../../apps/api/src/services/accounting/gemini-ai.service', () => ({
  callGemini: vi.fn(async () => ({ items: [] })),
  callGeminiBatch: vi.fn(async () => []),
}));

import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { createSupplier } from '../../../apps/api/src/services/accounting/supplier.service';
import { runReorderScan } from '../../../apps/api/src/services/accounting/reorder-scan.service';
import {
  createPoFromSuggestion,
  createPurchaseOrder,
  receivePurchaseOrder,
} from '../../../apps/api/src/services/accounting/purchase-order.service';

const OWNER = '00000000-0000-0000-0000-0000000006a7';
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let storeId: string;
let supplierId: string;
let variantProductId: string;
let plainProductId: string;
let lowVariantId: string; // active, low, selling
let secondLowVariantId: string; // a SECOND low variant of the same product
let healthyVariantId: string; // active, plenty of stock
let disabledVariantId: string; // disabled — never a unit
let legacyProductLevelSugId: string;
let disabledVariantSugId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `reorder-variant-${uid()}@x.test`,
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'V',
    },
  });
  const s = await prisma.store.create({
    data: {
      name: `reorder-variant-${uid()}`,
      slug: `reorder-variant-${uid()}`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
    },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);
  supplierId = (await createSupplier({ storeId, name: `Variant Supplier ${uid()}` })).id;

  const vp = await prisma.product.create({
    data: {
      storeId,
      name: 'Variant Reorder Product',
      slug: `variant-reorder-${uid()}`,
      price: 5000,
      costPrice: 3000, // parent cost: only the fallback
      inventory: 0, // the invariant: a variant product's parent column stays 0
      hasVariants: true,
      lowStockThreshold: 10,
      trackInventory: true,
      status: 'active',
      variants: {
        create: [
          { title: 'Small', titleAr: 'صغير', sku: 'VR-S', inventory: 2, costPrice: 2000 },
          { title: 'Medium', titleAr: 'وسط', sku: 'VR-M', inventory: 1, costPrice: 2200 },
          { title: 'Large', titleAr: 'كبير', sku: 'VR-L', inventory: 500, costPrice: 2500 },
          { title: 'Retired', inventory: 1, costPrice: 1000, isActive: false },
        ],
      },
    },
    include: { variants: true },
  });
  variantProductId = vp.id;
  lowVariantId = vp.variants.find(v => v.title === 'Small')!.id;
  secondLowVariantId = vp.variants.find(v => v.title === 'Medium')!.id;
  healthyVariantId = vp.variants.find(v => v.title === 'Large')!.id;
  disabledVariantId = vp.variants.find(v => v.title === 'Retired')!.id;

  // Product-level rule with a preferred supplier — each variant falls back to it.
  await prisma.reorderRule.create({
    data: {
      storeId,
      productId: variantProductId,
      variantId: null,
      minQty: 10,
      reorderQty: 20,
      leadTimeDays: 7,
      safetyStockDays: 7,
      preferredSupplierId: supplierId,
    },
  });

  const plain = await prisma.product.create({
    data: {
      storeId,
      name: 'Plain Reorder Product',
      slug: `plain-reorder-${uid()}`,
      price: 3000,
      costPrice: 1500,
      inventory: 1,
      lowStockThreshold: 10,
      trackInventory: true,
      status: 'active',
    },
  });
  plainProductId = plain.id;

  // 10 units of SMALL and 7 of MEDIUM sold 3 days ago → only they have velocity.
  // Two open suggestions on ONE product is what proves the dedupe key
  // includes the variant: keyed on (store, product) they would collapse.
  await prisma.order.create({
    data: {
      storeId,
      orderNumber: `RV-${uid()}`,
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
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      items: {
        create: [
          {
            productId: variantProductId,
            variantId: lowVariantId,
            productName: 'Variant Reorder Product',
            variantName: 'Small',
            quantity: 10,
            price: 5000,
            total: 50000,
            costPrice: 2000,
          },
          {
            productId: variantProductId,
            variantId: secondLowVariantId,
            productName: 'Variant Reorder Product',
            variantName: 'Medium',
            quantity: 7,
            price: 5000,
            total: 35000,
            costPrice: 2200,
          },
        ],
      },
    },
  });

  // The pre-2026-10-01 shape still sitting open in production: a
  // product-level suggestion for a variant product, and one for a variant
  // that has since been disabled.
  const legacyBase = {
    storeId,
    productId: variantProductId,
    suggestedQty: 40,
    velocity7d: 1,
    velocity28d: 1,
    onHand: 0,
    onOrder: 0,
    openBacklog: 0,
    urgencyDays: 0,
    reasoningEn: 'legacy',
    status: 'open' as const,
    scannedAt: new Date(),
  };
  legacyProductLevelSugId = (
    await prisma.reorderSuggestion.create({ data: { ...legacyBase, variantId: null } })
  ).id;
  disabledVariantSugId = (
    await prisma.reorderSuggestion.create({
      data: { ...legacyBase, variantId: disabledVariantId, scannedAt: new Date(Date.now() - 1) },
    })
  ).id;
});

afterAll(async () => {
  await prisma.reorderSuggestion.deleteMany({ where: { storeId } });
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.purchaseOrderItem.deleteMany({ where: { po: { storeId } } });
  await prisma.purchaseOrder.deleteMany({ where: { storeId } });
  await prisma.inventoryHistory.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.reorderRule.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.supplier.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

const openRows = () =>
  prisma.reorderSuggestion.findMany({
    where: { storeId, status: 'open' },
    orderBy: { productId: 'asc' },
  });

describe('reorder scan — one suggestion per active variant', () => {
  it('suggests each low variant (not the product, not the healthy or disabled variant) and the plain product', async () => {
    const result = await runReorderScan(storeId);

    const open = await openRows();
    const units = open.map(r => `${r.productId}:${r.variantId ?? 'null'}`).sort();
    expect(units).toEqual(
      [
        `${variantProductId}:${lowVariantId}`,
        `${variantProductId}:${secondLowVariantId}`,
        `${plainProductId}:null`,
      ].sort()
    );

    const low = open.find(r => r.variantId === lowVariantId)!;
    // The VARIANT's own stock, not the product sum (2 + 500) and not the parent 0.
    expect(low.onHand).toBe(2);
    // velocity from the variant's own sales: 10 units / 7 days.
    expect(low.velocity7d).toBeCloseTo(10 / 7, 5);
    // The product-level rule applies as the variant's fallback.
    expect(low.supplierId).toBe(supplierId);
    expect(low.suggestedQty).toBeGreaterThanOrEqual(20);
    expect(open.find(r => r.variantId === secondLowVariantId)!.onHand).toBe(1);

    // No suggestion for a product row of a variant product, for the healthy
    // variant, or for the disabled one.
    expect(open.some(r => r.productId === variantProductId && r.variantId === null)).toBe(false);
    expect(open.some(r => r.variantId === healthyVariantId)).toBe(false);
    expect(open.some(r => r.variantId === disabledVariantId)).toBe(false);

    // Both legacy rows were expired by the scan itself (no prod script).
    const legacy = await prisma.reorderSuggestion.findMany({
      where: { id: { in: [legacyProductLevelSugId, disabledVariantSugId] } },
      select: { status: true },
    });
    expect(legacy.map(r => r.status)).toEqual(['expired', 'expired']);
    expect(result.expiredCount).toBeGreaterThanOrEqual(2);
  });

  it('re-running refreshes the same row per (store, product, variant)', async () => {
    const before = await openRows();
    await runReorderScan(storeId);
    await runReorderScan(storeId);
    const after = await openRows();
    expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort());
  });
});

describe('drafting and receiving a PO from a variant suggestion', () => {
  it('carries the variant and its cost; receiving moves the variant, never the parent column', async () => {
    const sug = (await openRows()).find(r => r.variantId === lowVariantId)!;
    const po = await createPoFromSuggestion(sug.id, storeId);

    expect(po.items).toHaveLength(1);
    expect(po.items[0].productId).toBe(variantProductId);
    expect(po.items[0].variantId).toBe(lowVariantId);
    // Cost follows the row that holds the stock: the variant's 2000, not the parent's 3000.
    expect(po.items[0].unitCost).toBe(2000);

    const accepted = await prisma.reorderSuggestion.findUniqueOrThrow({ where: { id: sug.id } });
    expect(accepted.status).toBe('accepted');
    expect(accepted.poId).toBe(po.id);

    await receivePurchaseOrder({
      storeId,
      poId: po.id,
      receipts: [{ poItemId: po.items[0].id, qtyReceived: po.items[0].qty }],
    });

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: lowVariantId } });
    expect(variant.inventory).toBe(2 + po.items[0].qty);
    const parent = await prisma.product.findUniqueOrThrow({ where: { id: variantProductId } });
    expect(parent.inventory).toBe(0);
  });

  it('refuses to draft from a legacy product-level suggestion on a variant product (409)', async () => {
    const legacy = await prisma.reorderSuggestion.create({
      data: {
        storeId,
        productId: variantProductId,
        variantId: null,
        suggestedQty: 5,
        velocity7d: 0,
        velocity28d: 0,
        onHand: 0,
        onOrder: 0,
        openBacklog: 0,
        urgencyDays: 0,
        supplierId,
        reasoningEn: 'legacy',
        status: 'open',
        scannedAt: new Date(Date.now() + 1000),
      },
    });
    await expect(createPoFromSuggestion(legacy.id, storeId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SUGGESTION_OUTDATED',
    });
    const still = await prisma.reorderSuggestion.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(still.status).toBe('open'); // untouched — the next scan expires it
    await prisma.reorderSuggestion.delete({ where: { id: legacy.id } });
  });
});

describe('PO line guard — a variant product line must name its variant', () => {
  it('refuses a variant-less line for a variant product at draft (400 VARIANT_REQUIRED)', async () => {
    await expect(
      createPurchaseOrder({
        storeId,
        supplierId,
        items: [{ productId: variantProductId, qty: 5, unitCost: 2000 }],
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'VARIANT_REQUIRED' });
  });

  it("refuses a variant that belongs to a different product than the line's (400)", async () => {
    await expect(
      createPurchaseOrder({
        storeId,
        supplierId,
        items: [{ productId: plainProductId, variantId: lowVariantId, qty: 5, unitCost: 2000 }],
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'VARIANT_PRODUCT_MISMATCH' });
  });

  it('still accepts a plain product line with no variant (control)', async () => {
    const po = await createPurchaseOrder({
      storeId,
      supplierId,
      items: [{ productId: plainProductId, qty: 3, unitCost: 1500 }],
    });
    expect(po.items[0].variantId).toBeNull();
  });

  it('refuses to RECEIVE an old-shape variant-less line and leaves the parent column at 0', async () => {
    // Written directly: the draft path now refuses this shape, but POs drafted
    // before the guard still exist.
    const po = await prisma.purchaseOrder.create({
      data: {
        storeId,
        supplierId,
        poNumber: `PO-OLD-${uid()}`,
        status: 'sent',
        subtotal: 10000,
        total: 10000,
        items: {
          create: [{ productId: variantProductId, qty: 5, unitCost: 2000, total: 10000 }],
        },
      },
      include: { items: true },
    });
    await expect(
      receivePurchaseOrder({
        storeId,
        poId: po.id,
        receipts: [{ poItemId: po.items[0].id, qtyReceived: 5 }],
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'VARIANT_REQUIRED' });

    const parent = await prisma.product.findUniqueOrThrow({ where: { id: variantProductId } });
    expect(parent.inventory).toBe(0);
    const item = await prisma.purchaseOrderItem.findUniqueOrThrow({
      where: { id: po.items[0].id },
    });
    expect(item.qtyReceived).toBe(0);
  });
});
