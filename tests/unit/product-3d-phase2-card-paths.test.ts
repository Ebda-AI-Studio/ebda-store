/**
 * 3D viewer phase 2 render-path + data-hop gate (same shape as product-facts-render-paths):
 * the "3D" chip on every card path, `has3d` through every whitelist adapter and every card
 * payload (listing, recommendations, wishlist), and the quick view loaded lazily.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ORIGINAL_ROOT } from '../helpers/original-repo-root';

const read = (rel: string) => fs.readFileSync(path.join(ORIGINAL_ROOT, rel), 'utf8');

const CARD_PATHS = [
  'apps/web/src/templates/shared/StorefrontProductCard.tsx',
  'apps/web/src/templates/base/ProductCard.tsx',
  'apps/web/src/templates/dahab/ProductCard.tsx',
  'apps/web/src/templates/shared/ProductCarousel.tsx',
  'apps/web/src/app/products/ProductListItem.tsx',
  'apps/web/src/builder/sections/ProductSpotlightSection.tsx',
];

describe('3D chip reaches every card path', () => {
  it.each(CARD_PATHS)('%s renders <Model3dChip>', f => {
    expect(read(f)).toContain('<Model3dChip');
  });
  it('every card mapper in templates/adapters.ts passes has3d through its whitelist', () => {
    expect(
      read('apps/web/src/templates/adapters.ts').match(/has3d:\s*p\.has3d === true/g)
    ).toHaveLength(3);
  });
  it('the API ships has3d on the listing, recommendation and wishlist payloads', () => {
    expect(read('apps/api/src/services/product.service.ts')).toMatch(
      /model3d: CARD_MODEL3D_SELECT/
    );
    expect(
      read('apps/api/src/services/product.service.ts').match(/enrichStockFlags\(withHas3d\(p\)\)/g)
    ).toHaveLength(3);
    expect(read('apps/api/src/services/recommendation.service.ts')).toMatch(
      /model3d: CARD_MODEL3D_SELECT/
    );
    expect(read('apps/api/src/lib/wishlist-card.ts')).toContain('has3d: Boolean(p.model3d)');
    for (const f of [
      'apps/api/src/routes/wishlist.routes.ts',
      'apps/api/src/routes/public.routes.ts',
    ]) {
      expect(read(f)).toContain('model3d: { select: { id: true } }');
    }
  });
  it('the chip lazy-loads the quick view (no 3D code in the listing bundle)', () => {
    const chip = read('apps/web/src/components/commerce/Model3dChip.tsx');
    expect(chip).toMatch(/dynamic\(\(\) => import\('\.\/Model3dQuickView'\)/);
    expect(chip).not.toMatch(/^import .*Model3dQuickView/m);
  });
  it('model writes bust the product caches the has3d flag rides', () => {
    expect(
      read('apps/api/src/routes/product-model.routes.ts').match(
        /invalidateStoreProductCaches\(storeId\)/g
      )!.length
    ).toBeGreaterThanOrEqual(5);
  });
});
