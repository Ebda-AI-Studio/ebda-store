/**
 * Raw-SQL visibility checklist (B2B Task 6, Ruling B2B-7b; coordinator note on the Souq / search integration).
 *
 * `products.audience = 'wholesale_only'` must be invisible to anonymous buyers EVERYWHERE, including raw SQL that Prisma's
 * `where` cannot reach. The predicate has to sit INSIDE the statement, BEFORE its LIMIT: filtering afterwards lets hidden
 * products occupy the result slots (a 12-item strip with 12 hidden products renders empty) and leaks their existence through
 * counts and truncation flags. This test lists EVERY raw statement in apps/api/src that reads the products table and every
 * SQL function in the migrations that does, and requires either the audience predicate or a classified exemption. A new raw
 * product query without either turns it red. Each bypass is planted below.
 *
 * INTEGRATION POINTS for branches that have not merged here (they add raw product SQL this scan cannot see yet):
 *  - feat/b2-souq: the `sort=on_sale` raw-SQL product source (lib/query-params.ts `on_sale`, routes/public.routes.ts
 *    `assertOnSaleQuery`, and the SQL behind it). Its named visibility hook MUST AND `p.audience = 'public'` into the SQL
 *    before the LIMIT 12. When that branch merges, its statement appears in this scan; it needs the predicate, not an exemption.
 *  - feat/search-p1c-hybrid: `public.ebda_product_search_ids(...)` (migration 20261024000300_search_ids_definer) is a SECURITY
 *    DEFINER function whose inner SELECT runs the word-AND match. The storefront scope must pass a public-only flag into the
 *    function (new migration that adds the predicate inside the function body), and `product-search.service.ts` calls it with
 *    that flag for scope 'storefront'. The migration scan below makes a function without the predicate (and without an exemption
 *    here) fail.
 *  - the semantic-search query over `product_embeddings` (feat/semantic-search, feat/search-p1b): join products and filter
 *    `p.audience = 'public'` in the nearest-neighbour query BEFORE its LIMIT (a post-filter would also break recall). The
 *    embedding rows themselves are not a leak (nothing reads them without joining products), so they stay in the index.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  scanRawProductQueries,
  scanSourceForProductSql,
  scanMigrationFunctions,
  type RawProductQuery,
} from '../helpers/raw-product-sql-scan';

const API_SRC = process.env.B2B_API_SRC ?? resolve(__dirname, '../../apps/api/src');
const MIGRATIONS = resolve(__dirname, '../../packages/database/prisma/migrations');

type Kind = 'public' | 'admin' | 'system';
/** file -> number of raw statements reading products, classified. 'public' requires the predicate in EVERY statement. */
const CLASSIFIED: Record<
  string,
  { statements: number; kind: Kind; reason: string; publicStatements?: number }
