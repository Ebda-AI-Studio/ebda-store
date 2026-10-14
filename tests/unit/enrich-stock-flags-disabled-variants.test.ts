/**
 * #1103 — the storefront's stock flags follow the same rule as the shared
 * helpers: a disabled variant is not stock.
 *
 * `enrichStockFlags` is what every storefront listing and the PDP pass their
 * products through. It summed every variant, so a product whose only stock sat
 * on a disabled variant rendered "in stock" on the card and the PLP's in-stock
 * facet, while checkout (which cannot sell a disabled variant) refused it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  prisma: {},
}));

import { enrichStockFlags } from '@api/services/product.service';

const base = { id: 'p1', inventory: 0, allowBackorder: false, lowStockThreshold: 5 };

describe('enrichStockFlags — disabled variants (#1103)', () => {
  it('stock held only by a disabled variant reads out of stock', () => {
    const out = enrichStockFlags({
      ...base,
      variants: [
        { id: 'v1', inventory: 0, allowBackorder: false, isActive: true },
        { id: 'v2', inventory: 40, allowBackorder: false, isActive: false },
      ],
    });
    expect(out.inStock).toBe(false);
    expect(out.inventory).toBe(0);
  });

  it('counts active variants only, and marks the disabled variant itself not in stock', () => {
    const out = enrichStockFlags({
      ...base,
      variants: [
        { id: 'v1', inventory: 3, allowBackorder: false, isActive: true },
        { id: 'v2', inventory: 40, allowBackorder: true, isActive: false },
      ],
    });
    expect(out.inventory).toBe(3);
    expect(out.inStock).toBe(true);
    expect(out.lowStock).toBe(true);
    const [v1, v2] = out.variants as Array<Record<string, unknown>>;
    expect(v1.inStock).toBe(true);
    expect(v2.inStock).toBe(false);
    expect(v2.acceptsBackorder).toBe(false);
  });

  it('does not leak isActive into the storefront variant shape', () => {
    const out = enrichStockFlags({
      ...base,
      variants: [{ id: 'v1', inventory: 3, allowBackorder: false, isActive: true }],
    });
    expect(Object.keys((out.variants as object[])[0])).not.toContain('isActive');
  });

  it('a disabled variant allowing backorder does not make the product accept one', () => {
    const out = enrichStockFlags({
      ...base,
      variants: [
        { id: 'v1', inventory: 0, allowBackorder: false, isActive: true },
        { id: 'v2', inventory: 0, allowBackorder: true, isActive: false },
      ],
    });
    expect(out.acceptsBackorder).toBe(false);
  });
});
