// F7-HAMZA-2 on the DO: a word matches under fold B (the original) OR fold A (hamza fold). node:sqlite + FTS5 trigram.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import {
  ensureSearchIndex,
  reindexStore,
  searchProductIdSet,
  verifyProductIndex,
} from '../src/do/search';

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

const prod = (id: string, nameAr: string, extra: Partial<P> = {}): P => ({
  id,
  name: null,
  nameAr,
  terms: null,
  desc: null,
  descAr: null,
  sku: null,
  ...extra,
});
const find = (db: ReturnType<typeof fx>['db'], q: string, o: { field?: 'name' | 'doc' } = {}) =>
  searchProductIdSet(db, 's1', q, { scope: 'storefront', ...o }).ids.sort();

describe('DO product search: fold B OR fold A (Ruling F7-HAMZA-2)', () => {
  const { db } = fx([
    prod('seat1', 'مسؤول الحسابات'),
    prod('seat2', 'مسئول المبيعات'),
    prod('q1', 'سؤال عن الشحن'),
    prod('q2', 'سائل غسيل'),
    prod('q3', 'سلال بلاستيك'),
    prod('r1', 'منتج رائع'),
    prod('ye', 'ﻣﺤﻤﺪ للتجارة'),
    prod('old', 'احذية رياضية'),
  ]);
  it('hamza seats meet (fold A): مسئول finds مسؤول and the reverse', () => {
    expect(find(db, 'مسئول')).toEqual(['seat1', 'seat2']);
    expect(find(db, 'مسؤول')).toEqual(['seat1', 'seat2']);
    expect(find(db, 'مسول')).toEqual(expect.arrayContaining(['seat1', 'seat2'])); // (also stem-matches سوال: مفعل rule, old behaviour)
  });
  it('per word: word 1 only matches under fold A and word 2 only under fold B still finds the product', () => {
    const { db: d2 } = fx([
      prod('mix', 'مسؤول سائل'),
      prod('onlyA', 'مسؤول غسيل'),
      prod('onlyB', 'مدير سائل'),
    ]);
    // مسئول = مسؤول under A only; سايل = سائل under B only
    expect(find(d2, 'مسئول سايل')).toEqual(['mix']);
    expect(find(d2, 'سايل مسئول')).toEqual(['mix']);
    expect(find(d2, 'مسئول')).toEqual(['mix', 'onlyA']);
  });
  it('سؤال = سوال = سئوال', () => {
    for (const q of ['سؤال', 'سوال', 'سئوال']) expect(find(db, q), q).toEqual(['q1']);
  });
  it('typed ي for ئ still works (fold B, no regression): سايل finds سائل, رايع finds رائع', () => {
    expect(find(db, 'سايل')).toEqual(['q2']);
    expect(find(db, 'رايع')).toEqual(['r1']);
    expect(find(db, 'رائع')).toEqual(['r1']);
  });
  it('distinct words stay apart: سال does not find سائل, سلال does not find سؤال, مسلول finds nothing', () => {
    expect(find(db, 'سال')).toEqual([]);
    expect(find(db, 'سلال')).toEqual(['q3']);
    expect(find(db, 'مسلول')).toEqual([]);
  });
  it('NFKC: a name stored with presentation forms meets the typed letters (fold A)', () => {
    expect(find(db, 'محمد')).toEqual(['ye']);
  });
  it('the original behaviour is untouched (alef, ta marbuta)', () => {
    expect(find(db, 'احذيه')).toEqual(['old']);
    expect(find(db, 'أحذية')).toEqual(['old']);
  });
  it('field name uses the fold-A name column too; the index verifies clean and reindexStore is stable', () => {
    expect(find(db, 'مسئول', { field: 'name' })).toEqual(['seat1', 'seat2']);
    expect(verifyProductIndex(db, 's1')).toEqual({ missing: [], orphaned: [], stale: [] });
    reindexStore(db, 's1');
    expect(find(db, 'سئوال')).toEqual(['q1']);
  });
  it('an index built before the fold-A columns is dropped and rebuilt (ensureSearchIndex)', () => {
    const raw = openSqlite();
    const d = nodeSyncSql(raw);
    ensureSearchIndex(d);
    raw.exec('DROP TABLE product_search_fts');
    raw.exec(
      `CREATE VIRTUAL TABLE product_search_fts USING fts5(doc, name_doc, sku, stem_doc, stem_name_doc, product_id UNINDEXED, store_id UNINDEXED, tokenize = 'trigram')`
    );
    ensureSearchIndex(d);
    const cols = (
      raw.prepare('PRAGMA table_info(product_search_fts)').all() as Array<{ name: string }>
    ).map(c => c.name);
    expect(cols).toContain('doc_h');
    expect(cols).toContain('name_doc_h');
  });
});
