/**
 * Phase B2 Task 3, the cache rule (CLAUDE.md rule 3): the `on_sale` deals row reads PRICES, so it
 * declares a staleness class and rides an existing invalidation path. BOUNDED-stale: the same
 * `public:products:<storeId>:...` Redis key and `products:<storeId>` storefront tag as every other
 * listing, swept by invalidateStoreProductCaches on every product write path; class and residual
 * window are written at the resolver. Structural pins (the behavioural proof is
 * tests/integration/on-sale-source.test.ts, which needs the DB).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('on_sale: cache class and invalidation', () => {
  const route = read('apps/api/src/routes/public.routes.ts');
  const service = read('apps/api/src/services/product.service.ts');
  const cache = read('apps/api/src/lib/public-cache.ts');

  it('the public route allows the sort and keys the cache on it (a distinct entry per sort)', () => {
    expect(route).toMatch(/sortValue === 'on_sale'/);
    // main's key = the store prefix + a JSON of exactly the options the service receives, so the
    // sort is in it; on_sale then blanks page and cursor and clamps the limit (below)
    expect(route).toContain('JSON.stringify({ ...listOptions, semantic: semanticMode })');
    expect(route).toMatch(/sort: sortValue,/);
  });

  it('the key sits under the prefix invalidateStoreProductCaches sweeps', () => {
    // on_sale: no page / cursor in what is keyed (a crafted ?page=N mints nothing), and a limit
    // clamped to 1..12 (a negative ?limit=-N used to mint one key per N, final review M3)
    const sale = route.slice(
      route.indexOf("if (sortValue === 'on_sale') {\n      listOptions.page"),
      route.indexOf('const semanticMode')
    );
    expect(sale).toContain('listOptions.page = undefined');
    expect(sale).toContain('listOptions.cursor = undefined');
    expect(sale).toMatch(
      /Math\.min\(Math\.max\(1, parseInt\(limit as string, 10\) \|\| 12\), 12\)/
    );
    expect(route).toContain('`public:products:${storeId}:`');
    expect(cache).toMatch(
      /export async function clearProductsRedis[\s\S]*invalidateCachedPrefix\(`public:products:\$\{storeId\}:`\)/
    );
    expect(cache).toMatch(/revalidateStorefront\(\{\s*tags: \[`products:\$\{storeId\}`/);
  });

  it('the resolver states its class and residual window, and adds no cache layer', () => {
    const at = service.indexOf("if (sort === 'on_sale') {");
    expect(at).toBeGreaterThan(0);
    const comment = service.slice(service.lastIndexOf('// `sort=on_sale`'), at);
    expect(comment).toContain('CACHE CLASS: BOUNDED-stale');
    expect(comment).toContain('invalidateStoreProductCaches');
    expect(comment).toMatch(/residual window/);
    const body = service.slice(at, at + 3600);
    expect(body).not.toMatch(/getCached|redis|new Map\(/i);
  });

  it('every product write path the deals row depends on funnels through the invalidator', () => {
    // the private wrapper calls the shared invalidator; the writers call the wrapper
    expect(service).toMatch(
      /private static async invalidateStoreProductCache[\s\S]*await invalidateStoreProductCaches\(storeId\)/
    );
    for (const fn of ['static async update(', 'static async create(', 'static async delete(']) {
      const start = service.indexOf(fn);
      expect(start, fn).toBeGreaterThan(0);
      const next = service.indexOf('\n  static async ', start + 10);
      expect(service.slice(start, next > 0 ? next : undefined), fn).toMatch(
        /invalidateStoreProductCache\(/
      );
    }
  });

  it('the source is store-keyed, active only, not deleted, capped, explicit columns', () => {
    const at = service.indexOf('SELECT p.id');
    const sql = service.slice(at, service.indexOf('LIMIT ${limit}', at) + 20);
    expect(sql).toContain('p.store_id = ${storeId}');
    expect(sql).toContain("p.status = 'active'");
    expect(sql).toContain('p.deleted_at IS NULL');
    expect(sql).not.toContain('SELECT *');
    expect(service).toMatch(/export const ON_SALE_MAX = 12;/);
  });
});

describe('on_sale: scalar sort at the edge, filters inside the SQL, B2B hook', () => {
  const service = read('apps/api/src/services/product.service.ts');
  const route = read('apps/api/src/routes/public.routes.ts');
  it('the route validates sort with Zod (no hand-rolled allow-list) and refuses unsupported combos', () => {
    expect(route).toContain('parseOptionalSortQuery(sort)');
    expect(route).toContain("if (sortValue === 'on_sale') assertOnSaleQuery(req.query);");
    expect(route).not.toMatch(/sort === 'newest' \|\|/);
  });
  it('category and ids are predicates of the statement itself, before the LIMIT', () => {
    const at = service.indexOf('SELECT p.id');
    const sql = service.slice(at, service.indexOf('LIMIT ${limit}', at));
    expect(sql).toContain('${categorySql}');
    expect(sql).toContain('${idsSql}');
    expect(service).toMatch(/pc\.category_id = \$\{resolvedCategoryId\}/);
    expect(service).toMatch(/p\.id = ANY\(\$\{safeIds\}::text\[\]\)/);
  });
  it('names the B2B visibility hook inside the SQL and points at feat/b2b-wholesale', () => {
    const at = service.indexOf('SELECT p.id');
    const sql = service.slice(at, service.indexOf('LIMIT ${limit}', at));
    expect(sql).toContain('${onSaleVisibility}');
    expect(service).toContain('ON_SALE_VISIBILITY_PREDICATE');
    expect(service).toContain('TODO(feat/b2b-wholesale)');
  });
  it('skips facets and ignores a cursor for on_sale', () => {
    expect(service).toMatch(/sort === 'on_sale'\s*\? Promise\.resolve\(\[\] as ProductFacet\[\]\)/);
    expect(service).toContain("const cursor = sort === 'on_sale' ? undefined : options.cursor;");
  });
});
