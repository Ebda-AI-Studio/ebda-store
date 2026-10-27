/**
 * B0 Task 5 (fix round 1), over HTTP against the running API (as `ebda_app`),
 * the way the storefront checkout calls it:
 *
 *  - `POST /public/orders` snapshots the variant's title in BOTH languages on the
 *    order line (Ruling B0-41): `variantName` = the canonical (EN) title that
 *    fiscal documents and exports read, `variantNameAr` = the Arabic title the
 *    Arabic storefront renders; plus the line's personalisation.
 *    Before the fix the storefront never sent `locale`, so this could not
 *    happen in production even though the service supported it.
 *  - A line that lost its required personalisation (added before the merchant
 *    made it required) is refused at order creation with 400
 *    `PERSONALISATION_REQUIRED`, naming the product in `details` — and no
 *    order is created.
 *
 * Same harness as backorder-checkout-rls.test.ts: fixtures through the test
 * superuser connection, requests to `API_BASE` (set TEST_API_URL to the local
 * API). Retry-safe: every store/product/session is per-CALL unique.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { API_BASE } from '../helpers/api-base';
import {
  hasDb,
  cartSessionId,
  uniqueClientIp,
  DEFAULT_TEST_SHIPPING_ADDRESS,
} from '../helpers/bundle-fixtures';

const created: { storeIds: string[]; userIds: string[] } = { storeIds: [], userIds: [] };

async function seedStore(personalisation: object) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.create({
    data: {
      email: `perso-http-${suffix}@test.local`,
      passwordHash: 'x',
      firstName: 'Perso',
      lastName: 'Http',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `Perso HTTP ${suffix}`,
      slug: `perso-http-${suffix}`,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
      marketingPixels: {},
    },
  });
  created.storeIds.push(store.id);
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      name: `Linen Abaya ${suffix}`,
      nameAr: 'عباية كتان',
      slug: `perso-http-abaya-${suffix}`,
      price: 5000,
      inventory: 0,
      trackInventory: true,
      status: 'active',
      personalisation,
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, title: 'M / Sand', titleAr: 'وسط / رملي', inventory: 20 },
  });
  return { storeId: store.id, productId: product.id, variantId: variant.id };
}

const optional = {
  enabled: true,
  label: 'Name',
  labelAr: 'الاسم للتطريز',
  maxLength: 12,
  required: false,
};

async function post(path: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': uniqueClientIp(), ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      success: boolean;
      data?: {
        order: {
          id: string;
          items: Array<{
            variantId: string | null;
            variantName: string | null;
            variantNameAr: string | null;
            personalisation: string | null;
          }>;
        };
      };
      error?: { code: string; message: string; details?: Record<string, unknown> };
    },
  };
}

afterAll(async () => {
  if (!hasDb) return;
  const storeIds = created.storeIds;
  await prisma.inventoryHistory.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId: { in: storeIds } } } });
  await prisma.payment.deleteMany({ where: { order: { storeId: { in: storeIds } } } });
  await prisma.order.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.cartItem.deleteMany({ where: { cart: { storeId: { in: storeIds } } } });
  await prisma.cart.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.product.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)('POST /public/orders: locale + personalisation (B0 Task 5)', () => {
  it('snapshots both variant titles (EN canonical + Arabic) and the note on the order line', async () => {
    const { storeId, productId, variantId } = await seedStore(optional);
    const headers = {
      'Content-Type': 'application/json',
      'x-store-id': storeId,
      'x-session-id': cartSessionId('perso-http-ar'),
    };
    const add = await post('/public/cart/items', headers, {
      productId,
      variantId,
      quantity: 1,
      note: 'سارة',
    });
    expect(add.status, JSON.stringify(add.body.error)).toBeLessThan(300);

    const res = await post('/public/orders', headers, {
      shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
      paymentMethod: 'paymob',
      locale: 'ar',
    });
    expect(res.status, JSON.stringify(res.body.error)).toBe(201);
    const line = res.body.data!.order.items.find(i => i.variantId === variantId)!;
    expect(line.variantName).toBe('M / Sand');
    expect(line.variantNameAr).toBe('وسط / رملي');
    expect(line.personalisation).toBe('سارة');
  });

  it('refuses an order whose line lost its required personalisation (400, names the product)', async () => {
    const { storeId, productId, variantId } = await seedStore(optional);
    const headers = {
      'Content-Type': 'application/json',
      'x-store-id': storeId,
      'x-session-id': cartSessionId('perso-http-required'),
    };
    // Added while the field was optional, with no note…
    const add = await post('/public/cart/items', headers, { productId, variantId, quantity: 1 });
    expect(add.status, JSON.stringify(add.body.error)).toBeLessThan(300);
    // …then the merchant makes it required.
    await prisma.product.update({
      where: { id: productId },
      data: { personalisation: { ...optional, required: true } },
    });

    const res = await post('/public/orders', headers, {
      shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
      paymentMethod: 'paymob',
      locale: 'ar',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('PERSONALISATION_REQUIRED');
    expect(res.body.error?.details).toMatchObject({
      productIds: [productId],
      products: [{ productId, nameAr: 'عباية كتان', labelAr: 'الاسم للتطريز' }],
    });
    expect(await prisma.order.count({ where: { storeId } })).toBe(0);
  });
});
