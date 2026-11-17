// Arabic light stemming on the DO keyword search (Ruling SEARCH-STEM-1): the stemmer, the before/after eval, the
// no-regression guarantee on the existing eval, exact-first ranking, and the idempotent index migration.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import {
  ensureSearchIndex,
  reindexStore,
  searchProductIdSet,
  verifyProductIndex,
  type ProductSearchOpts,
} from '../src/do/search';
import { normalizeArabicSearch, stemSearchDoc, stemSearchToken } from '../../shared/src/search';
import {
  catalogueRows,
  evalQueries,
  EVAL_STEM,
  EVAL_STEM_ROWS,
  type EvalRow,
} from '../../../tests/search-eval/catalogue';

function store(rows: ReadonlyArray<Pick<EvalRow, 'id' | 'nameAr' | 'name'>>) {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureSearchIndex(db);
  const ins = raw.prepare(
    `INSERT INTO products (id, store_id, name, name_ar, slug, price, status, audience, featured) VALUES (?,?,?,?,?,100,'active','public',0)`
  );
  for (const r of rows) ins.run(r.id, 's1', r.name, r.nameAr, r.id);
  reindexStore(db, 's1');
  return { raw, db };
}
const run = (db: ReturnType<typeof store>['db'], q: string, o: Partial<ProductSearchOpts> = {}) =>
  searchProductIdSet(db, 's1', q, { scope: 'storefront', limit: 10_000, ...o }).ids;
const stem = (w: string) => stemSearchToken(normalizeArabicSearch(w));

describe('stemArabicWord', () => {
  it.each([
    ['كتب', 'الكتب', 'كتابين', 'مكتبة', 'مكتبات', 'الكتاب'],
    ['شنط', 'شنطة', 'الشنط', 'شنطتين', 'بالشنطة', 'شنطات'],
    ['ساع', 'ساعة', 'ساعات', 'الساعات', 'ساعتين', 'للساعة'],
    ['قلم', 'اقلام', 'الأقلام'],
  ])('%s: every inflection folds to one stem', (...forms) => {
    const stems = new Set(forms.map(stem));
    expect(stems.size, forms.join(' ')).toBe(1);
  });

  it('keeps short words and non-Arabic words intact', () => {
    expect(stem('سلة')).toBe('سله'); // would leave 2 letters
    expect(stem('نور')).toBe('نور');
    expect(stem('sneakers')).toBe('sneakers');
    expect(stem('3abaya')).toBe('3abaya');
    expect(stemSearchDoc(normalizeArabicSearch('الشنطة ساعات nike 2'))).toBe('شنط ساع nike 2');
  });
});

describe('search-eval: Arabic stemming, before and after', () => {
  const rows = [...catalogueRows(), ...EVAL_STEM_ROWS];
  const f = store(rows);
  const pass = (stemOn: boolean) =>
    EVAL_STEM.filter(c => {
      const got = new Set(run(f.db, c.q, { stem: stemOn }));
      return c.relevant.every(id => got.has(id)) && !(c.absent ?? []).some(id => got.has(id));
    });

  it('stemming cases: the stem arm passes every case, the literal arm does not', () => {
    const before = pass(false);
    const after = pass(true);
    console.log(
      `stem eval pass rate: before ${before.length}/${EVAL_STEM.length}, after ${after.length}/${EVAL_STEM.length}`
    );
    expect(after.map(c => c.q)).toEqual(EVAL_STEM.map(c => c.q));
    expect(before.length).toBeLessThan(after.length);
  });

  it('no regression: every existing eval query keeps every hit it had; per-class hit@10 never drops', () => {
    const base = store(catalogueRows());
    const types = new Map(catalogueRows().map(r => [r.id, r.type]));
    const cls = new Map<string, { n: number; off: number; on: number }>();
    let grew = 0;
    for (const e of evalQueries()) {
      const off = run(base.db, e.q, { stem: false });
      const on = run(base.db, e.q, { stem: true });
      // every literal hit is still returned, and still ranked ahead of every stem-only hit
      expect(on.slice(0, off.length), e.q).toEqual(off);
      if (on.length > off.length) grew++;
      const hit = (ids: string[]) => ids.slice(0, 10).some(id => types.get(id) === e.key);
      const c = cls.get(e.cls) ?? { n: 0, off: 0, on: 0 };
      c.n++;
      if (hit(off)) c.off++;
      if (hit(on)) c.on++;
      cls.set(e.cls, c);
    }
    for (const [k, c] of cls) expect(c.on, k).toBeGreaterThanOrEqual(c.off);
    const rate = (pick: 'off' | 'on', pred: (k: string) => boolean) => {
      const sel = [...cls].filter(([k]) => pred(k)).map(([, c]) => c);
      return (sel.reduce((a, c) => a + c[pick], 0) / sel.reduce((a, c) => a + c.n, 0)).toFixed(3);
    };
    const all = () => true;
    console.log(
      `existing eval hit@10 before->after: overall ${rate('off', all)}->${rate('on', all)}, franco ${rate('off', k => k === 'franco')}->${rate('on', k => k === 'franco')}; queries with a larger result set: ${grew}/${evalQueries().length}`
    );
  });
});

