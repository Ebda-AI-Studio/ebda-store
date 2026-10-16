/**
 * C-01: the wishlist projections (GET /wishlist, the public shared wishlist)
 * carry what the card CTA reads — every variant, the server's stock flags —
 * computed by the same enrichStockFlags the listing uses.
 */
import { describe, it, expect } from 'vitest';
import { wishlistCardProduct } from '@api/lib/wishlist-card';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Abaya',
  nameAr: 'عباية',
  slug: 'abaya',
  price: 520000,
  compareAtPrice: null,
  badgeLabel: null,
  badgeLabelAr: null,
  status: 'active',
  inventory: 0, // a variant product's parent column (the inventory model)
  allowBackorder: false,
  lowStockThreshold: 5,
  images: [{ url: 'https://example.test/a.jpg' }],
  variants: [
    {
      id: 'v1',
      price: 520000,
      compareAtPrice: null,
      inventory: 3,
      allowBackorder: false,
      isActive: true,
    },
    {
      id: 'v2',
      price: null,
      compareAtPrice: null,
      inventory: 9,
      allowBackorder: false,
      isActive: false,
    },
  ],
  options: [],
  facts: [],
  ...over,
});

describe('wishlistCardProduct', () => {
  it('keeps EVERY variant (disabled included) so the card offers "choose options"', () => {
    const p = wishlistCardProduct(row());
    expect(p.variants.map(v => v.id)).toEqual(['v1', 'v2']);
    // variant prices in the same unit as the parent price on this surface
    expect(p.price).toBe(5200);
    expect(p.variants[0].price).toBe(5200);
    expect(p.variants[1].price).toBeNull();
    // isActive is read for stock, never shipped
    expect(p.variants[0]).not.toHaveProperty('isActive');
    expect(p.variants[0]).not.toHaveProperty('inventory');
  });

  it('stock is the ACTIVE variants, not the parent column', () => {
    expect(wishlistCardProduct(row()).inStock).toBe(true);
    const onlyDisabled = row({
      variants: [
        {
          id: 'v2',
          price: null,
          compareAtPrice: null,
          inventory: 9,
          allowBackorder: false,
          isActive: false,
        },
      ],
    });
    expect(wishlistCardProduct(onlyDisabled).inStock).toBe(false);
  });

  it('carries acceptsBackorder for a sold-out backorderable plain product', () => {
    const p = wishlistCardProduct(row({ variants: [], inventory: 0, allowBackorder: true }));
    expect(p).toMatchObject({ inStock: false, acceptsBackorder: true });
  });

  it('an unpublished product is never buyable', () => {
    const p = wishlistCardProduct(row({ status: 'draft', variants: [], inventory: 4 }));
    expect(p).toMatchObject({ inStock: false, acceptsBackorder: false });
  });

  it('ships the Arabic name', () => {
    expect(wishlistCardProduct(row()).nameAr).toBe('عباية');
  });
});