> = {
  'services/gold-rate/repricer.ts': {
    statements: 1,
    kind: 'system',
    reason:
      'Ruling B5-13: the repricer UPDATEs gold-priced rows by id inside the store scope; it returns no product data to any caller',
  },
  'services/product-search.service.ts': {
    statements: 3,
    kind: 'public',
    publicStatements: 2,
    reason:
      'productSearchSql (storefront scope) and the vector leg of the hybrid ranking both carry p.audience = public in the WHERE, before their LIMIT (the SECURITY DEFINER id function only returns candidate ids; the outer statement filters); the SKU variant lookup is warehouse-admin only',
  },
  'lib/effective-inventory-sql.ts': {
    statements: 1,
    kind: 'admin',
    reason: 'stock valuation SQL fragment used by merchant inventory reports',
  },
  'services/inventory.service.ts': {
    statements: 5,
    kind: 'admin',
    reason: 'merchant inventory reports',
  },
  // the finance dashboard's stock-value statement moved out of the route into its Postgres twin (Ruling NZ-FEAT-1)
  'services/accounting/dashboard-stock.ts': {
    statements: 1,
    kind: 'admin',
    reason: 'merchant P&L / balance sheet (finance dashboard stock value)',
  },
  'services/analytics.service.ts': { statements: 2, kind: 'admin', reason: 'merchant analytics' },
  'services/warehouse.service.ts': {
    statements: 4,
    kind: 'admin',
    reason: 'warehouse stock sync / search (merchant)',
  },
  'services/accounting/purchase-order.service.ts': {
    statements: 1,
    kind: 'system',
    reason: 'row lock by id (SELECT id ... FOR UPDATE) for a purchase-order receipt, store-scoped',
  },
  'services/product-index.service.ts': {
    statements: 7,
    kind: 'system',
    reason: 'embedding indexer (background); search results join products and filter at QUERY time',
  },
  'services/inventory-decrement.ts': {
    statements: 1,
    kind: 'system',
    reason: 'stock decrement inside the order transaction',
  },
  'services/accounting/backorder-stock-heal.ts': {
    statements: 1,
    kind: 'system',
    reason: 'stock heal by id',
  },
  'services/ai-autofill.service.ts': {
    statements: 1,
    kind: 'system',
    reason: 'row lock by id for AI autofill',
  },
  'lib/inngest/functions/order-refunded.ts': {
    statements: 1,
    kind: 'system',
    reason: 'stock restore on refund',
  },
  'services/barcode.service.ts': {
    statements: 1,
    kind: 'admin',
    reason:
      'merchant-side barcode allocator: highest in-store serial across ALL the store products',
  },
  'lib/inngest/functions/store-usage-snapshot.ts': {
    statements: 1,
    kind: 'system',
    reason: 'usage counters (platform)',
  },
};

/** Functions in migrations that read products and are exempt (all pre-date audience and are admin / system). */
const EXEMPT_MIGRATIONS = new Set<string>(
  scanMigrationFunctions(MIGRATIONS)
    .filter(f => !f.hasAudiencePredicate)
    .map(f => f.migration)
    // everything before the audience column existed, plus the gold price guard (Ruling B5-13): its trigger
    // function reads ONE product's pricing_mode by id to guard a write and returns no product data
    .filter(m => m < '20261028' || m === '20261102000200_gold_rate_pricing')
);

function evaluate(queries: readonly RawProductQuery[]): string[] {
  const out: string[] = [];
  const perFile = new Map<string, RawProductQuery[]>();
  for (const q of queries) perFile.set(q.file, [...(perFile.get(q.file) ?? []), q]);
  for (const [file, qs] of perFile) {
    const c = CLASSIFIED[file];
    if (!c) {
      for (const q of qs) {
        if (!q.hasAudiencePredicate)
          out.push(
            `${file}:${q.line} (${q.symbol}) reads products with no audience predicate and no exemption`
          );
      }
      continue;
    }
    if (qs.length !== c.statements)
      out.push(`${file}: ${qs.length} product statements, classification pins ${c.statements}`);
    const withPredicate = qs.filter(q => q.hasAudiencePredicate).length;
    if (c.kind === 'public' && withPredicate !== (c.publicStatements ?? c.statements)) {
      out.push(
        `${file}: ${withPredicate} statements carry the audience predicate, expected ${c.publicStatements ?? c.statements}`
      );
    }
  }
  for (const f of Object.keys(CLASSIFIED))
    if (!perFile.has(f)) out.push(`${f}: classified but no longer reads products (remove it)`);
  return out;
}

