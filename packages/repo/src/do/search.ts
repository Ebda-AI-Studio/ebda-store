// DO port of the product lexical search (apps/api/src/services/product-search.service.ts + the SQL functions
// ebda_product_search_ids / ebda_product_search_doc / ebda_product_name_doc / ebda_ar_norm).
//
// Same meaning as Postgres: every query word must appear (word-AND, any order) as a SUBSTRING of the Arabic-folded
// document (name + Arabic name + search terms [+ descriptions]); admin scope also matches the folded SKU; a query made
// ONLY of words under 3 characters matches the START of a word instead (Ruling SEARCH-T14-3, same boundary list);
// results are ordered by pg_trgm similarity of the name document to the folded query, then id. The folding is the ONE
// shared TS function (`normalizeArabicSearch`), used by the indexer and the query (no SQL twin to drift from).
//
// Storage: an FTS5 table with the `trigram` tokenizer (substring MATCH for words of 3+ characters). SQLite cannot call
// the TS folder from a trigger, so the repo layer owns the index: `upsertProductIndex` / `removeProductIndex` after
// every product write, `reindexStore` for a rebuild, `verifyProductIndex` as the drift check. The StoreDO bootstrap
// runs `ensureSearchIndex` (DDL here, not in 0001, because a virtual table has shadow tables the schema parity test
// must not see). Vector (Vectorize) fusion stays a separate stage: this module is the keyword arm.
import { escapeLike, normalizeArabicSearch, searchTokens } from '../../../shared/src/search';
import { MoneyError, type SyncSql } from './sync-sql';

export const PRODUCT_SEARCH_ID_CAP = 1000;
export const PRODUCT_SEARCH_MAX_LIMIT = 10_000;

export const SEARCH_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS product_search_fts USING fts5(
  doc, name_doc, sku, product_id UNINDEXED, store_id UNINDEXED, tokenize = 'trigram')`;
export function ensureSearchIndex(db: SyncSql): void {
  db.run(SEARCH_DDL, []);
}

export interface ProductSearchOpts {
  scope: 'storefront' | 'admin';
  field?: 'doc' | 'name';
  limit?: number;
  includeDeleted?: boolean;
  withSku?: boolean;
  order?: 'similarity' | 'featured';
}
export interface ProductSearchIdSet {
  ids: string[];
  truncated: boolean;
}
export interface ProductDocFields {
  name?: string | null;
  nameAr?: string | null;
  searchTerms?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
  sku?: string | null;
}

const joinDoc = (...parts: Array<string | null | undefined>) => parts.map(p => p ?? '').join(' ');
/** `ebda_product_search_doc` */
export const buildProductDoc = (p: ProductDocFields): string =>
  normalizeArabicSearch(joinDoc(p.name, p.nameAr, p.searchTerms, p.description, p.descriptionAr));
/** `ebda_product_name_doc` */
export const buildProductNameDoc = (p: ProductDocFields): string =>
  normalizeArabicSearch(joinDoc(p.name, p.nameAr, p.searchTerms));

const clampLimit = (limit: number | undefined): number =>
  Math.min(PRODUCT_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(limit ?? PRODUCT_SEARCH_ID_CAP)));

// ---- index maintenance --------------------------------------------------------------------------------------------

const PRODUCT_COLS = 'id, store_id, name, name_ar, search_terms, description, description_ar, sku';
type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function writeIndexRow(db: SyncSql, r: Row): void {
  const f: ProductDocFields = {
    name: str(r.name),
    nameAr: str(r.name_ar),
    searchTerms: str(r.search_terms),
    description: str(r.description),
    descriptionAr: str(r.description_ar),
    sku: str(r.sku),
  };
  db.run('DELETE FROM product_search_fts WHERE product_id = ?', [r.id]);
  db.run(
    'INSERT INTO product_search_fts (doc, name_doc, sku, product_id, store_id) VALUES (?, ?, ?, ?, ?)',
    [
      buildProductDoc(f),
      buildProductNameDoc(f),
      normalizeArabicSearch(f.sku ?? ''),
      r.id,
      r.store_id,
    ]
  );
}

/** (Re)index ONE product from its current row. A missing product removes its index row. Call inside the write's section. */
export function upsertProductIndex(db: SyncSql, storeId: string, productId: string): void {
  const r = db.all(`SELECT ${PRODUCT_COLS} FROM products WHERE id = ? AND store_id = ?`, [
    productId,
    storeId,
  ])[0];
  if (!r) return removeProductIndex(db, productId);
  writeIndexRow(db, r);
}
export function removeProductIndex(db: SyncSql, productId: string): void {
  db.run('DELETE FROM product_search_fts WHERE product_id = ?', [productId]);
}
/** Rebuild the whole index from `products` (restore, import, repair). */
export function reindexStore(db: SyncSql, storeId: string): number {
  return db.transactionSync(() => {
    db.run('DELETE FROM product_search_fts WHERE store_id = ?', [storeId]);
    const rows = db.all(`SELECT ${PRODUCT_COLS} FROM products WHERE store_id = ?`, [storeId]);
    for (const r of rows) writeIndexRow(db, r);
    return rows.length;
  });
}
/** Drift check: product ids missing from the index, indexed ids without a product, and rows whose doc is stale. */
export function verifyProductIndex(
  db: SyncSql,
  storeId: string
): { missing: string[]; orphaned: string[]; stale: string[] } {
  const prods = db.all(`SELECT ${PRODUCT_COLS} FROM products WHERE store_id = ?`, [storeId]);
  const idx = new Map(
    db
      .all('SELECT product_id, doc, name_doc, sku FROM product_search_fts', [])
      .map(r => [r.product_id as string, r])
  );
  const missing: string[] = [];
  const stale: string[] = [];
  for (const r of prods) {
    const row = idx.get(r.id as string);
    if (!row) {
      missing.push(r.id as string);
      continue;
    }
    const f: ProductDocFields = {
      name: str(r.name),
      nameAr: str(r.name_ar),
      searchTerms: str(r.search_terms),
      description: str(r.description),
      descriptionAr: str(r.description_ar),
      sku: str(r.sku),
    };
    if (
      row.doc !== buildProductDoc(f) ||
      row.name_doc !== buildProductNameDoc(f) ||
      row.sku !== normalizeArabicSearch(f.sku ?? '')
    )
      stale.push(r.id as string);
    idx.delete(r.id as string);
  }
  return { missing, orphaned: [...idx.keys()], stale };
}

// ---- pg_trgm similarity (ordering parity) -------------------------------------------------------------------------

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    const cps = [...`  ${w} `];
    for (let i = 0; i + 3 <= cps.length; i++) out.add(cps.slice(i, i + 3).join(''));
  }
  return out;
}
/** pg_trgm `similarity(a, b)`: |shared trigrams| / |all distinct trigrams|. */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

// ---- query --------------------------------------------------------------------------------------------------------

/** Word-start boundaries of the all-short-words mode: identical to the SQL function's `v_bounds` (SEARCH-T14-3). */
const WORD_START_BOUNDS = ['', '% ', '%/', '%(', '%-', '%,', '%.', 'ا', '% ا', 'ال', '% ال'];
const ftsPhrase = (t: string) => `"${t.replace(/"/g, '""')}"`;

