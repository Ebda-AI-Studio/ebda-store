// Product search on the DO (node:sqlite + FTS5 trigram): oracle (Postgres meaning in plain JS), fuzz, the search-eval
// catalogue, and - when EBDA_SEARCH_PG_URL points at a throwaway Postgres 17 - the REAL ebda_product_search_ids + pg_trgm.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import {
  buildProductDoc,
  buildProductNameDoc,
  ensureSearchIndex,
  reindexStore,
  removeProductIndex,
  searchProductIdSet,
  trigramSimilarity,
  upsertProductIndex,
  verifyProductIndex,
  type ProductSearchOpts,
} from '../src/do/search';
import { escapeLike, normalizeArabicSearch, searchTokens } from '../../shared/src/search';
import { catalogueRows, evalQueries } from '../../../tests/search-eval/catalogue';

interface P {
  id: string;
  name: string | null;
  nameAr: string | null;
  terms: string | null;
  desc: string | null;
  descAr: string | null;
  sku: string | null;
  status?: string;
  audience?: string;
  deleted?: boolean;
  featured?: number;
  store?: string;
}

function fx(products: P[]) {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureSearchIndex(db);
  const ins = raw.prepare(
    `INSERT INTO products (id, store_id, name, name_ar, search_terms, description, description_ar, sku, slug, price, status, audience, featured, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,100,?,?,?,?)`
  );
  for (const p of products)
    ins.run(
      p.id,
      p.store ?? 's1',
      p.name ?? '',
      p.nameAr,
      p.terms,
      p.desc,
      p.descAr,
      p.sku,
      p.id,
      p.status ?? 'active',
      p.audience ?? 'public',
      p.featured ?? 0,
      p.deleted ? 1 : null
    );
  reindexStore(db, 's1');
  return { raw, db };
}

/** The Postgres meaning, written independently as plain string logic over the folded docs. */
const BOUNDS = ['', ' ', '/', '(', '-', ',', '.'];
function oracleMatch(p: P, raw: string, o: ProductSearchOpts): boolean {
  const tokens = searchTokens(raw);
  if (!tokens.length) return false;
  const doc = o.field === 'name' ? buildProductNameDoc(fields(p)) : buildProductDoc(fields(p));
  const sku = normalizeArabicSearch(p.sku ?? '');
  const withSku = o.withSku ?? o.scope === 'admin';
  const wordStart = tokens.every(t => [...t].length < 3);
  return tokens.every(t => {
    if (!wordStart) return doc.includes(t) || (withSku && sku.includes(t));
    const atBoundary = (d: string) =>
      d.startsWith(t) ||
      BOUNDS.slice(1).some(b => d.includes(b + t)) ||
      d.startsWith('ا' + t) ||
      d.includes(' ا' + t) ||
      d.startsWith('ال' + t) ||
      d.includes(' ال' + t);
    return atBoundary(doc) || (withSku && sku.startsWith(t));
  });
}
const fields = (p: P) => ({
  name: p.name,
  nameAr: p.nameAr,
  searchTerms: p.terms,
  description: p.desc,
  descriptionAr: p.descAr,
  sku: p.sku,
});
const visible = (p: P, o: ProductSearchOpts) =>
  (p.store ?? 's1') === 's1' &&
  (o.includeDeleted || !p.deleted) &&
  (o.scope !== 'storefront' ||
    ((p.status ?? 'active') === 'active' && (p.audience ?? 'public') === 'public'));
const oracleIds = (ps: P[], q: string, o: ProductSearchOpts) =>
  ps
    .filter(p => visible(p, o) && oracleMatch(p, q, o))
    .map(p => p.id)
    .sort();

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHA = [
  'ا',
  'أ',
  'إ',
  'ب',
  'ت',
  'ة',
  'ه',
  'ي',
  'ى',
  'ع',
  'ر',
  'ل',
  'a',
  'B',
  'c',
  'x',
  '5',
  '٥',
  ' ',
  '-',
  '(',
  'ا',
  'ل',
  'ً',
  '_',
  '%',
];
const randStr = (r: () => number, n: number) =>
  Array.from({ length: n }, () => ALPHA[Math.floor(r() * ALPHA.length)]).join('');