describe('B2B raw-SQL product visibility checklist', () => {
  it('every raw statement reading products is classified, and the storefront search carries the predicate', () => {
    expect(evaluate(scanRawProductQueries(API_SRC))).toEqual([]);
  });

  it('the storefront search predicate sits BEFORE the LIMIT, in the WHERE', () => {
    const src = require('node:fs').readFileSync(
      resolve(API_SRC, 'services/product-search.service.ts'),
      'utf8'
    ) as string;
    const stmt = src.slice(src.indexOf('return Prisma.sql`SELECT p.id FROM products p'));
    const whereAt = stmt.indexOf('WHERE');
    const audienceAt = stmt.indexOf('${audience}');
    const limitAt = stmt.indexOf('LIMIT');
    expect(whereAt).toBeGreaterThan(-1);
    expect(audienceAt).toBeGreaterThan(whereAt);
    expect(audienceAt).toBeLessThan(limitAt);
    expect(src).toMatch(/storefront \? Prisma\.sql`AND p\.audience = 'public'`/);
    // the vector leg of the hybrid ranking (storefront only) filters before ITS limit too
    expect(src).toMatch(/AND p\.audience = 'public'\n\s+\) k/);
  });

  it('SQL functions in migrations that read products: all pre-date audience (exempt) or carry the predicate', () => {
    const bad = scanMigrationFunctions(MIGRATIONS).filter(
      f => !f.hasAudiencePredicate && !EXEMPT_MIGRATIONS.has(f.migration)
    );
    expect(bad).toEqual([]);
  });

  it('the Prisma-level public product queries carry the audience filter (pinned counts per file)', () => {
    // Prisma queries are not raw SQL, but the same rule applies. Pinned so removing one is a visible test change.
    const fs = require('node:fs') as typeof import('node:fs');
    const count = (f: string) =>
      (fs.readFileSync(resolve(API_SRC, f), 'utf8').match(/audience: 'public'/g) ?? []).length;
    expect(count('services/product.service.ts')).toBeGreaterThanOrEqual(10);
    // recommendation reads go through the shared helper (review C1); the exact per-read check is b2b-prisma-product-read-visibility
    const helperUses = (
      fs
        .readFileSync(resolve(API_SRC, 'services/recommendation.service.ts'), 'utf8')
        .match(/visibleProductWhere\(\)/g) ?? []
    ).length;
    expect(helperUses).toBeGreaterThanOrEqual(9);
    expect(count('routes/wishlist.routes.ts')).toBeGreaterThanOrEqual(1);
  });

  describe('planted bypasses go red', () => {
    it('a new raw query in a new file without the predicate', () => {
      const hits = scanSourceForProductSql(
        'services/on-sale.ts',
        'const r = await prisma.$queryRaw`SELECT p.id FROM products p WHERE p.store_id = ${s} LIMIT 12`;'
      );
      expect(evaluate(hits).filter(v => v.includes('services/on-sale.ts'))).toEqual([
        expect.stringContaining('no audience predicate and no exemption'),
      ]);
    });
    it('the same query WITH the predicate passes', () => {
      const hits = scanSourceForProductSql(
        'services/on-sale.ts',
        "const r = await prisma.$queryRaw`SELECT p.id FROM products p WHERE p.store_id = ${s} AND p.audience = 'public' LIMIT 12`;"
      );
      expect(evaluate(hits).filter(v => v.includes('services/on-sale.ts'))).toEqual([]);
    });
    it('a Prisma.sql fragment and $queryRawUnsafe are scanned too', () => {
      expect(
        scanSourceForProductSql('x.ts', 'const f = Prisma.sql`SELECT 1 FROM public.products p`;')
      ).toHaveLength(1);
      expect(
        scanSourceForProductSql('x.ts', "await prisma.$queryRawUnsafe('SELECT 1 FROM products');")
      ).toHaveLength(1);
      expect(
        scanSourceForProductSql('x.ts', 'await prisma.$queryRaw`SELECT 1 FROM product_variants`;')
      ).toEqual([]);
    });
    it('an extra statement in a classified file changes the pinned count', () => {
      const fake: RawProductQuery[] = Array.from({ length: 3 }, (_, i) => ({
        file: 'services/inventory.service.ts',
        symbol: 's',
        line: i,
        hasAudiencePredicate: false,
      }));
      expect(evaluate(fake).join()).toMatch(/3 product statements, classification pins 5/);
    });
    it('the public search losing its predicate is caught', () => {
      const fake: RawProductQuery[] = [
        {
          file: 'services/product-search.service.ts',
          symbol: 'productSearchSql',
          line: 1,
          hasAudiencePredicate: false,
        },
        {
          file: 'services/product-search.service.ts',
          symbol: 'vectorLeg',
          line: 2,
          hasAudiencePredicate: false,
        },
        {
          file: 'services/product-search.service.ts',
          symbol: 'rows',
          line: 3,
          hasAudiencePredicate: false,
        },
      ];
      expect(evaluate(fake).join()).toMatch(
        /0 statements carry the audience predicate, expected 2/
      );
    });
  });
});
