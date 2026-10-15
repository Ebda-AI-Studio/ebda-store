/**
 * X-02 fix round (W1b review Critical 1, Important 1-2): the storefront's
 * "can this be bought" flags and the server's cart/checkout checks follow ONE
 * rule.
 *  - A variant inherits its product's `allowBackorder` (the merchant bulk
 *    toggle sets only the product flag; the variant column defaults false).
 *  - The store's `inventory.backorder` feature gates every backorder.
 *  - Untracked stock (`trackInventory: false`) is always in stock.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  enrichStockFlags,
  gateBackorder,
  gateBackorderPayload,
  isOrderable,
  lineAllowsBackorder,
} from '../../apps/api/src/lib/effective-inventory';

describe('lineAllowsBackorder: the server rule for one line', () => {
  it('a variant inherits the product flag', () => {
    expect(lineAllowsBackorder({ allowBackorder: true }, { allowBackorder: false }, true)).toBe(
      true
    );
    expect(lineAllowsBackorder({ allowBackorder: false }, { allowBackorder: true }, true)).toBe(
      true
    );
    expect(lineAllowsBackorder({ allowBackorder: false }, { allowBackorder: false }, true)).toBe(
      false
    );
    expect(lineAllowsBackorder({ allowBackorder: true }, null, true)).toBe(true);
  });
  it('the store feature gates it', () => {
    expect(lineAllowsBackorder({ allowBackorder: true }, { allowBackorder: true }, false)).toBe(
      false
    );
  });
});

describe('the storefront flags agree with the server', () => {
  const sized = {
    inventory: 0,
    allowBackorder: true, // product flag only
    lowStockThreshold: 3,
    variants: [
      { id: 'v1', inventory: 0, allowBackorder: false, isActive: true },
      { id: 'v2', inventory: 4, allowBackorder: false, isActive: true },
    ],
  };
  it('a product-flag-only backorder size reads as a pre-order, and the server accepts it', () => {
    const flags = enrichStockFlags(sized);
    expect(flags.variants![0]).toMatchObject({ inStock: false, acceptsBackorder: true });
    expect(lineAllowsBackorder(sized, sized.variants[0], true)).toBe(true);
  });
  it('feature off: the gated payload shows sold out, and the server refuses', () => {
    const gated = gateBackorder(enrichStockFlags(sized), false);
    expect(gated.variants![0]).toMatchObject({ inStock: false, acceptsBackorder: false });
    expect(lineAllowsBackorder(sized, sized.variants[0], false)).toBe(false);
  });
  it('untracked stock with 0 on hand reads as in stock (isOrderable agrees)', () => {
    const p = { inventory: 0, allowBackorder: false, lowStockThreshold: 3, trackInventory: false };
    const flags = enrichStockFlags(p);
    expect(flags).toMatchObject({ inStock: true, lowStock: false, acceptsBackorder: false });
    expect(flags).not.toHaveProperty('trackInventory');
    expect(isOrderable(p, 1, false)).toBe(true);
  });
  it('gateBackorderPayload walks a response body and is a no-op when the feature is on', () => {
    const body = { products: [enrichStockFlags({ ...sized, variants: [] })] };
    expect(gateBackorderPayload(body, true)).toBe(body);
    const off = gateBackorderPayload(body, false);
    expect(off.products[0].acceptsBackorder).toBe(false);
    expect(off.products[0].availableQty).toBeNull();
  });
});

describe('every server backorder decision goes through lineAllowsBackorder / isOrderable', () => {
  const ROOT = join(__dirname, '../..');
  it.each([
    'apps/api/src/services/cart.service.ts',
    'apps/api/src/services/order.service.ts',
    'apps/api/src/routes/wa-bridge.routes.ts',
  ])('%s has no hand-rolled `variant ? variant.allowBackorder : product.allowBackorder`', f => {
    const src = readFileSync(join(ROOT, f), 'utf8');
    expect(src).not.toMatch(/\?\s*variant\.allowBackorder\s*:/);
    expect(src).not.toMatch(/variant\?\.allowBackorder\s*\?\?/);
    expect(src).not.toMatch(/\|\|\s*v\.allowBackorder\b/);
    expect(src).not.toMatch(/\|\|\s*p\.allowBackorder,/);
  });
});
