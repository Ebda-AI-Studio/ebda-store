/**
 * Ported from tests/integration/pdp-all-disabled-variants.test.ts (Postgres; the original is deleted). Issue 2147: the PDP select
 * pre-filtered variants to `isActive: true`, so a product whose variants are ALL disabled reached `enrichStockFlags` as variant-less
 * and inherited the parent `inventory` column (stocked at 50 as a simple product, then given variants that were all disabled, it read
 * "50 in stock" while checkout refused it).
 * The real `ProductService.getPublicBySlug` runs on the StoreDO schema (node:sqlite through prisma-lite, the wiring of
 * product-3d-models-do.test.ts): all variants disabled gives 0 / out of stock / an empty variant list; one active variant gives that
 * variant's stock and lists only it.
 * Mutation proof: put `where: { isActive: true }` back on PUBLIC_PRODUCT_DETAIL_SELECT's variants and the first case reads 50.
 */
import { describe, it, expect, vi } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

const STORE = '11111111-1111-4111-8111-111111111111';
const db = openSqlite();
const lite = createPrismaLite(META, nodeSqlRunner(db), 'store-do', { unscoped: true }) as any;

// the D1 `Store` record is not in the DO schema (storeRefFor reads it through the store's own backend): answer it here
const storeDbWithRef = new Proxy(lite, {
  get: (t, prop) =>
    prop === 'store'
      ? { findUnique: async () => ({ id: STORE, name: 'Abaya house', slug: 'abaya-house' }) }
      : t[prop],
});

vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => storeDbWithRef,
  storeWriter: async () => lite,
  storeRepo: async () => ({ backend: 'do' }),
}));
vi.mock('../../apps/api/src/lib/customer-directory', () => ({
  customerRows: async () => [],
}));
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => false },
}));
vi.mock('../../apps/api/src/services/gold-rate/public', () => ({
  publicGoldPricingForLines: async () => new Map(),
  publicGoldFields: async () => ({ goldPricing: null }),
}));

import { ProductService } from '../../apps/api/src/services/product.service';

type Pdp = {
  inventory: number;
  inStock: boolean;
  variants: Array<{ name?: string; title?: string; inStock: boolean }>;
};

let seq = 0;
function seed(variantsActive: boolean[]) {
  const n = ++seq;
  const slug = `abaya-${n}`;
  db.prepare(
    `INSERT INTO products (id, store_id, name, slug, price, status, inventory, has_variants) VALUES ('p-${n}', '${STORE}', 'Abaya', '${slug}', 10000, 'active', 50, 1)`
  ).run();
  variantsActive.forEach((isActive, i) => {
    db.prepare(
      `INSERT INTO product_variants (id, product_id, title, inventory, is_active, position) VALUES ('v-${n}-${i}', 'p-${n}', 'V${i}', 5, ${isActive ? 1 : 0}, ${i})`
    ).run();
  });
  return slug;
}

describe('PDP stock for a product whose variants are all disabled (issue 2147, store DB)', () => {
  it('reads 0 / out of stock, never the parent column, and lists no variants', async () => {
    const pdp = (await ProductService.getPublicBySlug(
      STORE,
      seed([false, false])
    )) as unknown as Pdp;
    expect(pdp.inventory).toBe(0);
    expect(pdp.inStock).toBe(false);
    expect(pdp.variants).toEqual([]);
  });

  it('with one active variant: stock is that variant, and only it is listed', async () => {
    const pdp = (await ProductService.getPublicBySlug(
      STORE,
      seed([false, true])
    )) as unknown as Pdp;
    expect(pdp.inventory).toBe(5);
    expect(pdp.inStock).toBe(true);
    expect(pdp.variants).toHaveLength(1);
    expect(pdp.variants[0]!.name ?? pdp.variants[0]!.title).toBe('V1');
  });
});
