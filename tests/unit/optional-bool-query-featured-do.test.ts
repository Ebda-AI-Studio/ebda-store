/**
 * Ported from tests/integration/optional-bool-query-featured.test.ts (Postgres + express/supertest). The route layer's
 * tri-state parse (absent -> undefined, 'true'/'false', garbage -> 400) is pinned by apps/api/src/lib/__tests__/query-params.test.ts;
 * what is exercised here is the SERVICE layer on the StoreDO schema (node:sqlite through prisma-lite, the wiring of
 * bulk-do-roundtrip.test.ts): the admin list, the storefront list and the admin advanced search.
 * `undefined` is no filter, `false` is the exact complement of `true` (issues 2318 / 2325), and the in-stock filter is
 * variant-aware with a disabled variant not counting as stock (#1103).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

const raw = openSqlite();
const lite = createPrismaLite(META, nodeSqlRunner(raw), 'store-do', { unscoped: true }) as any;
const STORE = '33333333-3333-4333-8333-333333333333';

// the D1 `Store` row is not a StoreDO model: the storefront list puts it back from its own source
const liteWithStoreRef = new Proxy(lite, {
  get: (t, p) =>
    p === 'store'
      ? { findUnique: async () => ({ id: STORE, name: 'bq', slug: 'bq' }) }
      : (t as Record<string | symbol, unknown>)[p],
});
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => liteWithStoreRef,
  storeWriter: async () => lite,
  storeStock: async () => ({}),
  storeRepo: async () => ({ backend: 'do' }),
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateStoreProductCaches: async () => undefined,
  getCached: async (_k: string, _t: number, fn: () => unknown) => fn(),
}));

import { ProductService } from '../../apps/api/src/services/product.service';

const FEATURED = 'bq-featured';
const PLAIN = 'bq-plain';
const SPECIAL = 'as-special'; // out of stock, on sale, new
const VAR_OOS = 'as-varoos'; // variant product: only a DISABLED variant has stock
const names = (r: { products: Array<{ name: string }> }) => r.products.map(p => p.name).sort();

beforeAll(() => {
  const ins = raw.prepare(
    `INSERT INTO products (id, store_id, name, slug, price, compare_at_price, inventory, track_inventory, featured, is_new, has_variants, status, audience)
     VALUES (?, '${STORE}', ?, ?, 1000, ?, ?, ?, ?, ?, ?, 'active', 'public')`
  );
  ins.run('p1', FEATURED, FEATURED, null, 5, 1, 1, 0, 0);
  ins.run('p2', PLAIN, PLAIN, null, 5, 1, 0, 0, 0);
  ins.run('p3', SPECIAL, SPECIAL, 1500, 0, 1, 0, 1, 0);
  ins.run('p4', VAR_OOS, VAR_OOS, null, 0, 1, 0, 0, 1);
  raw
    .prepare(
      `INSERT INTO product_variants (id, product_id, title, inventory, is_active, position) VALUES ('v1', 'p4', 'Disabled', 9, 0, 0)`
    )
    .run();
});

describe('optional boolean filters: featured (service layer)', () => {
  it('admin list: absent -> both featured and plain; true -> featured only; false -> plain only', async () => {
    const all = names(await ProductService.list(STORE, {}));
    expect(all).toEqual(expect.arrayContaining([FEATURED, PLAIN]));
    const t = names(await ProductService.list(STORE, { featured: true }));
    expect(t).toEqual([FEATURED]);
    const f = names(await ProductService.list(STORE, { featured: false }));
    expect(f).toContain(PLAIN);
    expect(f).not.toContain(FEATURED);
  });

  it('storefront list: absent and a non-featured sort return BOTH; true/false split them', async () => {
    const pub = (o: object) => ProductService.listPublic(STORE, o as never);
    expect(names(await pub({}))).toEqual(expect.arrayContaining([FEATURED, PLAIN]));
    expect(names(await pub({ sort: 'price_asc' }))).toEqual(
      expect.arrayContaining([FEATURED, PLAIN])
    );
    expect(names(await pub({ featured: true }))).toEqual([FEATURED]);
    const f = names(await pub({ featured: false }));
    expect(f).toContain(PLAIN);
    expect(f).not.toContain(FEATURED);
  });

  it('advanced search: absent -> all; featured true/false are exact complements', async () => {
    const s = (o: object) => ProductService.advancedSearch(STORE, o as never);
    const all = names(await s({}));
    const t = names(await s({ featured: true }));
    const f = names(await s({ featured: false }));
    expect(t).toEqual([FEATURED]);
    expect([...t, ...f].sort()).toEqual(all);
  });
});

describe('advanced search: every boolean filter honours false (issues 2318/2325)', () => {
  const s = async (o: object) =>
    names((await ProductService.advancedSearch(STORE, o as never)) as never);
  it('inStock=true / false split the catalogue, variant-aware', async () => {
    expect(await s({ inStock: true })).toEqual([FEATURED, PLAIN].sort());
    expect(await s({ inStock: false })).toEqual([SPECIAL, VAR_OOS].sort());
  });
  it('onSale=true / false split the catalogue', async () => {
    expect(await s({ onSale: true })).toEqual([SPECIAL]);
    expect(await s({ onSale: false })).toEqual([FEATURED, PLAIN, VAR_OOS].sort());
  });
  it('isNew=true / false split the catalogue', async () => {
    expect(await s({ isNew: true })).toEqual([SPECIAL]);
    expect(await s({ isNew: false })).toEqual([FEATURED, PLAIN, VAR_OOS].sort());
  });
});
