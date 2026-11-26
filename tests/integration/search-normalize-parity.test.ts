/**
 * Parity: SQL `public.ebda_ar_norm` (migration 20261019000100_search_normalisation) must return
 * EXACTLY what `normalizeArabicSearch` (@ebda/shared) returns. The expression trigram indexes
 * store the SQL output and the query side builds its LIKE tokens with the TS function, so any
 * drift makes a search silently miss rows. planner-owner-ok: the one EXPLAIN here asserts the SQL SHAPE (the match is a call to ebda_product_search_ids), not index use, which search-lexical-rls-index.test.ts proves as ebda_app. Every NORMALIZE_VECTORS row and a seeded generated
 * sample run through both. The planner case runs SET LOCAL inside ONE transaction (a bare
 * SET LOCAL outside a transaction has no effect and may land on another pooled connection).
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { prisma, Prisma } from '@ebda/database';
import { AR_FOLD_FROM, AR_FOLD_TO, NORMALIZE_VECTORS, normalizeArabicSearch } from '@ebda/shared';
import {
  AR_FOLD_H_FROM,
  AR_FOLD_H_TO,
  normalizeArabicHamza,
} from '../../packages/shared/src/search';
import hamzaVectors from '../../packages/shared/src/foundation/vectors/arabic-hamza.json';
import { hasDb } from '../helpers/bundle-fixtures';
import { productSearchSql } from '../../apps/api/src/services/product-search.service';

const MIGRATION_H = path.resolve(
  __dirname,
  '../../packages/database/prisma/migrations/20261123200000_search_fold_hamza/migration.sql'
);
const MIGRATION = path.resolve(
  __dirname,
  '../../packages/database/prisma/migrations/20261019000100_search_normalisation/migration.sql'
);

/** mulberry32: deterministic, so a failing generated case reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every character either side treats specially, the boundaries just outside each class, plain
 * Arabic and Latin letters, and whitespace the normaliser must NOT touch.
 */
const ALPHABET: string[] = [
  ...AR_FOLD_FROM,
  ...AR_FOLD_TO,
  // strip class U+064B..U+065F, U+0670, U+0640, and its neighbours U+064A, U+0660, U+066F, U+0671
  ...Array.from({ length: 0x065f - 0x064b + 1 }, (_, i) => String.fromCodePoint(0x064b + i)),
  'ٰ',
  'ـ',
  'ي',
  '٠',
  'ٯ',
  'ٱ',
  ...'بتثجحخدذرزسشصضطظعغفقلمنءكي',
  ...'abcxyzAZ09%_\\-,.',
  ' ',
  ' ',
  ' ',
  '\t',
  '\n',
  '\r',
  ' ',
  ' ',
  '　',
  '﻿',
  '‏',
  'é',
  'İ',
  'ß',
  'Ⅻ',
];

function generatedSample(n: number, seed: number): string[] {
  const next = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = Math.floor(next() * 24);
    let s = '';
    for (let j = 0; j < len; j++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
    out.push(s);
  }
  return out;
}

describe('ebda_ar_norm migration mirrors the TS fold table', () => {
  it('the translate() strings are AR_FOLD_FROM / AR_FOLD_TO byte for byte', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(sql).toContain(`'${AR_FOLD_FROM}',\n      '${AR_FOLD_TO}'`);
  });
});

