/**
 * X-02 fix round (W1b review Critical 1, Important 1-2), over HTTP against the
 * API running as `ebda_app`. The storefront and the server agree on:
 *
 *  1. a sized product whose PRODUCT flag allows backorders (the merchant bulk
 *     toggle) and whose sold-out variant's own flag is the default false: the
 *     PDP payload offers a pre-order, AND add to cart, a quantity change and
 *     checkout all succeed with a BackorderLine;
 *  2. the store's `inventory.backorder` feature OFF: the payload shows the size
 *     sold out (no pre-order), AND the cart refuses it;
 *  3. untracked stock (`trackInventory: false`) at 0: the payload reads in
 *     stock, AND the cart accepts it.
 *
 * Retry-safe: every fixture is keyed on a per-CALL suffix.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { API_BASE } from '../helpers/api-base';
import { hasDb, cartSessionId, DEFAULT_TEST_SHIPPING_ADDRESS } from '../helpers/bundle-fixtures';

const created: { storeIds: string[]; userIds: string[] } = { storeIds: [], userIds: [] };

async function seed(opts: { feature: boolean }) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.create({
    data: {
      email: `bo-inherit-${suffix}@test.local`,
      passwordHash: 'x',
      firstName: 'Bo',
      lastName: 'Inherit',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `Bo inherit ${suffix}`,
      slug: `bo-inherit-${suffix}`,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
      marketingPixels: {},
    },
  });
  created.storeIds.push(store.id);
  await prisma.storeFeature.create({
    data: { storeId: store.id, featureKey: 'inventory.backorder', enabled: opts.feature },
  });
  const sized = await prisma.product.create({
    data: {
      storeId: store.id,
      name: `bo-sized-${suffix}`,
      slug: `bo-sized-${suffix}`,
      price: 2500,
      inventory: 0,
      trackInventory: true,
      allowBackorder: true, // the PRODUCT flag only
      hasVariants: true,
      status: 'active',
    },
  });
  const soldOut = await prisma.productVariant.create({
    data: {
      productId: sized.id,
      title: 'S',
      price: 2500,
      inventory: 0,
      allowBackorder: false, // schema default: the variant inherits
      isActive: true,
    },
  });
  await prisma.productVariant.create({
    data: { productId: sized.id, title: 'M', price: 2500, inventory: 3, isActive: true },
  });
  const untracked = await prisma.product.create({
    data: {
      storeId: store.id,
      name: `bo-untracked-${suffix}`,
      slug: `bo-untracked-${suffix}`,
      price: 1500,
      inventory: 0,
      trackInventory: false,
      allowBackorder: false,
      status: 'active',
    },
  });
  return { storeId: store.id, sized, soldOutId: soldOut.id, untracked };
}

afterAll(async () => {
  if (!hasDb) return;
  const storeIds = created.storeIds;
  await prisma.backorderLine.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.inventoryHistory.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId: { in: storeIds } } } });
  await prisma.order.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.cartItem.deleteMany({ where: { cart: { storeId: { in: storeIds } } } });
  await prisma.cart.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.productVariant.deleteMany({ where: { product: { storeId: { in: storeIds } } } });
  await prisma.product.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.storeFeature.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

const hdr = (storeId: string, tag: string) => ({
  'Content-Type': 'application/json',
  'x-store-id': storeId,
  'x-session-id': cartSessionId(tag),
});

async function pdpVariant(storeId: string, slug: string, variantId: string) {
  const res = await fetch(`${API_BASE}/public/products/${slug}`, {
    headers: { 'x-store-id': storeId },
  });
  const body = (await res.json()) as {
    data: { product: { inStock: boolean; variants: Array<Record<string, unknown>> } };
  };
  return {
    product: body.data.product,
    variant: body.data.product.variants.find(v => v.id === variantId),
  };
}

describe.skipIf(!hasDb)('backorder: one rule for the storefront and the server', () => {
  it('product-flag backorder on a sold-out size: offered, added, re-quantified, checked out', async () => {
    const { storeId, sized, soldOutId } = await seed({ feature: true });
    const { variant } = await pdpVariant(storeId, sized.slug, soldOutId);
    expect(variant).toMatchObject({ inStock: false, acceptsBackorder: true });

    const headers = hdr(storeId, 'bo-inherit');
    const add = await fetch(`${API_BASE}/public/cart/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ productId: sized.id, variantId: soldOutId, quantity: 1 }),
    });
    const addBody = await add.text();
    expect(add.status, addBody).toBeLessThan(300);

    const line = await prisma.cartItem.findFirst({
      where: { cart: { storeId }, variantId: soldOutId },
      select: { id: true },
    });
    const qty = await fetch(`${API_BASE}/public/cart/items/${line!.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ quantity: 2 }),
    });
    expect(qty.status, await qty.text()).toBeLessThan(300);

    const order = await fetch(`${API_BASE}/public/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
        paymentMethod: 'paymob',
      }),
    });
    const orderBody = (await order.json()) as {
      data?: { order: { id: string } };
      error?: unknown;
    };
    expect(order.status, JSON.stringify(orderBody.error ?? orderBody)).toBe(201);
    const backorders = await prisma.backorderLine.findMany({
      where: { storeId, orderItem: { orderId: orderBody.data!.order.id } },
      select: { variantId: true, qty: true },
    });
    expect(backorders).toEqual([expect.objectContaining({ variantId: soldOutId, qty: 2 })]);
  });

  it('store feature OFF: the size reads sold out and the cart refuses it', async () => {
    const { storeId, sized, soldOutId } = await seed({ feature: false });
    const { variant } = await pdpVariant(storeId, sized.slug, soldOutId);
    expect(variant).toMatchObject({ inStock: false, acceptsBackorder: false });
    const add = await fetch(`${API_BASE}/public/cart/items`, {
      method: 'POST',
      headers: hdr(storeId, 'bo-off'),
      body: JSON.stringify({ productId: sized.id, variantId: soldOutId, quantity: 1 }),
    });
    const body = (await add.json()) as { error?: { code?: string } };
    expect(add.status).toBe(400);
    expect(body.error?.code).toBe('INSUFFICIENT_INVENTORY');
  });

  it('untracked stock at 0: reads in stock and the cart accepts it', async () => {
    const { storeId, untracked } = await seed({ feature: false });
    const res = await fetch(`${API_BASE}/public/products/${untracked.slug}`, {
      headers: { 'x-store-id': storeId },
    });
    const body = (await res.json()) as { data: { product: Record<string, unknown> } };
    expect(body.data.product).toMatchObject({ inStock: true, acceptsBackorder: false });
    expect(body.data.product).not.toHaveProperty('trackInventory');
    const add = await fetch(`${API_BASE}/public/cart/items`, {
      method: 'POST',
      headers: hdr(storeId, 'bo-untracked'),
      body: JSON.stringify({ productId: untracked.id, quantity: 1 }),
    });
    expect(add.status, await add.text()).toBeLessThan(300);
  });
});
