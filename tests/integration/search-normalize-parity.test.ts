/**
 * Parity: SQL `public.ebda_ar_norm` (migration 20261019000100_search_normalisation) must return
 * EXACTLY what `normalizeArabicSearch` (@ebda/shared) returns. The expression trigram indexes
 * store the SQL output and the query side builds its LIKE tokens with the TS function, so any
 * drift makes a search silently miss rows. Every NORMALIZE_VECTORS row and a seeded generated
 * sample run through both. The planner case runs SET LOCAL inside ONE transaction (a bare
 * SET LOCAL outside a transaction has no effect and may land on another pooled connection).
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { prisma, Prisma } from '@ebda/database';
import { AR_FOLD_FROM, AR_FOLD_TO, NORMALIZE_VECTORS, normalizeArabicSearch } from '@ebda/shared';
import { hasDb } from '../helpers/bundle-fixtures';
import { productSearchSql } from '../../apps/api/src/services/product-search.service';

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

  it('the planner can use both doc indexes for a normalised LIKE', async () => {
    const ROLLBACK = Symbol('rollback');
    const plans: string[] = [];
    await prisma
      .$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        for (const sql of [
          `EXPLAIN (COSTS OFF) SELECT id FROM products WHERE public.ebda_product_search_doc(name, name_ar, search_terms, description, description_ar) LIKE '%احذيه%'`,
          `EXPLAIN (COSTS OFF) SELECT id FROM products WHERE public.ebda_product_name_doc(name, name_ar, search_terms) LIKE '%احذيه%'`,
        ]) {
          const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(sql);
          plans.push(rows.map(p => p['QUERY PLAN']).join('\n'));
        }
        throw ROLLBACK;
      })
      .catch(e => {
        if (e !== ROLLBACK) throw e;
      });
    expect(plans[0]).toContain('products_search_doc_trgm_idx');
    expect(plans[1]).toContain('products_name_doc_trgm_idx');
  });

  /**
   * The statements product-search.service actually runs (storefront list, typeahead, admin with
   * the SKU arm) must use the expression indexes too: a predicate written differently from its
   * index expression, or an unindexed OR arm, silently falls back to a sequential scan. The table
   * is filled (inside the rolled-back transaction) with one store's rows carrying ~330-char
   * descriptions, so the store_id btree + per-row normalisation filter loses by volume, then
   * ANALYZEd. (With empty descriptions the planner under-costs that filter and picks the store_id
   * index at 20k rows; measured: BitmapOr runs in ~1.7 ms on this fill.)
   */
  it('the planner uses the indexes for the storefront, typeahead and admin search statements', async () => {
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
          await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
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
    expect(plans.storefront).toContain('products_search_doc_trgm_idx');
    expect(plans.typeahead).toContain('products_name_doc_trgm_idx');
    expect(plans.admin).toContain('products_search_doc_trgm_idx');
    expect(plans.admin).toContain('products_sku_norm_trgm_idx');
    expect(plans.admin).toContain('BitmapOr');
    for (const plan of Object.values(plans)) expect(plan).not.toContain('Seq Scan');
  }, 90_000);
});
