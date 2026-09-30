import { describe, it, expect, vi } from 'vitest';
import { buildProductFeed, type FeedBundleInput } from '@api/lib/product-feed';

const store = { id: 's1', name: 'Wady Aljuz', slug: 'wady-aljuz', currency: 'KWD' };
const product = {
  id: 'p1',
  name: 'Olive Oil 1L',
  nameAr: 'زيت زيتون ١ لتر',
  slug: 'olive-oil-1l',
  description: 'Cold pressed.',
  descriptionAr: 'عصرة أولى.',
  price: 12500,
  compareAtPrice: 15000,
  inStock: true,
  acceptsBackorder: false,
  updatedAt: new Date('2026-07-01T00:00:00Z'),
  images: [{ url: 'https://cdn.example/img1.jpg', alt: null, position: 0 }],
  categories: [{ category: { name: 'Pantry', slug: 'pantry' } }],
};

describe('buildProductFeed', () => {
  it('maps a product to OpenAI-convention feed fields', () => {
    const feed = buildProductFeed(store, [product], 'https://wadyaljuz.com');
    expect(feed.store).toEqual({
      name: 'Wady Aljuz',
      url: 'https://wadyaljuz.com',
      currency: 'KWD',
    });
    const item = feed.products[0];
    expect(item.item_id).toBe('p1');
    expect(item.title).toBe('Olive Oil 1L');
    expect(item.title_ar).toBe('زيت زيتون ١ لتر');
    expect(item.link).toBe('https://wadyaljuz.com/products/olive-oil-1l');
    expect(item.image_link).toBe('https://cdn.example/img1.jpg');
    expect(item.price).toBe('15.000 KWD'); // compareAtPrice is the base price
    expect(item.sale_price).toBe('12.500 KWD'); // price is what the customer pays
    expect(item.availability).toBe('in_stock');
    expect(item.categories).toEqual(['Pantry']);
    expect(item.updated_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('handles out of stock, backorder, and no compare-at', () => {
    const p = { ...product, compareAtPrice: null, inStock: false, acceptsBackorder: true };
    const item = buildProductFeed(store, [p], 'https://x.com').products[0];
    expect(item.price).toBe('12.500 KWD');
    expect(item.sale_price).toBeUndefined();
    expect(item.availability).toBe('backorder');
    const p2 = { ...p, acceptsBackorder: false };
    expect(buildProductFeed(store, [p2], 'https://x.com').products[0].availability).toBe(
      'out_of_stock'
    );
  });

  it('produces a byte-identical feed when no bundles are passed (feature-disabled store)', () => {
    // Freeze the clock: both calls stamp `generated_at` from `new Date()`, and
    // a millisecond tick between them made this equality flaky.
    vi.useFakeTimers({ now: new Date('2026-09-30T00:00:00Z'), toFake: ['Date'] });
    let withoutBundlesArg: ReturnType<typeof buildProductFeed>;
    let withExplicitEmptyBundles: ReturnType<typeof buildProductFeed>;
    try {
      withoutBundlesArg = buildProductFeed(store, [product], 'https://wadyaljuz.com');
      withExplicitEmptyBundles = buildProductFeed(store, [product], 'https://wadyaljuz.com', []);
    } finally {
      vi.useRealTimers();
    }
    // Same product_count, same single item, no `is_bundle` key anywhere —
    // this is the safety property Task 10 depends on: a store without the
    // `bundles` override must see the pre-Task-10 shape exactly.
    expect(withoutBundlesArg.product_count).toBe(1);
    expect(withoutBundlesArg).toEqual(withExplicitEmptyBundles);
    expect(withoutBundlesArg.products.every(p => !('is_bundle' in p))).toBe(true);
  });

  describe('bundle entries', () => {
    const bundle: FeedBundleInput = {
      id: 'b1',
      name: 'Ramadan Box',
      nameAr: 'علبة رمضان',
      slug: 'ramadan-box',
      image: 'https://cdn.example/box.jpg',
      price: 9000,
      componentSum: 11000,
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    };

    it('appears as a sibling product entry with is_bundle:true, correct sale pricing, and nameAr', () => {
      const feed = buildProductFeed(store, [product], 'https://wadyaljuz.com', [bundle]);
      expect(feed.product_count).toBe(2);
      const item = feed.products.find(p => p.item_id === 'b1')!;
      expect(item.title).toBe('Ramadan Box');
      expect(item.title_ar).toBe('علبة رمضان');
      expect(item.is_bundle).toBe(true);
      expect(item.image_link).toBe('https://cdn.example/box.jpg');
      // componentSum (11.000) is the "was" price; price (9.000) is what the
      // customer actually pays for the bundle as a single item.
      expect(item.price).toBe('11.000 KWD');
      expect(item.sale_price).toBe('9.000 KWD');
      expect(item.availability).toBe('in_stock');
      expect(item.categories).toEqual([]);
      // P2-4 (final review): `/bundles/<slug>` shipped later in this branch —
      // it is in the sitemap and carries JSON-LD — so an agent reading the
      // feed must be able to link a shopper straight to the bundle.
      expect(item.link).toBe('https://wadyaljuz.com/bundles/ramadan-box');
      expect(item.updated_at).toBe('2026-08-01T00:00:00.000Z');
      // A real product entry must stay completely unaffected by a bundle
      // being present elsewhere in the same feed.
      const productItem = feed.products.find(p => p.item_id === 'p1')!;
      expect('is_bundle' in productItem).toBe(false);
    });

    it('links every entry — products to /products/<slug>, bundles to /bundles/<slug>', () => {
      const feed = buildProductFeed(store, [product], 'https://wadyaljuz.com', [bundle]);
      expect(feed.products.every(p => typeof p.link === 'string' && p.link.length > 0)).toBe(true);
      expect(feed.products.find(p => p.item_id === 'p1')!.link).toContain('/products/');
      expect(feed.products.find(p => p.item_id === 'b1')!.link).toContain('/bundles/');
    });

    it('omits sale_price and uses price as componentSum when not discounted', () => {
      const evenBundle = { ...bundle, price: 11000, componentSum: 11000 };
      const item = buildProductFeed(store, [], 'https://x.com', [evenBundle]).products[0];
      expect(item.price).toBe('11.000 KWD');
      expect(item.sale_price).toBeUndefined();
    });

    it('never leaks per-component allocated prices — only whole-bundle price/componentSum reach the feed', () => {
      const item = buildProductFeed(store, [], 'https://x.com', [bundle]).products[0];
      const keys = Object.keys(item);
      // FeedBundleInput itself carries no per-component data (no `lines`,
      // `pricingType`, `pricingValue`) — this asserts the OUTPUT shape too,
      // so a future field added to FeedBundleInput can't leak silently.
      expect(keys).not.toContain('lines');
      expect(keys).not.toContain('pricingType');
      expect(keys).not.toContain('pricingValue');
      expect(JSON.stringify(item)).not.toContain('lines');
    });

    it('lists bundle contents by name via description/description_ar when provided', () => {
      const withContents: FeedBundleInput = {
        ...bundle,
        description: 'Includes: Dates, Honey, Nuts',
        descriptionAr: 'يشمل: تمر، عسل، مكسرات',
      };
      const item = buildProductFeed(store, [], 'https://x.com', [withContents]).products[0];
      expect(item.description).toBe('Includes: Dates, Honey, Nuts');
      expect(item.description_ar).toBe('يشمل: تمر، عسل، مكسرات');
    });
  });
});