describe.skipIf(!hasDb)('ebda_ar_norm parity with normalizeArabicSearch', () => {
  it.each(NORMALIZE_VECTORS)('SQL and TS agree on %j', async (input, expected) => {
    const [row] = await prisma.$queryRaw<
      Array<{ n: string | null }>
    >`SELECT public.ebda_ar_norm(${input}) AS n`;
    expect(row.n).toBe(normalizeArabicSearch(input));
    expect(row.n).toBe(expected);
  });

  it('SQL and TS agree on a 2000-string generated sample', async () => {
    const sample = generatedSample(2000, 20261015);
    const rows = await prisma.$queryRaw<Array<{ i: number; n: string }>>`
      SELECT u.ord::int AS i, public.ebda_ar_norm(u.x) AS n
      FROM unnest(${sample}::text[]) WITH ORDINALITY AS u(x, ord)
      ORDER BY u.ord`;
    expect(rows).toHaveLength(sample.length);
    const mismatches = rows
      .filter(r => r.n !== normalizeArabicSearch(sample[r.i - 1]))
      .map(r => ({ input: sample[r.i - 1], sql: r.n, ts: normalizeArabicSearch(sample[r.i - 1]) }));
    expect(mismatches).toEqual([]);
  });

  it('NULL in, NULL out (STRICT); the doc functions treat NULL columns as empty', async () => {
    const [row] = await prisma.$queryRaw<
      Array<{ n: string | null; s: string; d: string }>
    >`SELECT public.ebda_ar_norm(NULL) AS n,
             public.ebda_product_search_doc('Abaya', NULL, 'جزمة', NULL, 'قطن ١٠٠') AS s,
             public.ebda_product_name_doc(NULL, 'أحذية', NULL) AS d`;
    expect(row.n).toBeNull();
    expect(row.s).toBe(normalizeArabicSearch('Abaya  جزمة  قطن ١٠٠'));
    expect(row.d).toBe('احذيه');
  });

  it('functions are IMMUTABLE (required for index expressions)', async () => {
    const rows = await prisma.$queryRaw<Array<{ proname: string; provolatile: string }>>`
      SELECT proname, provolatile FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('ebda_ar_norm','ebda_product_search_doc','ebda_product_name_doc')`;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.provolatile).toBe('i');
  });

  it('the three expression indexes exist and are valid', async () => {
    const rows = await prisma.$queryRaw<Array<{ relname: string; valid: boolean }>>`
      SELECT c.relname, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('products_search_doc_trgm_idx','products_name_doc_trgm_idx',
                          'products_sku_norm_trgm_idx')`;
    expect(rows.map(r => r.relname).sort()).toEqual([
      'products_name_doc_trgm_idx',
      'products_search_doc_trgm_idx',
      'products_sku_norm_trgm_idx',
    ]);
    expect(rows.every(r => r.valid)).toBe(true);
  });

  // (The former 'planner can use both doc indexes' case EXPLAINed as the OWNER with seq scans off.
  // As ebda_app those indexes were unusable for the inline predicate; index use is now proven by
  // search-lexical-rls-index.test.ts, which reads each index's scan counter as ebda_app.)

  /**
   * The statements product-search.service actually runs (storefront list, typeahead, admin with
   * the SKU arm). Since Task 14 (Ruling SEARCH-T14-1) the word-AND match runs inside the
   * SECURITY DEFINER `ebda_product_search_ids`, because as `ebda_app` the RLS barrier forbids the
   * trigram index for any non-LEAKPROOF predicate. This (owner-role) test therefore proves only
   * the SHAPE: the statement calls the function and does not scan `products` for the match. That
   * the indexes are really used under RLS is proven by search-lexical-rls-index.test.ts (index scan
   * counters read after running these statements as `ebda_app`). The table is filled with ~330-char
   * descriptions inside the rolled-back transaction, as before.
   */
  it('the storefront, typeahead and admin search statements match through ebda_product_search_ids', async () => {
    const ROLLBACK = Symbol('rollback');
    const tag = `pl${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const plans: Record<string, string> = {};
    await prisma
      .$transaction(
        async tx => {
          const owner = await tx.user.create({
            data: {
              email: `${tag}@x.test`,
              passwordHash: 'x',
              firstName: 'Pl',
              lastName: 'Owner',
              role: 'store_admin',
            },
          });
          const store = await tx.store.create({
            data: { name: tag, slug: tag, ownerId: owner.id },
          });
          await tx.$executeRaw`
          INSERT INTO public.products
            (id, store_id, name, name_ar, sku, description, slug, price, status, updated_at)
          SELECT ${tag} || '-' || g, ${store.id}, md5('n' || g), md5('a' || g), md5('s' || g),
                 repeat(md5('d' || g) || ' ', 10), ${tag} || '-' || g, 1000, 'active', now()
          FROM generate_series(1, 20000) g`;
          await tx.$executeRaw`ANALYZE public.products`;
          const cases = {
            storefront: productSearchSql(store.id, 'احذيه', { scope: 'storefront' }),
            typeahead: productSearchSql(store.id, 'احذيه', { scope: 'storefront', field: 'name' }),
            admin: productSearchSql(store.id, 'mug-٧٧', { scope: 'admin' }),
          };
          for (const [k, sql] of Object.entries(cases)) {
            const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(
              Prisma.sql`EXPLAIN (COSTS OFF) ${sql!}`
            );
            plans[k] = rows.map(p => p['QUERY PLAN']).join('\n');
          }
          throw ROLLBACK;
        },
        // Filling 20k rows maintains three GIN indexes: well past the 5 s interactive default.
        { timeout: 60_000, maxWait: 10_000 }
      )
      .catch(e => {
        if (e !== ROLLBACK) throw e;
      });
    for (const plan of Object.values(plans)) {
      expect(plan).toContain('ebda_product_search_ids');
      expect(plan).not.toContain('Seq Scan on products');
    }
  }, 90_000);
});

// ---- fold A (hamza fold, Ruling F7-HAMZA-2): ebda_ar_norm_h, migration 20261123200000_search_fold_hamza ----
// ebda_ar_norm (fold B) above is untouched; these cases pin the second fold and its two indexes.
const ALPHABET_H: string[] = [
  ...AR_FOLD_H_FROM,
  ...AR_FOLD_H_TO,
  'ء',
  'ئ',
  'ؤ',
  'و',
  'و',
  'و',
  'ﻻ',
  'ﻣ',
  'ﺣ',
  '１',
  'Ａ',
  'ﷲ',
  ' ',
  '　',
  ' ',
  ' ',
  '\t',
  '\n',
  'ـ',
  'َ',
  'ٰ',
  'é',
  'Ⅻ',
  '¹',
];

describe('ebda_ar_norm_h migration mirrors the TS fold-A table', () => {
  it('the translate() strings are AR_FOLD_H_FROM / AR_FOLD_H_TO byte for byte, NFKC first', () => {
    const sql = fs.readFileSync(MIGRATION_H, 'utf8');
    expect(sql).toContain(`'${AR_FOLD_H_FROM}',\n        '${AR_FOLD_H_TO}'`);
    expect(sql).toContain('normalize(t, NFKC)');
  });
});

describe.skipIf(!hasDb)('ebda_ar_norm_h parity with normalizeArabicHamza', () => {
  it.each(hamzaVectors.cases as Array<[string, string]>)(
    'SQL and TS agree on %j',
    async (input, expected) => {
      const [row] = await prisma.$queryRaw<
        Array<{ n: string | null }>
      >`SELECT public.ebda_ar_norm_h(${input}) AS n`;
      expect(row.n).toBe(normalizeArabicHamza(input));
      expect(row.n).toBe(expected);
    }
  );

  it('SQL and TS agree on a 3000-string generated sample', async () => {
    const next = rng(20261123);
    const sample: string[] = [];
    for (let i = 0; i < 3000; i++) {
      let s = '';
      const len = Math.floor(next() * 24);
      for (let j = 0; j < len; j++) s += ALPHABET_H[Math.floor(next() * ALPHABET.length)];
      sample.push(s);
    }
    const rows = await prisma.$queryRaw<Array<{ i: number; n: string }>>`
      SELECT u.ord::int AS i, public.ebda_ar_norm_h(u.x) AS n
      FROM unnest(${sample}::text[]) WITH ORDINALITY AS u(x, ord) ORDER BY u.ord`;
    const mismatches = rows
      .filter(r => r.n !== normalizeArabicHamza(sample[r.i - 1]))
      .map(r => ({ input: sample[r.i - 1], sql: r.n, ts: normalizeArabicHamza(sample[r.i - 1]) }));
    expect(mismatches).toEqual([]);
  });

  it('the fold-A functions are IMMUTABLE and the two fold-A indexes exist and are valid', async () => {
    const fns = await prisma.$queryRaw<Array<{ proname: string; provolatile: string }>>`
      SELECT proname, provolatile FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('ebda_ar_norm_h','ebda_product_search_doc_h','ebda_product_name_doc_h')`;
    expect(fns).toHaveLength(3);
    for (const r of fns) expect(r.provolatile).toBe('i');
    const idx = await prisma.$queryRaw<Array<{ relname: string; valid: boolean }>>`
      SELECT c.relname, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('products_search_doc_h_trgm_idx','products_name_doc_h_trgm_idx')`;
    expect(idx.map(r => r.relname).sort()).toEqual([
      'products_name_doc_h_trgm_idx',
      'products_search_doc_h_trgm_idx',
    ]);
    expect(idx.every(r => r.valid)).toBe(true);
  });
});
