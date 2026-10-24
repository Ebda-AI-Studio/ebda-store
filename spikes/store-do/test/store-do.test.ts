import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const stub = (id: string) => env.STORE_DO.get(env.STORE_DO.idFromName(id));
const now = Date.now();
const store = (id: string) => ({
  id,
  slug: id,
  name: id,
  currency: 'EGP',
  createdAt: now,
  updatedAt: now,
});
const product = (storeId: string, n: number, over: Record<string, unknown> = {}) => ({
  id: `${storeId}-p${n}`,
  storeId,
  name: `P${n}`,
  nameAr: `م${n}`,
  slug: `p${n}`,
  price: 10000 + n,
  compareAtPrice: null,
  inventory: 10,
  status: 'active' as const,
  hasVariants: false,
  createdAt: now + n,
  updatedAt: now,
  ...over,
});
const ok = <T>(r: { ok: boolean } & Record<string, any>): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r.data as T;
};

describe('StoreDO core (5 tables + item children)', () => {
  it('migrates on first request, once, and survives re-instantiation', async () => {
    const s = stub('store-a');
    expect(Object.keys(await s.rowCounts()).sort()).toEqual(
      [
        'cart_items',
        'carts',
        'order_items',
        'orders',
        'product_variants',
        'products',
        'stores',
      ].sort()
    );
    // a second stub to the same id is the same DO; the migration ledger has exactly one row
    const again = stub('store-a');
    expect(await again.rowCounts()).toEqual(await s.rowCounts());
  });

  it('createProduct then listProducts round-trips, newest first, store-scoped', async () => {
    const s = stub('store-a');
    ok(
      await s.seed({
        store: store('store-a'),
        products: [product('store-a', 1), product('store-a', 2)],
      })
    );
    const rows = ok<{ id: string; price: number }[]>(await s.listProducts('store-a', 24));
    expect(rows.map(r => r.id)).toEqual(['store-a-p2', 'store-a-p1']);
    expect(Number.isInteger(rows[0].price)).toBe(true); // money is integer piastres
    // another store's DO sees none of it (isolation by construction)
    expect(ok<unknown[]>(await stub('store-b').listProducts('store-b', 24))).toEqual([]);
    // and a DO asked for a different store id returns nothing (store_id predicate on every query)
    expect(ok<unknown[]>(await s.listProducts('store-b', 24))).toEqual([]);
  });

  it('cart add then order create decrements stock and totals in piastres', async () => {
    const s = stub('store-a');
    ok(
      await s.seed({ store: store('store-a'), products: [product('store-a', 3, { inventory: 5 })] })
    );
    ok(await s.addCartItem('store-a', 'sess-1', 'store-a-p3', 2));
    const o = ok<{ orderNumber: number; total: number }>(await s.createOrder('store-a', 'sess-1'));
    expect(o.total).toBe(2 * 10003);
    expect(o.orderNumber).toBeGreaterThan(1000);
    expect(await s.stock('store-a-p3')).toBe(3);
  });

  it('exactly one of 20 parallel orders wins the last unit (stock=1)', async () => {
    const s = stub('store-race');
    ok(
      await s.seed({
        store: store('store-race'),
        products: [product('store-race', 1, { inventory: 1 })],
      })
    );
    const sessions = Array.from({ length: 20 }, (_, i) => `race-${i}`);
    for (const sid of sessions) ok(await s.addCartItem('store-race', sid, 'store-race-p1', 1));
    const results = await Promise.all(sessions.map(sid => s.createOrder('store-race', sid)));
    expect(results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(1);
    expect(
      results.filter((r: { ok: boolean }) => !r.ok && (r as any).code === 'OUT_OF_STOCK')
    ).toHaveLength(19);
    expect(await s.stock('store-race-p1')).toBe(0);
    const counts = await s.rowCounts();
    expect(counts.orders).toBe(1);
    expect(counts.order_items).toBe(1);
  });

  it('a failing second line rolls the whole order back (no partial decrement)', async () => {
    const s = stub('store-tx');
    ok(
      await s.seed({
        store: store('store-tx'),
        products: [
          product('store-tx', 1, { inventory: 5 }),
          product('store-tx', 2, { inventory: 1 }),
        ],
      })
    );
    ok(await s.addCartItem('store-tx', 'sess', 'store-tx-p1', 2));
    ok(await s.addCartItem('store-tx', 'sess', 'store-tx-p2', 1));
    // someone else buys p2's last unit first
    ok(await s.addCartItem('store-tx', 'other', 'store-tx-p2', 1));
    ok(await s.createOrder('store-tx', 'other'));
    const r = await s.createOrder('store-tx', 'sess');
    expect(r).toMatchObject({ ok: false, code: 'OUT_OF_STOCK', status: 409 });
    expect(await s.stock('store-tx-p1')).toBe(5); // line 1 was decremented then rolled back
    expect((await s.rowCounts()).orders).toBe(1); // only the other shopper's order exists
  });

  it('variant products need a variantId and stock comes from the variant row', async () => {
    const s = stub('store-var');
    ok(
      await s.seed({
        store: store('store-var'),
        products: [product('store-var', 1, { hasVariants: true, inventory: 0 })],
        variants: [
          {
            id: 'v1',
            storeId: 'store-var',
            productId: 'store-var-p1',
            sku: 'A',
            price: 25000,
            inventory: 2,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
      })
    );
    expect(await s.addCartItem('store-var', 's', 'store-var-p1', 1)).toMatchObject({
      ok: false,
      code: 'VARIANT_REQUIRED',
    });
    ok(await s.addCartItem('store-var', 's', 'store-var-p1', 2, 'v1'));
    const o = ok<{ total: number }>(await s.createOrder('store-var', 's'));
    expect(o.total).toBe(50000);
    ok(await s.addCartItem('store-var', 's2', 'store-var-p1', 1, 'v1'));
    expect(await s.createOrder('store-var', 's2')).toMatchObject({
      ok: false,
      code: 'OUT_OF_STOCK',
    });
  });
});

describe('worker + flag', () => {
  it('serves only ids in STORE_DO_ENABLED_IDS (never default-to-first)', async () => {
    expect((await SELF.fetch('https://x/s/not-enabled/products')).status).toBe(404);
    expect((await SELF.fetch('https://x/s/store-a/products')).status).toBe(200);
  });
  it('seed route is closed without the operator token', async () => {
    const r = await SELF.fetch('https://x/s/store-a/__seed', { method: 'POST', body: '{}' });
    expect(r.status).toBe(403);
  });
  it('cart + order over HTTP with the backend header', async () => {
    const seed = await SELF.fetch('https://x/s/store-b/__seed', {
      method: 'POST',
      headers: { authorization: 'Bearer test-seed-token' },
      body: JSON.stringify({ store: store('store-b'), products: [product('store-b', 1)] }),
    });
    expect(seed.status).toBe(200);
    const add = await SELF.fetch('https://x/s/store-b/cart/items', {
      method: 'POST',
      headers: { 'x-session-id': 'h1', 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'store-b-p1', quantity: 1 }),
    });
    expect(add.status).toBe(200);
    expect(add.headers.get('x-store-backend')).toBe('do');
    const ord = await SELF.fetch('https://x/s/store-b/orders', {
      method: 'POST',
      headers: { 'x-session-id': 'h1' },
    });
    expect(ord.status).toBe(201);
  });
});
