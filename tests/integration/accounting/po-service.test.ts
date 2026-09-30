import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { createSupplier } from '../../../apps/api/src/services/accounting/supplier.service';
import {
  createPurchaseOrder,
  receivePurchaseOrder,
} from '../../../apps/api/src/services/accounting/purchase-order.service';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
let storeId: string;
let supplierId: string;
let productId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `po-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'P',
      lastName: 'O',
    },
  });
  const s = await prisma.store.create({
    data: { name: `po-test-${Date.now()}`, slug: `po-test-${Date.now()}`, ownerId: OWNER },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);
  const sup = await createSupplier({ storeId, name: 'Test Supplier' });
  supplierId = sup.id;
  const p = await prisma.product.create({
    data: {
      storeId,
      name: 'WAC Test',
      slug: `wac-${Date.now()}`,
      price: 5000,
      costPrice: 2000,
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
  await prisma.purchaseOrderItem.deleteMany({ where: { po: { storeId } } });
  await prisma.purchaseOrder.deleteMany({ where: { storeId } });
  await prisma.supplier.deleteMany({ where: { storeId } });
  await prisma.inventoryHistory.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('PO receive — WAC recompute', () => {
  it('updates Product.costPrice to weighted-average after receipt', async () => {
    // Setup: product has 100 units @ 2.000 cost. Receive 50 @ 2.400.
    // New WAC = ((100 * 2000) + (50 * 2400)) / 150 = 320000 / 150 = 2133 (Int math)
    const po = await createPurchaseOrder({
      storeId,
      supplierId,
      items: [{ productId, qty: 50, unitCost: 2400 }],
    });
    const result = await receivePurchaseOrder({
      storeId,
      poId: po.id,
      receipts: [{ poItemId: po.items[0].id, qtyReceived: 50 }],
    });
    expect(result.po.status).toBe('received');

    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(product?.inventory).toBe(150);
    // WAC = ((100*2000) + (50*2400)) / 150 = 320000/150 = 2133.333... → Int 2133
    expect(product?.costPrice).toBe(2133);
    expect(product?.lastCostUpdateAt).not.toBeNull();
  });
});

describe('PO receive — a variant line writes its cost to the VARIANT', () => {
  it('weighted-averages against the variant own stock + cost and leaves the parent cost alone', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const vp = await prisma.product.create({
      data: {
        storeId,
        name: 'Variant WAC Test',
        slug: `variant-wac-${suffix}`,
        price: 5000,
        costPrice: 3000, // parent: only the fallback for variants with no cost
        inventory: 0,
        hasVariants: true,
        status: 'active',
        variants: {
          create: [
            { title: 'Costed', costPrice: 1000, inventory: 10 },
            { title: 'Uncosted', costPrice: null, inventory: 0 },
          ],
        },
      },
      include: { variants: true },
    });
    const costed = vp.variants.find(v => v.title === 'Costed')!;
    const uncosted = vp.variants.find(v => v.title === 'Uncosted')!;

    const po = await createPurchaseOrder({
      storeId,
      supplierId,
      items: [
        { productId: vp.id, variantId: costed.id, qty: 10, unitCost: 2000 },
        { productId: vp.id, variantId: uncosted.id, qty: 5, unitCost: 4000 },
      ],
    });
    await receivePurchaseOrder({
      storeId,
      poId: po.id,
      receipts: po.items.map(i => ({ poItemId: i.id, qtyReceived: i.qty })),
    });

    const after = await prisma.productVariant.findMany({ where: { productId: vp.id } });
    const a = after.find(v => v.id === costed.id)!;
    const b = after.find(v => v.id === uncosted.id)!;
    // (10 × 1000 + 10 × 2000) / 20
    expect(a.costPrice).toBe(1500);
    expect(a.inventory).toBe(20);
    // No stock and no cost of its own → this receipt's cost.
    expect(b.costPrice).toBe(4000);
    expect(b.inventory).toBe(5);

    const parent = await prisma.product.findUniqueOrThrow({ where: { id: vp.id } });
    expect(parent.costPrice).toBe(3000);
    expect(parent.inventory).toBe(0);
    expect(parent.lastCostUpdateAt).not.toBeNull();
  });
});
