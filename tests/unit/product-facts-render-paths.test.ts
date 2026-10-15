/**
 * Render-path + data-hop gate for product facts (same shape as
 * product-custom-badge-render-paths): chips on every card path, the table on
 * both PDPs, `facts` through the whitelist adapter and every card payload.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CARD_PATHS = [
  'apps/web/src/templates/shared/PecannbeeProductCard.tsx',
  'apps/web/src/templates/modern/ProductCard.tsx',
  'apps/web/src/templates/elegant/ProductCard.tsx',
  'apps/web/src/templates/classic/ProductCard.tsx',
  'apps/web/src/templates/minimal/ProductCard.tsx',
  'apps/web/src/templates/bold/ProductCard.tsx',
  'apps/web/src/templates/dahab/ProductCard.tsx',
  'apps/web/src/templates/shared/ProductCarousel.tsx',
  'apps/web/src/app/products/ProductListItem.tsx',
];

describe('product facts reach every surface', () => {
  it.each(CARD_PATHS)('%s renders <FactChips>', f => {
    expect(read(f)).toContain('<FactChips');
  });
  it.each(['apps/web/src/app/products/[slug]/ProductDetailClient.tsx'])(
    '%s renders <FactsTable>',
    f => {
      expect(read(f)).toContain('<FactsTable');
    }
  );
  it('dahab PDP renders <FactsTable>', () => {
    expect(read('apps/web/src/templates/dahab/ProductDetail.tsx')).toContain('<FactsTable');
  });
  it.each([
    'apps/web/src/templates/adapters.ts',
    'apps/web/src/components/YouMightAlsoLike.tsx',
    'apps/web/src/components/CartRecommendations.tsx',
    'apps/web/src/components/FrequentlyBoughtTogether.tsx',
    'apps/web/src/app/wishlist/WishlistClient.tsx',
  ])('%s passes facts through its whitelist', f => {
    expect(read(f)).toMatch(/facts:\s*(p|item\.product)\.facts/);
  });
  it('the API ships facts on the PDP/listing, recommendation and wishlist payloads', () => {
    expect(read('apps/api/src/services/product.service.ts')).toMatch(/\n {2}facts: true,/);
    expect(read('apps/api/src/services/recommendation.service.ts')).toMatch(/\n {2}facts: true,/);
    expect(read('apps/api/src/routes/wishlist.routes.ts')).toContain('facts: item.product.facts');
  });
  it('compare list stores and shows facts', () => {
    expect(read('apps/web/src/app/products/ProductsClient.tsx')).toContain('facts: product.facts');
    expect(read('apps/web/src/app/compare/CompareClient.tsx')).toContain('factRows');
  });
  it('the product PUT path busts the product caches', () => {
    const s = read('apps/api/src/services/product.service.ts');
    const upd = s.slice(
      s.indexOf('static async update('),
      s.indexOf('static async updateInventory')
    );
    expect(upd).toContain('facts');
    expect(upd).toContain('this.invalidateStoreProductCache(storeId)');
  });
});
