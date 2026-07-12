import { describe, it, expect } from 'vitest';
import { buildProductFeed } from '@api/lib/product-feed';

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
});
