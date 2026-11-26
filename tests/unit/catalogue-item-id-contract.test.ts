/**
 * Ruling FEEDS-2: ONE catalogue item id. The feed `id`, the storefront pixel content id, the server-side CAPI line id and
 * Ebda Chat's `retailerId` must be byte-identical for the same sellable thing, or dynamic retargeting and the WhatsApp
 * catalogue silently stop matching. This test pins all three to `catalogueItemId`.
 */
import { describe, it, expect } from 'vitest';
import { catalogueItemId, catalogueGroupId } from '@ebda/shared';
import { buildProductItems } from '@api/lib/catalogue-feed/build';
import { purchaseContents } from '@api/services/pixels-capi.service';
import { ctx, dress, simple } from '../helpers/catalogue-feed-fixtures';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('catalogue item id contract', () => {
  const feed = buildProductItems([simple(), dress()], ctx({ backorderOn: true })).items;

  it('feed ids equal catalogueItemId for simple products and for each variant', () => {
    expect(feed[0].id).toBe(catalogueItemId({ productId: 'prod-simple' }));
    expect(feed[1].id).toBe(catalogueItemId({ productId: 'prod-dress', variantId: 'var-m-red' }));
    expect(feed[1].groupId).toBe(catalogueGroupId('prod-dress'));
  });

  it('server-side CAPI reports order lines under the same ids', () => {
    const lines = purchaseContents({
      id: 'o1',
      total: 1,
      currency: 'EGP',
      items: [
        { productId: 'prod-simple', variantId: null, quantity: 2, price: 12500 },
        { productId: 'prod-dress', variantId: 'var-m-red', quantity: 1, price: 80000 },
      ],
    });
    expect(lines.map(l => l.id)).toEqual([feed[0].id, feed[1].id]);
    expect(lines[0]).toMatchObject({ quantity: 2, price: 125 });
  });

  it('Ebda Chat store bridge retailerId, and every storefront pixel call site, go through catalogueItemId', () => {
    const bridge = src('apps/api/src/lib/wa/bridge/do-port.ts');
    expect(bridge).toMatch(/retailerId: catalogueItemId\(\{ productId: p\.id \}\)/);
    expect(bridge).toMatch(
      /retailerId: catalogueItemId\(\{ productId: p\.id, variantId: v\.id \}\)/
    );
    expect(src('apps/web/src/app/products/[slug]/ProductDetailClient.tsx')).toMatch(
      /contentId: catalogueItemId\(\{ productId: product\.id, variantId: selectedVariant\?\.id \}\)/
    );
    expect(src('apps/web/src/app/checkout/success/SuccessClient.tsx')).toMatch(
      /catalogueItemId\(\{ productId: item\.productId, variantId: item\.variantId \}\)/
    );
    expect(src('apps/web/src/app/checkout/CheckoutClient.tsx')).toMatch(
      /catalogueItemId\(\{ productId: item\.productId, variantId: item\.variantId \}\)/
    );
  });

  it('a variant product is viewed as a product_group (the feed item_group_id), a simple one as a product', () => {
    const pdp = src('apps/web/src/app/products/[slug]/ProductDetailClient.tsx');
    expect(pdp.match(/'product_group' : 'product'/g)?.length).toBe(2);
    expect(src('apps/web/src/components/MarketingPixels.tsx')).toMatch(
      /content_type: params\.contentType \?\? 'product'/
    );
  });
});
