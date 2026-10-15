/**
 * C-01 against real Postgres, over HTTP, with the API running as `ebda_app`
 * (strict RLS + the tenant guard, as CI runs it): the public shared-wishlist
 * read ships what the card CTA reads (every variant, server stock flags),
 * computed by enrichStockFlags through `lib/wishlist-card.ts`.
 *
 * The variants include is a read of a tenant child table on a route with no
 * authenticated user, so this proves RLS + the guard admit it — not only the
 * owner-role in-process client.
 *
 * Retry-safe: the store, customer and products are keyed on a per-CALL suffix
 * inside the test, so a retry seeds fresh rows instead of reusing attempt 1's.
 */
import { describe, it, expect } from 'vitest';
import { withRlsBypass } from '@ebda/database';
import { API_BASE } from '../helpers/api-base';
import { hasDb, seedBundleStore, seedProduct, seedCustomer } from '../helpers/bundle-fixtures';

describe.skipIf(!hasDb)('public shared wishlist: card projection (C-01)', () => {
  it('a sized product ships its variants; stock flags come from the active variants', async () => {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const store = await seedBundleStore(`wl-${suffix}`);
    const customerId = await seedCustomer(`wl-${suffix}`);
    const sizedId = await seedProduct(store.storeId, `${suffix}-abaya`, {
      price: 5000,
      inventory: 0,
    });
    const outId = await seedProduct(store.storeId, `${suffix}-scarf`, { price: 800, inventory: 0 });
    await withRlsBypass(async tx => {
      await tx.productVariant.create({
        data: { productId: sizedId, title: 'M', titleAr: 'وسط', inventory: 4, price: 5200 },
      });
      await tx.productVariant.create({
        data: { productId: sizedId, title: 'L', titleAr: 'كبير', inventory: 9, isActive: false },
      });
      await tx.wishlist.create({
        data: {
          userId: customerId,
          storeId: store.storeId,
          isPublic: true,
          items: { create: [{ productId: sizedId }, { productId: outId }] },
        },
      });
    });

    const res = await fetch(`${API_BASE}/public/${store.storeId}/wishlist/${customerId}`);
    const body = (await res.json()) as {
      data: { items: Array<{ product: Record<string, unknown> & { variants: unknown[] } }> };
    };
    expect(res.status, JSON.stringify(body)).toBe(200);
    const byId = new Map(body.data.items.map(i => [i.product.id, i.product]));

    const sized = byId.get(sizedId)!;
    expect(sized.variants).toHaveLength(2); // disabled one included: still a variant product
    expect(sized).toMatchObject({ inStock: true, acceptsBackorder: false });
    expect(sized.variants[0]).not.toHaveProperty('isActive');

    const out = byId.get(outId)!;
    expect(out.variants).toEqual([]);
    expect(out).toMatchObject({ inStock: false, acceptsBackorder: false });
  });
});
