/**
 * Cost snapshot on order lines (audit 2026-09-30, finding 2).
 *
 * Checkout copied only the PARENT product's `costPrice` onto every order line,
 * so a variant product — whose cost the merchant enters per variant — sold
 * lines with no cost: no COGS journal, analytics profit 0. The admin manual
 * order path snapshotted no cost at all. Each line must now carry
 * `variant.costPrice ?? product.costPrice`, and that cost must reach the COGS
 * journal entry.
 *
 * Real Postgres; every fixture is per-test unique (retry-safe).
 */
import { describe, it, expect } from 'vitest';
import { prisma, withRlsBypass } from '@force/database';
import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';
import { seedCoaForStore } from '@api/services/accounting/account.service';
import { postOrderPaymentJournal } from '@api/services/accounting/posting/order-posting';
import {
  hasDb,
  seedBundleStore,
  seedBundle,
  cartSessionId,
  addBundleToCart,
  DEFAULT_TEST_SHIPPING_ADDRESS,
} from './../helpers/bundle-fixtures';

const uid = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

async function seedCostFixtures(storeId: string, suffix: string) {
  return withRlsBypass(async tx => {
    const variantProduct = await tx.product.create({
      data: {
        storeId,
        name: `cost-variant-product-${suffix}`,
        slug: `cost-variant-product-${suffix}`,
        price: 3000,
        costPrice: 1500, // the parent's cost — only the FALLBACK for variant lines
        inventory: 0,
        hasVariants: true,
        status: 'active',
        variants: {
          create: [
            { title: 'Costed', price: 3000, costPrice: 700, inventory: 20 },
            { title: 'Uncosted', price: 3000, costPrice: null, inventory: 20 },
          ],
        },
      },
      include: { variants: true },
    });
    const simple = await tx.product.create({
      data: {
        storeId,
        name: `cost-simple-product-${suffix}`,
        slug: `cost-simple-product-${suffix}`,
        price: 2000,
        costPrice: 500,
        inventory: 20,
        status: 'active',
      },
    });
    const costed = variantProduct.variants.find(v => v.title === 'Costed')!;
    const uncosted = variantProduct.variants.find(v => v.title === 'Uncosted')!;
    return { variantProductId: variantProduct.id, costed, uncosted, simpleId: simple.id };
  });
}

describe.skipIf(!hasDb)('order lines snapshot the variant cost (finding 2)', () => {
  it('checkout: a variant line takes the variant cost, falling back to the parent', async () => {
    const suffix = uid();
    const store = await seedBundleStore(suffix);
    const fx = await seedCostFixtures(store.storeId, suffix);

    const sessionId = cartSessionId('variant-cost-checkout');
    await CartService.getOrCreate(store.storeId, sessionId);
    await CartService.addItem(
      store.storeId,
      sessionId,
      fx.variantProductId,
      2,
      undefined,
      fx.costed.id
    );
    await CartService.addItem(
      store.storeId,
      sessionId,
      fx.variantProductId,
      1,
      undefined,
      fx.uncosted.id
    );
    await CartService.addItem(store.storeId, sessionId, fx.simpleId, 1);

    const order = await OrderService.create(store.storeId, undefined, sessionId, {
      shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
      paymentMethod: 'paymob',
    });

    const byLine = (variantId: string | null, productId: string) =>
      order.items.find(i => i.variantId === variantId && i.productId === productId)!;
    expect(byLine(fx.costed.id, fx.variantProductId).costPrice).toBe(700);
    expect(byLine(fx.uncosted.id, fx.variantProductId).costPrice).toBe(1500);
    expect(byLine(null, fx.simpleId).costPrice).toBe(500);

    // The snapshot is what feeds COGS: posting the paid order books
    // 2×700 + 1×1500 + 1×500 = 3400 to 5000 COGS.
    await seedCoaForStore(store.storeId);
    await withRlsBypass(tx =>
      tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'paid' } })
    );
    await postOrderPaymentJournal({ orderId: order.id });
    const cogs = await withRlsBypass(tx =>
      tx.journalEntry.findFirst({
        where: { storeId: store.storeId, source: 'order', sourceId: `${order.id}:cogs` },
        include: { lines: true },
      })
    );
    expect(cogs).not.toBeNull();
    expect(cogs!.lines.reduce((s, l) => s + l.debit, 0)).toBe(3400);
  });

  it('bundle component lines take the component variant cost', async () => {
    const suffix = uid();
    const store = await seedBundleStore(suffix);
    const fx = await seedCostFixtures(store.storeId, suffix);
    const bundleId = await seedBundle(store.storeId, suffix, {
      pricingType: 'fixed_price',
      pricingValue: 4000,
      items: [
        { productId: fx.variantProductId, variantId: fx.costed.id, quantity: 1 },
        { productId: fx.simpleId, quantity: 1 },
      ],
    });
    const sessionId = cartSessionId('variant-cost-bundle');
    await CartService.getOrCreate(store.storeId, sessionId);
    await addBundleToCart(store.storeId, sessionId, bundleId, 1);
    const order = await OrderService.create(store.storeId, undefined, sessionId, {
      shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
      paymentMethod: 'paymob',
    });
    expect(order.items.find(i => i.variantId === fx.costed.id)!.costPrice).toBe(700);
    expect(order.items.find(i => i.productId === fx.simpleId)!.costPrice).toBe(500);
  });

  it('admin manual order: lines snapshot cost (they had none at all)', async () => {
    const suffix = uid();
    const store = await seedBundleStore(suffix);
    const fx = await seedCostFixtures(store.storeId, suffix);
    const order = await OrderService.createAdminOrder(store.storeId, store.ownerId, {
      shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
      items: [
        { productId: fx.variantProductId, variantId: fx.costed.id, quantity: 1 },
        { productId: fx.variantProductId, variantId: fx.uncosted.id, quantity: 1 },
        { productId: fx.simpleId, quantity: 1 },
      ],
      paymentMethod: 'cod',
    });
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items.find(i => i.variantId === fx.costed.id)!.costPrice).toBe(700);
    expect(items.find(i => i.variantId === fx.uncosted.id)!.costPrice).toBe(1500);
    expect(items.find(i => i.productId === fx.simpleId)!.costPrice).toBe(500);
  });
});
