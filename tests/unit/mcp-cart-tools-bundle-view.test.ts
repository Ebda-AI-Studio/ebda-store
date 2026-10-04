/**
 * `cartView` (apps/api/src/mcp/tools/cart.tools.ts) shapes the `view_cart` /
 * `add_to_cart` MCP tool response. A bundle in the cart lives on its own
 * `CartBundle` row — never expanded into `cart.items` (see `cart.service.ts`)
 * — and `CartService.getOrCreate`/`addItem` already resolve it live as
 * `cart.bundles: CartBundleView[]`, folding it into `cart.subtotal`
 * (`itemsSubtotal + bundlesSubtotal`). `cartView` used to map `cart.items`
 * only, so a bundle in the cart silently vanished from what the agent reads:
 * `subtotal` would be higher than the sum of the listed `items`, with no
 * line accounting for the gap — the MCP-specific shape of this defect class
 * (there is no visual markup here, only the returned JSON).
 */
import { describe, it, expect } from 'vitest';
import { cartView } from '@api/mcp/tools/cart.tools';

describe('cartView', () => {
  it('surfaces a cart bundle as its own line, reconciling to the cart subtotal', () => {
    const cart = {
      items: [
        {
          id: 'ci-1',
          productId: 'p-rug',
          variantId: null,
          quantity: 2,
          product: { name: 'Rug', nameAr: 'سجادة', price: 3000 },
          variant: null,
        },
      ],
      bundles: [
        {
          id: 'cb-1',
          bundleId: 'bundle-1',
          name: 'Ramadan Box',
          nameAr: 'علبة رمضان',
          image: null,
          quantity: 1,
          unitPrice: 12000,
          total: 12000,
          available: 5,
        },
      ],
      subtotal: 3000 * 2 + 12000,
    };

    const view = cartView('cart-1', cart, 'EGP');

    expect(view.items).toEqual([
      {
        itemId: 'ci-1',
        productId: 'p-rug',
        variantId: undefined,
        title: 'Rug',
        title_ar: 'سجادة',
        quantity: 2,
        unitPrice: 3000,
      },
    ]);

    // The bundle must be present as ONE line — not dropped, not expanded
    // into its components (a cart bundle has no components to expand; the
    // defect here is omission, not fragmentation).
    expect(view.bundles).toEqual([
      {
        cartBundleId: 'cb-1',
        bundleId: 'bundle-1',
        title: 'Ramadan Box',
        title_ar: 'علبة رمضان',
        quantity: 1,
        unitPrice: 12000,
        total: 12000,
      },
    ]);

    // The subtotal the agent is told must reconcile to the lines it can see.
    const itemsTotal = view.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    const bundlesTotal = view.bundles.reduce((sum, b) => sum + b.total, 0);
    expect(itemsTotal + bundlesTotal).toBe(view.subtotal);
  });

  it('a cart with no bundles renders items unchanged and bundles: [] — additive, byte-identical items shape', () => {
    const cart = {
      items: [
        {
          id: 'ci-1',
          productId: 'p-lamp',
          variantId: 'v-1',
          quantity: 1,
          product: { name: 'Lamp', nameAr: null, price: 2000 },
          variant: { price: 2500 },
        },
      ],
      bundles: [],
      subtotal: 2500,
    };

    const view = cartView('cart-2', cart, 'EGP');

    expect(view.items).toEqual([
      {
        itemId: 'ci-1',
        productId: 'p-lamp',
        variantId: 'v-1',
        title: 'Lamp',
        title_ar: undefined,
        quantity: 1,
        unitPrice: 2500, // variant price wins over the parent product price
      },
    ]);
    expect(view.bundles).toEqual([]);
    expect(view.subtotal).toBe(2500);
  });

  it('tolerates a cart object with no bundles field at all (pre-bundle callers / legacy shape)', () => {
    const cart = {
      items: [],
      subtotal: 0,
    };
    const view = cartView('cart-3', cart, 'EGP');
    expect(view.bundles).toEqual([]);
  });

  it('#1766 — flags a deleted-product line so the gap to subtotal is explained', () => {
    const cart = {
      items: [
        {
          id: 'ci-1',
          productId: 'p-live',
          quantity: 1,
          product: { name: 'Live', price: 3000 },
          variant: null,
          unavailable: false,
        },
        {
          id: 'ci-2',
          productId: 'p-gone',
          quantity: 1,
          product: { name: 'Gone', price: 9000 },
          variant: null,
          unavailable: true,
        },
      ],
      bundles: [],
      subtotal: 3000,
    };
    const view = cartView('cart-1', cart, 'EGP');
    expect(view.items[0]).not.toHaveProperty('unavailable');
    expect(view.items[1]).toMatchObject({ productId: 'p-gone', unavailable: true });
  });
});
