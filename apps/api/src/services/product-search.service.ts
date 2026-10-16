import { prisma, Prisma } from '@ebda/database';
import { searchTokens, escapeLike, normalizeArabicSearch, isPersonalDataTerm } from '@ebda/shared';
import { BoundedMap } from '../lib/bounded-map';
import {
  EMBED_DIMS,
  EMBED_MODEL,
  EmbeddingError,
  getEmbeddingProvider,
  semanticSearchEnabled,
  toHalfvecLiteral,
} from '../lib/search/embedding-provider';
import { hybridOrder } from '../lib/search/rrf';
import { takeQueryEmbed } from '../lib/search/embed-budget';
import { withSavepoint } from '../lib/savepoint';
import logger from '../lib/logger';

/** Most ids a lexical search binds into the follow-up Prisma query (list, typeahead, admin). */
export const PRODUCT_SEARCH_ID_CAP = 1000;
/** Ceiling for an explicit `limit` (the 10,000-row product exports). */
export const PRODUCT_SEARCH_MAX_LIMIT = 10_000;

export interface ProductSearchOpts {
  /** storefront = active + not deleted; admin = not deleted (any status) and also matches SKU. */
  scope: 'storefront' | 'admin';
  /** 'doc' = names + search terms + descriptions (list); 'name' = names + search terms (typeahead). */
  field?: 'doc' | 'name';
  /** Default PRODUCT_SEARCH_ID_CAP, at most PRODUCT_SEARCH_MAX_LIMIT. */
  limit?: number;
  /** Admin exports with "include deleted": drop the deleted_at filter. */
  includeDeleted?: boolean;
  /** Also match the normalised SKU. Default: scope === 'admin'. */
  withSku?: boolean;
  /**
   * 'similarity' (default) = best name match first; 'featured' = featured first, then name A-Z
   * (typeahead: the merchant's curated picks win BEFORE the top N is taken).
   */
  order?: 'similarity' | 'featured';
}

export interface ProductSearchIdSet {
  ids: string[];
  /** More rows matched than `limit`: `ids` is the best-ranked `limit` of them. */
  truncated: boolean;
}

function clampLimit(limit: number | undefined): number {
  return Math.min(
    PRODUCT_SEARCH_MAX_LIMIT,
    Math.max(1, Math.floor(limit ?? PRODUCT_SEARCH_ID_CAP))
  );
}

/**
 * The lexical search statement (selects `p.id`), or null when the query has no tokens. Exported so
 * the planner test EXPLAINs the exact SQL production runs. Each predicate is written exactly as
 * its index expression (migrations 20261019000100 + 20261019000200) or the planner cannot use it:
 *   public.ebda_product_search_doc(p.name, p.name_ar, p.search_terms, p.description, p.description_ar)
 *   public.ebda_product_name_doc(p.name, p.name_ar, p.search_terms)
 *   public.ebda_ar_norm(coalesce(p.sku, ''))
 * Every token must appear (word-AND), in any order. Tokens are normalised by the TS twin of
 * ebda_ar_norm and LIKE-escaped, so a shopper's `%` / `_` / `\` match literally.
 */
export function productSearchSql(
  storeId: string,
  raw: string,
  opts: ProductSearchOpts
): Prisma.Sql | null {
  const tokens = searchTokens(raw);
  if (tokens.length === 0) return null;
  const limit = clampLimit(opts.limit);
  const doc =
    opts.field === 'name'
      ? Prisma.sql`public.ebda_product_name_doc(p.name, p.name_ar, p.search_terms)`
      : Prisma.sql`public.ebda_product_search_doc(p.name, p.name_ar, p.search_terms, p.description, p.description_ar)`;
  const withSku = opts.withSku ?? opts.scope === 'admin';
  const arms = tokens.map(t => {
    const pattern = `%${escapeLike(t)}%`;
    return withSku
      ? Prisma.sql`(${doc} LIKE ${pattern} OR public.ebda_ar_norm(coalesce(p.sku, '')) LIKE ${pattern})`
      : Prisma.sql`${doc} LIKE ${pattern}`;
  });
  const status = opts.scope === 'storefront' ? Prisma.sql`AND p.status = 'active'` : Prisma.empty;
  const deleted = opts.includeDeleted ? Prisma.empty : Prisma.sql`AND p.deleted_at IS NULL`;
  const orderBy =
    opts.order === 'featured'
      ? Prisma.sql`p.featured DESC, p.name ASC, p.id`
      : Prisma.sql`similarity(public.ebda_product_name_doc(p.name, p.name_ar, p.search_terms), ${normalizeArabicSearch(raw)}) DESC, p.id`;
  // limit + 1: the extra row only says "there were more" (truncated).
  return Prisma.sql`SELECT p.id FROM products p
    WHERE p.store_id = ${storeId} ${deleted} ${status}
      AND ${Prisma.join(arms, ' AND ')}
    ORDER BY ${orderBy}
    LIMIT ${limit + 1}`;
}