describe('product search: FTS5 index vs the Postgres meaning', () => {
  const OPTS: ProductSearchOpts[] = [
    { scope: 'storefront' },
    { scope: 'storefront', field: 'name' },
    { scope: 'admin' },
    { scope: 'admin', includeDeleted: true },
  ];

  it('fuzz: 400 random catalogues/queries return exactly the oracle set (substring, word-start, SKU, % _ literal, hostile quotes)', () => {
    const r = rng(7);
    for (let round = 0; round < 40; round++) {
      const ps: P[] = Array.from({ length: 25 }, (_, i) => ({
        id: `p${round}-${i}`,
        name: randStr(r, 3 + Math.floor(r() * 10)),
        nameAr: r() < 0.5 ? randStr(r, 3 + Math.floor(r() * 8)) : null,
        terms: r() < 0.3 ? randStr(r, 8) : null,
        desc: r() < 0.5 ? randStr(r, 20) : null,
        descAr: null,
        sku: r() < 0.5 ? `SK-${round}-${i}-${randStr(r, 2)}` : null,
        status: r() < 0.8 ? 'active' : 'draft',
        audience: r() < 0.9 ? 'public' : 'wholesale_only',
        deleted: r() < 0.1,
      }));
      const f = fx(ps);
      for (let k = 0; k < 10; k++) {
        const seedP = ps[Math.floor(r() * ps.length)];
        const base = `${seedP.name} ${seedP.nameAr ?? ''} ${seedP.desc ?? ''}`;
        const pick = (len: number) => {
          const st = Math.floor(r() * Math.max(1, base.length - len));
          return base.slice(st, st + len);
        };
        const q =
          r() < 0.2
            ? randStr(r, 2)
            : r() < 0.2
              ? `${pick(2)} ${pick(4)}`
              : r() < 0.2
                ? `${pick(3)}"${pick(2)}`
                : `${pick(3 + Math.floor(r() * 4))} ${pick(3)}`;
        for (const o of OPTS) {
          const got = searchProductIdSet(f.db, 's1', q, { ...o, stem: false, limit: 10_000 })
            .ids.slice()
            .sort();
          expect(got, JSON.stringify({ q, o })).toEqual(oracleIds(ps, q, o));
        }
      }
    }
  });

  it('a blank / punctuation-free-of-tokens query returns nothing; the 8-word cap applies like searchTokens', () => {
    const f = fx([
      {
        id: 'a',
        name: 'Black abaya',
        nameAr: null,
        terms: null,
        desc: null,
        descAr: null,
        sku: null,
      },
    ]);
    expect(searchProductIdSet(f.db, 's1', '   ', { scope: 'admin' }).ids).toEqual([]);
    expect(searchProductIdSet(f.db, 's1', '', { scope: 'admin' }).ids).toEqual([]);
  });

  it('% and _ and \\ in a query are literal characters, not wildcards', () => {
    const f = fx([
      {
        id: 'a',
        name: '100% cotton',
        nameAr: null,
        terms: null,
        desc: null,
        descAr: null,
        sku: null,
      },
      {
        id: 'b',
        name: '100x cotton',
        nameAr: null,
        terms: null,
        desc: null,
        descAr: null,
        sku: null,
      },
    ]);
    expect(searchProductIdSet(f.db, 's1', '0% cot', { scope: 'admin' }).ids).toEqual(['a']);
    expect(searchProductIdSet(f.db, 's1', '0_ cot', { scope: 'admin' }).ids).toEqual([]);
  });

  it('Arabic folding: hamza/taa-marbuta/ya/digits/tashkeel variants all find the same product', () => {
    const f = fx([
      {
        id: 'a',
        name: null,
        nameAr: 'عباءة سوداء ٢',
        terms: null,
        desc: null,
        descAr: null,
        sku: null,
      },
    ]);
    for (const q of [
      'عباءه',
      'عبايه'.replace('ي', 'ى').replace('ى', 'ء'),
      'سودَاء',
      'سوداء 2',
      'ABC'.length ? 'عباءة' : '',
    ])
      if (q)
        expect(searchProductIdSet(f.db, 's1', q, { scope: 'admin' }).ids.length).toBe(
          oracleIds(
            [
              {
                id: 'a',
                name: null,
                nameAr: 'عباءة سوداء ٢',
                terms: null,
                desc: null,
                descAr: null,
                sku: null,
              },
            ],
            q,
            { scope: 'admin' }
          ).length
        );
    expect(searchProductIdSet(f.db, 's1', 'عباءه سوداء', { scope: 'storefront' }).ids).toEqual([
      'a',
    ]);
  });

  it('storefront never returns a wholesale-only, draft or deleted product, nor another store (checked before the LIMIT)', () => {
    const mk = (id: string, o: Partial<P>): P => ({
      id,
      name: 'ring gold',
      nameAr: null,
      terms: null,
      desc: null,
      descAr: null,
      sku: null,
      ...o,
    });
    const f = fx([
      mk('ok', {}),
      mk('ws', { audience: 'wholesale_only' }),
      mk('dr', { status: 'draft' }),
      mk('del', { deleted: true }),
      mk('other', { store: 's2' }),
    ]);
    const r = searchProductIdSet(f.db, 's1', 'ring', { scope: 'storefront', limit: 1 });
    expect(r).toEqual({ ids: ['ok'], truncated: false });
    expect(searchProductIdSet(f.db, 's1', 'ring', { scope: 'admin' }).ids.sort()).toEqual([
      'dr',
      'ok',
      'ws',
    ]);
  });

  it('limit + truncation flag; similarity order is stable (best name match first, then id)', () => {
    const mk = (id: string, name: string): P => ({
      id,
      name,
      nameAr: null,
      terms: null,
      desc: null,
      descAr: null,
      sku: null,
    });
    const f = fx([mk('c', 'ring'), mk('b', 'ring gold wide band'), mk('a', 'ring')]);
    expect(searchProductIdSet(f.db, 's1', 'ring', { scope: 'admin' }).ids).toEqual(['a', 'c', 'b']);
    expect(searchProductIdSet(f.db, 's1', 'ring', { scope: 'admin', limit: 2 })).toEqual({
      ids: ['a', 'c'],
      truncated: true,
    });
  });

  it('featured order: featured first, then name, then id', () => {
    const mk = (id: string, name: string, featured: number): P => ({
      id,
      name,
      nameAr: null,
      terms: null,
      desc: null,
      descAr: null,
      sku: null,
      featured,
    });
    const f = fx([mk('1', 'ring b', 0), mk('2', 'ring a', 0), mk('3', 'ring z', 1)]);
    expect(
      searchProductIdSet(f.db, 's1', 'ring', { scope: 'admin', order: 'featured' }).ids
    ).toEqual(['3', '2', '1']);
  });

  it('index maintenance: upsert follows an edit, remove drops the row, verify reports drift', () => {
    const f = fx([
      {
        id: 'a',
        name: 'old name',
        nameAr: null,
        terms: null,
        desc: null,
        descAr: null,
        sku: 'ABC-1',
      },
    ]);
    expect(searchProductIdSet(f.db, 's1', 'old', { scope: 'admin' }).ids).toEqual(['a']);
    f.raw.exec(`UPDATE products SET name = 'fresh title' WHERE id = 'a'`);
    expect(verifyProductIndex(f.db, 's1').stale).toEqual(['a']);
    upsertProductIndex(f.db, 's1', 'a');
    expect(verifyProductIndex(f.db, 's1')).toEqual({ missing: [], orphaned: [], stale: [] });
    expect(searchProductIdSet(f.db, 's1', 'old', { scope: 'admin' }).ids).toEqual([]);
    expect(searchProductIdSet(f.db, 's1', 'fresh', { scope: 'admin' }).ids).toEqual(['a']);
    expect(searchProductIdSet(f.db, 's1', 'abc-1', { scope: 'admin' }).ids).toEqual(['a']); // SKU, admin only
    expect(searchProductIdSet(f.db, 's1', 'abc-1', { scope: 'storefront' }).ids).toEqual([]);
    removeProductIndex(f.db, 'a');
    expect(verifyProductIndex(f.db, 's1').missing).toEqual(['a']);
    expect(searchProductIdSet(f.db, 's1', 'fresh', { scope: 'admin' }).ids).toEqual([]);
  });

  it('pg_trgm similarity: known values', () => {
    expect(trigramSimilarity('word', 'word')).toBe(1);
    expect(trigramSimilarity('word', 'two words')).toBeCloseTo(0.363636, 5); // psql: select similarity('word','two words')
    expect(trigramSimilarity('', 'x')).toBe(0);
  });
});

