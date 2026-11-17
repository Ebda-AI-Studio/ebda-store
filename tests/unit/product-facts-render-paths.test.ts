/**
 * Render-path + data-hop gate for product facts (same shape as
 * product-custom-badge-render-paths): chips on every card path, the table on
 * both PDPs, `facts` through the whitelist adapter and every card payload.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ORIGINAL_ROOT } from '../helpers/original-repo-root';

// Original checkout, not the Stryker sandbox (instrumented text): tests/helpers/original-repo-root.ts
const ROOT = ORIGINAL_ROOT;
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CARD_PATHS = [
  'apps/web/src/templates/shared/StorefrontProductCard.tsx',
  'apps/web/src/templates/base/ProductCard.tsx',
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
  it('every card mapper in templates/adapters.ts passes facts through its whitelist', () => {
    // toTemplateProduct, recommendedToTemplateProduct, wishlistToTemplateProduct.
    expect(read('apps/web/src/templates/adapters.ts').match(/facts:\s*p\.facts/g)).toHaveLength(3);
  });
  it.each([
    ['apps/web/src/components/YouMightAlsoLike.tsx', 'recommendedToTemplateProduct'],
    ['apps/web/src/components/CartRecommendations.tsx', 'recommendedToTemplateProduct'],
    ['apps/web/src/components/FrequentlyBoughtTogether.tsx', 'recommendedToTemplateProduct'],
    ['apps/web/src/app/wishlist/WishlistClient.tsx', 'wishlistToTemplateProduct'],
  ])('%s builds its cards through %s (no hand-built whitelist)', (f, mapper) => {
    expect(read(f)).toContain(mapper);
  });
  it('the API ships facts on the PDP/listing, recommendation and wishlist payloads', () => {
    expect(read('apps/api/src/services/product.service.ts')).toMatch(/\n {2}facts: true,/);
    expect(read('apps/api/src/services/recommendation.service.ts')).toMatch(/\n {2}facts: true,/);
    expect(read('apps/api/src/lib/wishlist-card.ts')).toContain('facts: p.facts');
    expect(read('apps/api/src/routes/wishlist.routes.ts')).toContain(
      'wishlistCardProduct(item.product)'
    );
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