/**
 * Lexical product search over the Arabic-normalised trigram expression indexes, with the
 * truncation flag. Raw SQL because Prisma cannot express a function-call predicate; it runs in
 * the caller's tenant scope (RLS) AND names store_id explicitly (tenant guard R-EBDA-004).
 * Ids are ordered by name similarity, so callers that rank (typeahead, P1 RRF) can use the order.
 */
export async function searchProductIdSet(
  storeId: string,
  raw: string,
  opts: ProductSearchOpts
): Promise<ProductSearchIdSet> {
  const sql = productSearchSql(storeId, raw, opts);
  if (!sql) return { ids: [], truncated: false };
  const limit = clampLimit(opts.limit);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(sql);
  return { ids: rows.slice(0, limit).map(r => r.id), truncated: rows.length > limit };
}

/** Ids only (see searchProductIdSet). Empty when the query has no tokens. */
export async function searchProductIds(
  storeId: string,
  raw: string,
  opts: ProductSearchOpts
): Promise<string[]> {
  return (await searchProductIdSet(storeId, raw, opts)).ids;
}

/**
 * Where-clause form for a Prisma list: `and` is [] for a blank query, else `[{ id: { in } }]`.
 * `truncated` is true when more than PRODUCT_SEARCH_ID_CAP products matched, so `total` and paging
 * cover only the best-ranked PRODUCT_SEARCH_ID_CAP; lists report it so the UI can say "refine".
 */
export async function productSearchFilter(
  storeId: string,
  search: string | null | undefined,
  scope: 'storefront' | 'admin'
): Promise<{ and: Prisma.ProductWhereInput[]; truncated: boolean }> {
  if (!search || searchTokens(search).length === 0) return { and: [], truncated: false };
  const { ids, truncated } = await searchProductIdSet(storeId, search, { scope });
  return { and: [{ id: { in: ids } }], truncated };
}

/** Drop-in replacement for the old ILIKE AND-array: an id filter, or [] for a blank query. */
export async function buildProductSearchWhere(
  storeId: string,
  search: string | null | undefined,
  scope: 'storefront' | 'admin'
): Promise<Prisma.ProductWhereInput[]> {
  return (await productSearchFilter(storeId, search, scope)).and;
}

/** Word-AND normalised LIKE arms over one SQL expression (the token patterns are bound values). */
function normalisedArms(expr: Prisma.Sql, tokens: string[]): Prisma.Sql {
  return Prisma.join(
    tokens.map(t => Prisma.sql`${expr} LIKE ${`%${escapeLike(t)}%`}`),
    ' AND '
  );
}

/**
 * Small per-store lists searched by name + Arabic name with the same folding (bundles,
 * promotions, categories). These tables are small per store (store_id-indexed), so the
 * normalised LIKE runs on the store's rows without an expression index. Each table has its own
 * literal statement (no Prisma.raw table name). Categories skip soft-deleted rows.
 */
export async function searchNameIds(
  table: 'bundles' | 'promotions' | 'categories',
  storeId: string,
  raw: string,
  limit: number = PRODUCT_SEARCH_ID_CAP
): Promise<string[]> {
  const tokens = searchTokens(raw);
  if (tokens.length === 0) return [];
  const match = normalisedArms(
    Prisma.sql`public.ebda_ar_norm(coalesce(t.name, '') || ' ' || coalesce(t.name_ar, ''))`,
    tokens
  );
  const take = clampLimit(limit);
  let rows: Array<{ id: string }>;
  if (table === 'bundles') {
    rows = await prisma.$queryRaw`
      SELECT t.id FROM bundles t WHERE t.store_id = ${storeId} AND ${match}
      ORDER BY t.id LIMIT ${take}`;
  } else if (table === 'promotions') {
    rows = await prisma.$queryRaw`
      SELECT t.id FROM promotions t WHERE t.store_id = ${storeId} AND ${match}
      ORDER BY t.id LIMIT ${take}`;
  } else {
    rows = await prisma.$queryRaw`
      SELECT t.id FROM categories t
      WHERE t.store_id = ${storeId} AND t.deleted_at IS NULL AND ${match}
      ORDER BY t.id LIMIT ${take}`;
  }
  return rows.map(r => r.id);
}

/**
 * Variant ids whose SKU matches every token after the same folding (Arabic-Indic digits, case),
 * for the warehouse stock search. product_variants has no store_id, so the join names the
 * product's store_id explicitly (R-EBDA-004); RLS scopes variants through their product.
 */
