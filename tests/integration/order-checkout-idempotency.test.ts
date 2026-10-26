/**
 * Audit M-012 / P07 against REAL Postgres: two concurrent place-order requests for one cart create ONE order, decrement
 * stock ONCE, and a retry with the same Idempotency-Key returns the first order. Real transactions on real connections
 * (no mocks): the cart row lock is what serialises the requests.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@ebda/database';
import { OrderService } from '@api/services/order.service';
import { CartService } from '@api/services/cart.service';
import { cartSessionId, hasDb } from '../helpers/bundle-fixtures';

const TAG = `idem-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
let seq = 0;
const uid = (l: string) => `${TAG}-${l}-${++seq}`;
const address = (n: number) => ({
  firstName: 'Mona',
  lastName: 'Adel',
  address1: 'شارع النصر، مبنى 5',
  city: '',
  state: '',
  postalCode: '',
  country: 'Egypt',
  governorate: 'Cairo',
  governorateAr: 'القاهرة',
  area: 'Nasr City',
  areaAr: 'مدينة نصر',
  phone: `+2010${(2_000_000 + n).toString().slice(-7)}`,
  email: `${uid('buyer')}@example.test`,
});

async function mkStore() {
  const owner = await prisma.user.create({
    data: {
      email: `${uid('owner')}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'O',
      lastName: 'I',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  const store = await prisma.store.create({
    data: { name: 'Idem Store', slug: uid('store'), ownerId: owner.id, status: 'active' },
  });
  await prisma.paymentConfig.create({
    data: {
      storeId: store.id,
      provider: 'cod',
      isEnabled: true,
      fixedFee: 0,
      settings: { percentBps: 0 },
    },
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      name: 'Tee',
      slug: uid('tee'),
      price: 10_000,
      status: 'active',
      inventory: 100,
      trackInventory: true,
    },
  });
  return { storeId: store.id, productId: product.id };
}
async function cartWith(s: { storeId: string; productId: string }, qty = 2) {
  const sessionId = cartSessionId('idem');
  const cart = await CartService.getOrCreate(s.storeId, sessionId, undefined);
  await prisma.cartItem.create({
    data: { cartId: cart.id, productId: s.productId, quantity: qty },
  });
  return sessionId;
}
const place = (s: { storeId: string }, sessionId: string, n: number, key?: string) =>
  OrderService.create(
    s.storeId,
    undefined,
    sessionId,
    { shippingAddress: address(n), paymentMethod: 'cod' },
    undefined,
    key ? { idempotencyKey: key } : undefined
  );
const stock = async (id: string) =>
  (await prisma.product.findUniqueOrThrow({ where: { id }, select: { inventory: true } }))
    .inventory;
const orders = (storeId: string) => prisma.order.count({ where: { storeId } });

describe.skipIf(!hasDb)(
  'checkout idempotency and cart claim (real Postgres, concurrent requests)',
  () => {
    let s: Awaited<ReturnType<typeof mkStore>>;
    beforeAll(async () => {
      s = await mkStore();
    });

    it('two concurrent POSTs for one cart (no key): exactly one order, one stock decrement; the loser is CART_CHANGED and touches nothing', async () => {
      const sessionId = await cartWith(s, 2);
      const before = await stock(s.productId);
      const ordersBefore = await orders(s.storeId);
      const res = await Promise.allSettled([place(s, sessionId, 1), place(s, sessionId, 2)]);
      expect(res.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const loser = res.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(['CART_CHANGED', 'EMPTY_CART']).toContain(loser.reason.code);
      expect(await orders(s.storeId)).toBe(ordersBefore + 1);
      expect(await stock(s.productId)).toBe(before - 2); // ONE decrement of 2, not 4
    });

    it('8 concurrent POSTs for one cart: still exactly one order and one decrement', async () => {
      const sessionId = await cartWith(s, 3);
      const before = await stock(s.productId);
      const ordersBefore = await orders(s.storeId);
      const res = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => place(s, sessionId, 10 + i))
      );
      expect(res.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(await orders(s.storeId)).toBe(ordersBefore + 1);
      expect(await stock(s.productId)).toBe(before - 3);
    });

    it('concurrent POSTs with the SAME Idempotency-Key: both succeed with the SAME order; one decrement', async () => {
      const sessionId = await cartWith(s, 2);
      const before = await stock(s.productId);
      const ordersBefore = await orders(s.storeId);
      const res = await Promise.all([
        place(s, sessionId, 20, 'key-concurrent-0001'),
        place(s, sessionId, 21, 'key-concurrent-0001'),
        place(s, sessionId, 22, 'key-concurrent-0001'),
      ]);
      expect(new Set(res.map(o => o!.id)).size).toBe(1);
      expect(await orders(s.storeId)).toBe(ordersBefore + 1);
      expect(await stock(s.productId)).toBe(before - 2);
    });

    it('a later retry with the same key (after the cart was cleared) returns the first order and changes nothing', async () => {
      const sessionId = await cartWith(s, 1);
      const first = await place(s, sessionId, 30, 'key-sequential-0001');
      const before = await stock(s.productId);
      const ordersBefore = await orders(s.storeId);
      const again = await place(s, sessionId, 31, 'key-sequential-0001');
      expect(again!.id).toBe(first.id);
      expect(await orders(s.storeId)).toBe(ordersBefore);
      expect(await stock(s.productId)).toBe(before);
    });

    it('the key is bound to the SESSION: another session using the same key creates its own order', async () => {
      const a = await cartWith(s, 1);
      const b = await cartWith(s, 1);
      const oa = await place(s, a, 40, 'shared-key-00001');
      const ob = await place(s, b, 41, 'shared-key-00001');
      expect(ob.id).not.toBe(oa.id);
    });

    it('a malformed Idempotency-Key is a 400, not silently ignored', async () => {
      const sessionId = await cartWith(s, 1);
      await expect(place(s, sessionId, 50, 'x')).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_IDEMPOTENCY_KEY',
      });
      await expect(place(s, sessionId, 51, 'has space in it!')).rejects.toMatchObject({
        code: 'INVALID_IDEMPOTENCY_KEY',
      });
    });

    it('the cart is still claimable by a retry after a request that FAILED (rolled back): nothing was lost', async () => {
      const sessionId = await cartWith(s, 500); // more than the stock (100)
      await expect(place(s, sessionId, 60)).rejects.toBeTruthy();
      const cart = await prisma.cart.findFirst({
        where: { storeId: s.storeId, sessionId },
        include: { items: true },
      });
      expect(cart!.items).toHaveLength(1); // the failed order did not eat the cart
      await prisma.cartItem.updateMany({ where: { cartId: cart!.id }, data: { quantity: 1 } });
      const ok = await place(s, sessionId, 61);
      expect(ok.id).toBeTruthy();
    });
  }
);