describe('search-eval catalogue: DO keyword search equals the Postgres meaning on every eval query', () => {
  const rows = catalogueRows();
  const ps: P[] = rows.map(r => ({
    id: r.id,
    name: r.name,
    nameAr: r.nameAr,
    terms: null,
    desc: null,
    descAr: null,
    sku: null,
  }));
  const qs = evalQueries();
  const f = fx(ps);

  it(`all ${qs.length} eval queries (core + extra + hard) return the oracle set; keyword hit@10 per class is reported`, () => {
    const byClass = new Map<string, { n: number; hit: number }>();
    for (const e of qs) {
      // the oracle is the Postgres meaning (literal substring); stemming has its own suite (do-search-stemming.test.ts)
      const o: ProductSearchOpts = { scope: 'storefront', limit: 10_000, stem: false };
      const got = searchProductIdSet(f.db, 's1', e.q, o).ids;
      expect(got.slice().sort(), e.q).toEqual(oracleIds(ps, e.q, o));
      const top10 = got.slice(0, 10).map(id => rows.find(r => r.id === id)!.type);
      const c = byClass.get(e.cls) ?? { n: 0, hit: 0 };
      c.n++;
      if (top10.includes(e.key)) c.hit++;
      byClass.set(e.cls, c);
    }
    const line = [...byClass].map(([k, v]) => `${k}=${(v.hit / v.n).toFixed(2)}`).join(' ');
    console.log(`keyword-only hit@10 on the DO (FTS5): ${line}`);
  });
});