/** Ids of the products matching `raw`, best name match first. */
export function searchProductIdSet(
  db: SyncSql,
  storeId: string,
  raw: string,
  opts: ProductSearchOpts
): ProductSearchIdSet {
  if (!storeId) throw new MoneyError('STORE_REQUIRED', 'storeId is required', 500);
  const tokens = searchTokens(raw);
  if (tokens.length === 0) return { ids: [], truncated: false };
  const limit = clampLimit(opts.limit);
  const storefront = opts.scope === 'storefront';
  const withSku = opts.withSku ?? opts.scope === 'admin';
  const docCol = opts.field === 'name' ? 'name_doc' : 'doc';
  // UTF-16 units, exactly like the Postgres caller's `t.length < 3`
  const wordStart = tokens.every(t => t.length < 3);

  const where: string[] = ['f.store_id = ?'];
  const params: unknown[] = [storeId];
  const match: string[] = [];
  for (const t of tokens) {
    const like = escapeLike(t);
    if (wordStart) {
      const arms: string[] = [];
      for (const b of WORD_START_BOUNDS) {
        arms.push(`f.${docCol} LIKE ? ESCAPE '\\'`);
        params.push(`${b}${like}%`);
      }
      if (withSku) {
        arms.push(`f.sku LIKE ? ESCAPE '\\'`);
        params.push(`${like}%`);
      }
      where.push(`(${arms.join(' OR ')})`);
    } else if ([...t].length >= 3) {
      match.push(withSku ? `{${docCol} sku} : ${ftsPhrase(t)}` : `${docCol} : ${ftsPhrase(t)}`);
    } else {
      // a short word beside long ones: a plain substring test on the (already narrowed) rows
      const arms = [`f.${docCol} LIKE ? ESCAPE '\\'`];
      params.push(`%${like}%`);
      if (withSku) {
        arms.push(`f.sku LIKE ? ESCAPE '\\'`);
        params.push(`%${like}%`);
      }
      where.push(`(${arms.join(' OR ')})`);
    }
  }
  const sqlParams: unknown[] = [];
  if (match.length > 0) {
    where.unshift('product_search_fts MATCH ?');
    sqlParams.push(match.join(' AND '));
  }
  sqlParams.push(...params);
  const status = storefront ? "AND p.status = 'active' AND p.audience = 'public'" : '';
  const deleted = opts.includeDeleted && !storefront ? '' : 'AND p.deleted_at IS NULL';
  const rows = db.all(
    `SELECT p.id AS id, p.name AS name, p.featured AS featured, f.name_doc AS name_doc
       FROM product_search_fts f JOIN products p ON p.id = f.product_id AND p.store_id = ?
      WHERE ${where.join(' AND ')} ${status} ${deleted}`,
    [storeId, ...sqlParams]
  );
  const q = normalizeArabicSearch(raw);
  const ranked = rows
    .map(r => ({
      id: r.id as string,
      name: (r.name as string | null) ?? '',
      featured: Number(r.featured ?? 0),
      sim: opts.order === 'featured' ? 0 : trigramSimilarity(String(r.name_doc ?? ''), q),
    }))
    .sort((a, b) =>
      opts.order === 'featured'
        ? b.featured - a.featured || cmp(a.name, b.name) || cmp(a.id, b.id)
        : b.sim - a.sim || cmp(a.id, b.id)
    );
  return { ids: ranked.slice(0, limit).map(r => r.id), truncated: ranked.length > limit };
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function searchProductIds(
  db: SyncSql,
  storeId: string,
  raw: string,
  opts: ProductSearchOpts
): string[] {
  return searchProductIdSet(db, storeId, raw, opts).ids;
}