describe('ranking, scope and migration', () => {
  it('a literal match outranks a stem-only match, whatever their trigram similarity', () => {
    const f = store([
      { id: 'a-stem', nameAr: 'كتابين', name: '' }, // stem only for "كتب"
      { id: 'b-literal', nameAr: 'كتب عربية مصورة للأطفال الصغار', name: '' }, // literal, lower similarity
    ]);
    expect(run(f.db, 'كتب')).toEqual(['b-literal', 'a-stem']);
    expect(run(f.db, 'كتب', { stem: false })).toEqual(['b-literal']);
  });

  it('admin search stays literal by default (it also selects the rows of bulk edits), opt-in works', () => {
    const f = store([{ id: 'p1', nameAr: 'شنطة', name: '' }]);
    expect(run(f.db, 'الشنط', { scope: 'admin' })).toEqual([]);
    expect(run(f.db, 'الشنط', { scope: 'admin', stem: true })).toEqual(['p1']);
    expect(run(f.db, 'الشنط')).toEqual(['p1']);
  });

  it('a pre-stemming index (no stem columns) is rebuilt on bootstrap, once, and is idempotent', () => {
    const raw = openSqlite();
    const db = nodeSyncSql(raw);
    raw.exec(`CREATE VIRTUAL TABLE product_search_fts USING fts5(
      doc, name_doc, sku, product_id UNINDEXED, store_id UNINDEXED, tokenize = 'trigram')`);
    raw
      .prepare(
        `INSERT INTO products (id, store_id, name, name_ar, slug, price, status, audience) VALUES ('p1','s1','','شنطة','p1',1,'active','public')`
      )
      .run();
    ensureSearchIndex(db); // live store wakes up on the new code
    expect(run(db, 'الشنط')).toEqual(['p1']);
    expect(verifyProductIndex(db, 's1')).toEqual({ missing: [], orphaned: [], stale: [] });
    const cols = () =>
      raw
        .prepare('PRAGMA table_info(product_search_fts)')
        .all()
        .map(c => c.name);
    expect(cols()).toContain('stem_doc');
    ensureSearchIndex(db);
    ensureSearchIndex(db);
    expect(run(db, 'الشنط')).toEqual(['p1']);
    expect(raw.prepare('SELECT count(*) AS n FROM product_search_fts').get()!.n).toBe(1);
  });

  it('verifyProductIndex flags a row whose stem columns drifted', () => {
    const f = store([{ id: 'p1', nameAr: 'شنطة', name: '' }]);
    f.raw.exec(`UPDATE product_search_fts SET stem_doc = 'x' WHERE product_id = 'p1'`);
    expect(verifyProductIndex(f.db, 's1').stale).toEqual(['p1']);
  });

  it('latency: stem arm over the eval catalogue (soft report, not asserted)', () => {
    const f = store([...catalogueRows(), ...EVAL_STEM_ROWS]);
    const qs = [...evalQueries().map(e => e.q), ...EVAL_STEM.map(c => c.q)];
    const time = (stemOn: boolean) => {
      const t: number[] = [];
      for (const q of qs) {
        const s = performance.now();
        run(f.db, q, { stem: stemOn });
        t.push(performance.now() - s);
      }
      t.sort((a, b) => a - b);
      return t[Math.floor(t.length * 0.95)]!.toFixed(2);
    };
    time(true);
    console.log(
      `p95 ms over ${qs.length} queries: literal ${time(false)}, with stem ${time(true)}`
    );
  });
});