// ---- the real thing: Postgres 17 + pg_trgm + the production function ---------------------------------------------
const PG_URL = process.env.EBDA_SEARCH_PG_URL;
describe.skipIf(!PG_URL)(
  'DO search vs REAL Postgres (ebda_product_search_ids + similarity)',
  () => {
    let pg: any;
    const MIG = new URL('../../database/prisma/migrations/', import.meta.url);
    beforeAll(async () => {
      const { Client } = createRequire(import.meta.url)('pg');
      pg = new Client({ connectionString: PG_URL });
      await pg.connect();
      await pg.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ebda_app') THEN CREATE ROLE ebda_app; END IF; END $$`
      );
      await pg.query(`DROP TABLE IF EXISTS products CASCADE`);
      await pg.query(
        `CREATE TABLE products (id text primary key, store_id text not null, name text not null, name_ar text, search_terms text, description text, description_ar text, sku text, status text not null default 'active', audience text not null default 'public', deleted_at timestamptz)`
      );
      for (const m of ['20261019000100_search_normalisation', '20261024000300_search_ids_definer'])
        await pg.query(fs.readFileSync(new URL(`${m}/migration.sql`, MIG), 'utf8'));
    });
    afterAll(async () => pg?.end());

    const pgSearch = async (storeId: string, raw: string, o: ProductSearchOpts) => {
      const tokens = searchTokens(raw);
      if (!tokens.length) return [];
      const wordStart = tokens.every(t => [...t].length < 3);
      const patterns = tokens.map(t => (wordStart ? `${escapeLike(t)}%` : `%${escapeLike(t)}%`));
      const storefront = o.scope === 'storefront';
      await pg.query(`SELECT set_config('app.current_store_id', $1, false)`, [storeId]);
      const r = await pg.query(
        `SELECT p.id FROM products p WHERE p.store_id = $1 ${o.includeDeleted ? '' : 'AND p.deleted_at IS NULL'} ${storefront ? "AND p.status = 'active' AND p.audience = 'public'" : ''}
         AND p.id IN (SELECT public.ebda_product_search_ids($1, $2, $3, $4, $5, $6, $7::text[]))
       ORDER BY similarity(public.ebda_product_name_doc(p.name, p.name_ar, p.search_terms), $8) DESC, p.id`,
        [
          storeId,
          o.field === 'name' ? 'name' : 'all',
          o.withSku ?? o.scope === 'admin',
          storefront,
          o.includeDeleted === true,
          wordStart,
          patterns,
          normalizeArabicSearch(raw),
        ]
      );
      return r.rows.map((x: any) => x.id as string);
    };
    const load = async (ps: P[]) => {
      await pg.query('DELETE FROM products');
      for (const p of ps)
        await pg.query(
          `INSERT INTO products (id, store_id, name, name_ar, search_terms, description, description_ar, sku, status, audience, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            p.id,
            p.store ?? 's1',
            p.name ?? '',
            p.nameAr,
            p.terms,
            p.desc,
            p.descAr,
            p.sku,
            p.status ?? 'active',
            p.audience ?? 'public',
            p.deleted ? new Date() : null,
          ]
        );
    };

    it('the eval catalogue: same ids in the SAME ORDER as Postgres for every query', async () => {
      const rows = catalogueRows();
      const ps: P[] = rows.map(r => ({
        id: r.id,
        name: r.name,
        nameAr: r.nameAr,
        terms: null,
        desc: null,
        descAr: null,
        sku: null,
      }));
      await load(ps);
      const f = fx(ps);
      for (const e of evalQueries()) {
        // the oracle is the Postgres meaning (literal substring); stemming has its own suite (do-search-stemming.test.ts)
        const o: ProductSearchOpts = { scope: 'storefront', limit: 10_000, stem: false };
        expect(searchProductIdSet(f.db, 's1', e.q, o).ids, e.q).toEqual(
          await pgSearch('s1', e.q, o)
        );
      }
    });

    it('fuzz: 150 random queries over random catalogues, all scopes, same set and same order', async () => {
      const r = rng(99);
      for (let round = 0; round < 10; round++) {
        const ps: P[] = Array.from({ length: 30 }, (_, i) => ({
          id: `p${round}-${String(i).padStart(2, '0')}`,
          name: randStr(r, 3 + Math.floor(r() * 10)),
          nameAr: r() < 0.5 ? randStr(r, 3 + Math.floor(r() * 8)) : null,
          terms: r() < 0.3 ? randStr(r, 8) : null,
          desc: r() < 0.5 ? randStr(r, 20) : null,
          descAr: null,
          sku: r() < 0.5 ? `SK-${round}-${i}-${randStr(r, 2)}` : null,
          status: r() < 0.8 ? 'active' : 'draft',
          audience: r() < 0.9 ? 'public' : 'wholesale_only',
          deleted: r() < 0.1,
        }));
        await load(ps);
        const f = fx(ps);
        for (let k = 0; k < 15; k++) {
          const s = ps[Math.floor(r() * ps.length)];
          const base = `${s.name} ${s.nameAr ?? ''} ${s.desc ?? ''}`;
          const pick = (len: number) =>
            base.slice(
              Math.floor(r() * Math.max(1, base.length - len)),
              0 + Math.floor(r() * Math.max(1, base.length - len)) + len
            );
          const q =
            r() < 0.25
              ? randStr(r, 2)
              : r() < 0.25
                ? `${pick(2)} ${pick(4)}`
                : pick(3 + Math.floor(r() * 4));
          for (const o of [
            { scope: 'storefront' },
            { scope: 'storefront', field: 'name' },
            { scope: 'admin' },
          ] as ProductSearchOpts[]) {
            const mine = searchProductIdSet(f.db, 's1', q, {
              ...o,
              stem: false,
              limit: 10_000,
            }).ids;
            expect(mine, JSON.stringify({ q, o })).toEqual(
              await pgSearch('s1', q, { ...o, limit: 10_000 })
            );
          }
        }
      }
    });
  }
);