export async function searchVariantIdsBySku(
  storeId: string,
  raw: string
): Promise<ProductSearchIdSet> {
  const tokens = searchTokens(raw);
  if (tokens.length === 0) return { ids: [], truncated: false };
  const match = normalisedArms(Prisma.sql`public.ebda_ar_norm(coalesce(v.sku, ''))`, tokens);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
    WHERE p.store_id = ${storeId} AND ${match}
    ORDER BY v.id LIMIT ${PRODUCT_SEARCH_ID_CAP + 1}`;
  return {
    ids: rows.slice(0, PRODUCT_SEARCH_ID_CAP).map(r => r.id),
    truncated: rows.length > PRODUCT_SEARCH_ID_CAP,
  };
}

// ---------------------------------------------------------------------------------------------
// Hybrid storefront search (search program P1, Task 12; plan amendments E10, E11).
// ---------------------------------------------------------------------------------------------

/** Vector-leg depth, and how many keyword ids are fused with it (the rest is appended, E10). */
export const HYBRID_LEG = 50;
/**
 * The query embed races this budget (E11). It is the ONE synchronous third-party call allowed in a
 * storefront GET (Ruling SEARCH-T12-1): losing the race aborts the call and the list is keyword-only.
 */
export const QUERY_EMBED_BUDGET_MS = 400;
/** Queries shorter than this (letters/digits, spaces ignored) are keyword-only. */
export const QUERY_EMBED_MIN_CHARS = 3;
/** Most characters of a query that are embedded (the same 100 the route caps the term at). */
export const QUERY_EMBED_MAX_CHARS = 100;
/**
 * The keyword leg is "strong" at this many matches (a full default page): the query is then NOT
 * embedded and the list is keyword-ranked (Ruling SEARCH-T12-3: the vector leg is for the weak and
 * zero-result queries it exists for, and a broad term never costs a Workers AI call).
 */
export const KEYWORD_STRONG_AT = 20;
const DEFAULT_VECTOR_MAX_DISTANCE = 0.55;

/**
 * Query-vector cache (in-isolate BoundedMap: the Redis/KV TTL floor rule sends anything this
 * small and hot here, and a vector does not belong in KV).
 * Staleness class: NEVER-stale by construction. A key is (store, model, normalised query) and the
 * vector for a fixed model and text never changes, so no write path can invalidate it; the TTL only
 * bounds memory. A model change changes the key. Per store (not global) so one store's shoppers
 * cannot learn from response timing what was searched in another store. Failures are not cached.
 * Float32Array: 4 KB per entry (the column is halfvec, so nothing is lost); 500 entries ≈ 2 MB.
 */
const QUERY_VECTOR_TTL_MS = 10 * 60 * 1000;
const qCache = new BoundedMap<string, { v: Float32Array; exp: number }>(500);

/** Test seam: forget every cached query vector. */
export function clearQueryVectorCacheForTests(): void {
  qCache.clear();
}

/** `SEARCH_VECTOR_MAX_DISTANCE` (docs/ENVIRONMENT.md): cosine distance in (0, 2]; else the default. */
export function vectorMaxDistance(): number {
  const n = Number(process.env.SEARCH_VECTOR_MAX_DISTANCE);
  return process.env.SEARCH_VECTOR_MAX_DISTANCE && Number.isFinite(n) && n > 0 && n <= 2
    ? n
    : DEFAULT_VECTOR_MAX_DISTANCE;
}

/** One token of ASCII letters/digits/`-._/#` with a digit: a SKU or model code (keyword only). */
const SKU_LIKE = /^[a-z0-9][a-z0-9._/#-]*$/;

/**
 * Should this query be embedded at all? No for very short queries, SKU/model-code-shaped queries
 * (the keyword leg answers those exactly) and personal-data-shaped ones (a phone or email typed into
 * the box is never sent to a third party; same `isPersonalDataTerm` as the search log).
 */
export function shouldEmbedQuery(raw: string): boolean {
  const norm = normalizeArabicSearch(raw);
  if (norm.replace(/ /g, '').length < QUERY_EMBED_MIN_CHARS) return false;
  if (isPersonalDataTerm(raw)) return false;
  if (!norm.includes(' ') && /\d/.test(norm) && SKU_LIKE.test(norm)) return false;
  return true;
}

/** The query's vector (cached), raced against QUERY_EMBED_BUDGET_MS; the loser is aborted. */
async function queryVector(
  storeId: string,
  raw: string,
  searcher: string | undefined
): Promise<number[] | null> {
  const provider = getEmbeddingProvider();
  if (!provider) return null;
  const key = `${storeId}\u0000${provider.model}\u0000${normalizeArabicSearch(raw)}`;
  const hit = qCache.get(key);
  if (hit) {
    if (hit.exp > Date.now()) return Array.from(hit.v);
    qCache.delete(key);
  }
  // The ONE charge point (SEARCH-T12-6): once per real provider call, right before it, never on a
  // cache hit. Budgets + per-searcher limit; no searcher = no call (default deny); fails closed.
  if (!(await takeQueryEmbed(storeId, searcher))) return null;
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lost = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(
        new EmbeddingError('timeout', `query embed lost the ${QUERY_EMBED_BUDGET_MS} ms race`)
      );
    }, QUERY_EMBED_BUDGET_MS);
  });
  const call = provider.embed([raw.trim().slice(0, QUERY_EMBED_MAX_CHARS)], { signal: ctl.signal });
  call.catch(() => undefined); // the race's loser may reject later (aborted): never unhandled
  try {
    const [v] = await Promise.race([call, lost]);
    if (!Array.isArray(v) || v.length !== EMBED_DIMS)
      throw new EmbeddingError('shape', `embedding: expected ${EMBED_DIMS} dims`);
    qCache.set(key, { v: Float32Array.from(v), exp: Date.now() + QUERY_VECTOR_TTL_MS });
    return v;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vector leg: up to `limit` product ids of THIS store nearest to the query (exact KNN per store,
 * Ruling SEARCH-8), within SEARCH_VECTOR_MAX_DISTANCE, storefront-visible only (active, not
 * deleted, read live in the same SQL: Ruling SEARCH-11). `[]` when semantic search is off, the
 * query is not embeddable, no `searcher` is given or a budget refuses (`takeQueryEmbed`), the
 * provider fails or loses the race, or the SQL fails (inside a
 * savepoint so the request transaction survives). Never throws. Runs in the caller's tenant scope
 * (RLS) AND names store_id on both tables (R-EBDA-004). Logs carry the store and the failure
 * kind, never the query text.
 */
export async function semanticProductIds(
  storeId: string,
  raw: string,
  opts: { searcher?: string; limit?: number } = {}
): Promise<string[]> {
  const limit = opts.limit ?? HYBRID_LEG;
  if (!semanticSearchEnabled() || !shouldEmbedQuery(raw)) return [];
  try {
    const v = await queryVector(storeId, raw, opts.searcher);
    if (!v) return [];
    const q = toHalfvecLiteral(v);
    const rows = await withSavepoint(
      () => prisma.$queryRaw<Array<{ id: string }>>`
        SELECT k.id FROM (
          SELECT e.product_id AS id, e.embedding <=> q.v AS d
            FROM product_embeddings e
            JOIN products p ON p.id = e.product_id AND p.store_id = ${storeId}
            CROSS JOIN (SELECT ${q}::halfvec(1024) AS v) q
           WHERE e.store_id = ${storeId} AND e.model = ${EMBED_MODEL}
             AND p.status = 'active' AND p.deleted_at IS NULL
        ) k
        WHERE k.d <= ${vectorMaxDistance()}
        ORDER BY k.d, k.id
        LIMIT ${Math.max(1, Math.floor(limit))}`
    );
    return rows.map(r => r.id);
  } catch (err) {
    const kind = err instanceof EmbeddingError ? err.kind : 'sql';
    const log = kind === 'timeout' || kind === 'aborted' ? logger.info : logger.warn;
    log.call(logger, { storeId, kind }, '[search] vector leg unavailable; keyword results only');
    return [];
  }
}

/**
 * Storefront relevance order: the keyword leg (up to PRODUCT_SEARCH_ID_CAP, E10) with its first
 * HYBRID_LEG ids fused (RRF) with the vector leg, then the keyword tail in its own order. With the
 * vector leg off, failing, over budget or the searcher's limit, without a `searcher`, or skipped because the
 * keyword leg is strong (>= KEYWORD_STRONG_AT), this is exactly the keyword (name-similarity)
 * order. The keyword leg runs first (it decides whether to embed). At most
 * PRODUCT_SEARCH_ID_CAP + HYBRID_LEG ids.
 */
export async function rankedSearch(
  storeId: string,
  raw: string,
  opts: { searcher?: string } = {}
): Promise<string[]> {
  const lexical = await searchProductIds(storeId, raw, { scope: 'storefront' });
  if (lexical.length >= KEYWORD_STRONG_AT) return lexical;
  const vector = await semanticProductIds(storeId, raw, { searcher: opts.searcher });
  return hybridOrder(lexical, vector, HYBRID_LEG);
}
