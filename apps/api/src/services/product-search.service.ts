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
import { queryBudgetSpent, takeQueryEmbed } from '../lib/search/embed-budget';
import { withSavepoint } from '../lib/savepoint';
import logger from '../lib/logger';
import { storeDb, storeMoney, storeRepo } from '../lib/repo-factory';
import { cfBindings } from '../cf/bindings';

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
 * the planner tests inspect the exact SQL production runs. The match itself is
 * `public.ebda_product_search_ids` (migration 20261024000300, Ruling SEARCH-T14-1), whose inner
 * statement writes each predicate exactly as its index expression (migrations 20261019000100 +
 * 20261019000200) or the planner cannot use it:
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
  const withSku = opts.withSku ?? opts.scope === 'admin';
  const storefront = opts.scope === 'storefront';
  const status = storefront ? Prisma.sql`AND p.status = 'active'` : Prisma.empty;
  // B2B-7b: the storefront search NEVER returns a wholesale-only product. The predicate sits in the WHERE, BEFORE the LIMIT
  // below, so hidden products can never occupy result slots or change the truncation flag (raw-SQL visibility checklist).
  const audience = storefront ? Prisma.sql`AND p.audience = 'public'` : Prisma.empty;
  const deleted = opts.includeDeleted ? Prisma.empty : Prisma.sql`AND p.deleted_at IS NULL`;
  const orderBy =
    opts.order === 'featured'
      ? Prisma.sql`p.featured DESC, p.name ASC, p.id`
      : Prisma.sql`similarity(public.ebda_product_name_doc(p.name, p.name_ar, p.search_terms), ${normalizeArabicSearch(raw)}) DESC, p.id`;
  // The word-AND match runs inside public.ebda_product_search_ids (SECURITY DEFINER, Ruling
  // SEARCH-T14-1): as `ebda_app` the tenant policy is a security barrier and none of the
  // normalising functions is LEAKPROOF, so an inline `doc LIKE ...` can never be an index condition
  // and scanned (and normalised) every row of the store. The function finds the candidate ids of
  // THIS store (it refuses any other) with the trigram indexes; this statement still reads
  // `products` as ebda_app, so RLS, status, soft-delete and ordering apply to the final rows.
  // A query made ONLY of words under 3 characters has no trigram to look up as a substring, so it
  // matches the START of a word instead (SEARCH-T14-3); anything with a longer word is unchanged.
  const wordStart = tokens.every(t => t.length < 3);
  const patterns = tokens.map(t => (wordStart ? `${escapeLike(t)}%` : `%${escapeLike(t)}%`));
  // limit + 1: the extra row only says "there were more" (truncated).
  return Prisma.sql`SELECT p.id FROM products p
    WHERE p.store_id = ${storeId} ${deleted} ${status} ${audience}
      AND p.id IN (SELECT public.ebda_product_search_ids(
        ${storeId}, ${opts.field === 'name' ? 'name' : 'all'}, ${withSku}, ${storefront},
        ${opts.includeDeleted === true}, ${wordStart}, ${patterns}::text[]))
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
  // A store on its Durable Object answers from the DO's own product index (Ruling CF-R6A-1): same words-AND meaning, the
  // Arabic fold is the one shared TS function. The Postgres statement below is untouched.
  if (searchTokens(raw).length === 0) return { ids: [], truncated: false };
  const money = await storeMoney(storeId);
  if (money) return money.searchProducts({ raw, opts });
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
  // A store on its Durable Object has no Postgres `ebda_ar_norm`: the same words-AND match runs over the store's (small) rows
  // with the shared TS fold. The Postgres statements below are untouched.
  if ((await storeRepo(storeId)).backend === 'do') {
    const db = await storeDb(storeId);
    const sel = { id: true, name: true, nameAr: true } as const;
    const found: Array<{ id: string; name: string | null; nameAr: string | null }> =
      table === 'bundles'
        ? await db.bundle.findMany({ where: { storeId }, select: sel })
        : table === 'promotions'
          ? await db.promotion.findMany({ where: { storeId }, select: sel })
          : await db.category.findMany({ where: { storeId, deletedAt: null }, select: sel });
    return found
      .filter(r => {
        const hay = normalizeArabicSearch(`${r.name ?? ''} ${r.nameAr ?? ''}`);
        return tokens.every(t => hay.includes(t));
      })
      .map(r => r.id)
      .sort()
      .slice(0, take);
  }
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
/**
 * The budget for the FIRST query embed of an isolate that has not completed one in the last
 * QUERY_EMBED_WARM_WINDOW_MS (Ruling SEARCH-WARM-1): the budget accounting (AuthState DO round trips) and the
 * Workers AI model are cold then, and a 400 ms race lost every time degraded the first search to keyword-only.
 * Warm isolates keep QUERY_EMBED_BUDGET_MS. Applies to the in-isolate state only: a new isolate counts as idle.
 */
export const QUERY_EMBED_COLD_BUDGET_MS = 1200;
/** Most a storefront request waits for the budget charge (one parallel DO round trip); past it: no embed, keyword-only. */
export const BUDGET_STEP_TIMEOUT_MS = 800;
export const QUERY_EMBED_WARM_WINDOW_MS = 4 * 60 * 1000;
let lastEmbedOkAt = 0;
/** Test seam: forget (0) or set when this isolate last completed a query embed. */
export function setLastQueryEmbedOkAtForTests(t: number): void {
  lastEmbedOkAt = t;
}
/** Queries shorter than this (letters/digits, spaces ignored) are keyword-only. */
export const QUERY_EMBED_MIN_CHARS = 3;
/** Most characters of a query that are embedded (the same 100 the route caps the term at). */
export const QUERY_EMBED_MAX_CHARS = 100;
/**
 * The keyword leg is "strong" at this many matches: the query is then NOT embedded and the list is
 * keyword-ranked. Equal to HYBRID_LEG, so every keyword list the fused head can hold gets semantic
 * re-ranking and E10's appended tail is live for 20-49 hits (Ruling SEARCH-T12-3, amended). The ONE
 * constant Task 13 tunes: its eval measures lift at 20, 50 and no threshold. Spend is bounded by the
 * budgets (`takeQueryEmbed`), not by this. Counted store-wide BEFORE the category, price and option
 * filters (documented residual: a filtered search with few in-filter hits but >= 50 store-wide is
 * keyword-only).
 */
export const KEYWORD_STRONG_AT = HYBRID_LEG;
/** Calibrated on real bge-m3 scores: see DEFAULT_VECTOR_MAX_DISTANCE in packages/repo/src/do/search-vectors.ts. */
const DEFAULT_VECTOR_MAX_DISTANCE = 0.55;

/**
 * Query-vector cache (in-isolate BoundedMap: the Redis/KV TTL floor rule sends anything this
 * small and hot here, and a vector does not belong in KV).
 * Staleness class: BOUNDED-stale by model version, 10 minutes. The key is (store, model id, the
 * EXACT embedded text = `queryEmbedText(raw)`), so two spellings that fold to the same text share a
 * vector by design and nothing else does. No product write affects a query vector; what can change
 * under an unchanged key is the provider's model behind the same id (a Workers AI model update),
 * and the TTL bounds that window. A model-id change changes the key. Per store (not global) so one
 * store's shoppers cannot learn from response timing what was searched in another store. Failures
 * are not cached. The key holds at most QUERY_EMBED_MAX_CHARS characters of the query.
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
/** The exact text embedded for a query (and its cache key part): normalised, at most 100 chars. */
export function queryEmbedText(raw: string): string {
  return normalizeArabicSearch(raw).slice(0, QUERY_EMBED_MAX_CHARS).trim();
}

async function queryVector(
  storeId: string,
  raw: string,
  searcher: string | undefined
): Promise<number[] | null> {
  const provider = getEmbeddingProvider();
  if (!provider) return null;
  const text = queryEmbedText(raw);
  const key = `${storeId}\u0000${provider.model}\u0000${text}`;
  const hit = qCache.get(key);
  if (hit) {
    if (hit.exp > Date.now()) return Array.from(hit.v);
    qCache.delete(key);
  }
  // TWO bounded steps (Ruling SEARCH-WARM-1, amending E11 + review M3). 1) The charge: ONE parallel AuthState
  // round trip (embed-budget.ts), bounded by BUDGET_STEP_TIMEOUT_MS and fail-CLOSED: a slow or failed charge means no
  // provider call (a late `ok` only over-counts, never overspends). 2) The race covers ONLY the provider call
  // (budget `budgetMs`): measured in production, 4+ serial DO calls inside the old single 400 ms timer lost it on
  // every uncached query. The TTL writes of the counters overlap with the embed.
  const t0 = Date.now();
  const cold = t0 - lastEmbedOkAt > QUERY_EMBED_WARM_WINDOW_MS;
  const budgetMs = cold ? QUERY_EMBED_COLD_BUDGET_MS : QUERY_EMBED_BUDGET_MS;
  let ttlWrites: Promise<void> = Promise.resolve();
  let stepTimer: ReturnType<typeof setTimeout> | undefined;
  const charged = await Promise.race([
    takeQueryEmbed(storeId, searcher, { overlap: p => (ttlWrites = p) }).catch(() => false),
    new Promise<false>(r => {
      stepTimer = setTimeout(() => r(false), BUDGET_STEP_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(stepTimer);
  if (!charged) return null;
  const tCharged = Date.now();
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lost = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new EmbeddingError('timeout', `query embed lost the ${budgetMs} ms race`));
    }, budgetMs);
  });
  const work = provider.embed([text], { signal: ctl.signal }).then(r => r[0] ?? null);
  work.catch(() => undefined); // the race's loser may reject later (aborted): never unhandled
  try {
    const v = await Promise.race([work, lost]);
    if (v === null) return null;
    if (!Array.isArray(v) || v.length !== EMBED_DIMS)
      throw new EmbeddingError('shape', `embedding: expected ${EMBED_DIMS} dims`);
    qCache.set(key, { v: Float32Array.from(v), exp: Date.now() + QUERY_VECTOR_TTL_MS });
    lastEmbedOkAt = Date.now();
    // Measured in production so the budgets can be re-tuned from logs (Ruling SEARCH-WARM-1).
    await ttlWrites;
    logger.info(
      { cold, budgetMs, chargeMs: tCharged - t0, embedMs: lastEmbedOkAt - tCharged },
      '[search] query embed ok'
    );
    return v;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vector leg: up to `limit` product ids of THIS store nearest to the query by the nearer of each
 * product's two vectors, doc and AI words (SEARCH-T13-7) (exact KNN per store,
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
  return (await vectorLeg(storeId, raw, opts)).ids;
}

/** Vectorize returns at most this many matches for a query that asks for metadata-less ids. */
const VECTORIZE_TOPK = 100;

/**
 * The vector leg of a DO store: Vectorize nearest vectors (cosine distance = 1 - score) within SEARCH_VECTOR_MAX_DISTANCE, a
 * product keeping its nearer vector (doc or words), then the DO decides which of them the storefront may show (active, not
 * deleted, public, vectored by this model). FAIL-SOFT: no binding or any Vectorize / DO error returns no ids and `degraded`, so
 * the caller serves the keyword order and does not cache the list as the full answer.
 */
async function vectorLegDo(
  storeId: string,
  v: number[],
  limit: number,
  money: NonNullable<Awaited<ReturnType<typeof storeMoney>>>
): Promise<{ ids: string[]; degraded: boolean }> {
  const index = cfBindings()?.PRODUCT_VECTORS ?? null; // the same binding the DO indexer uses (lib/search/do-index.ts)
  if (!index) {
    logger.warn(
      { storeId },
      '[search] no Vectorize binding (PRODUCT_VECTORS); keyword results only'
    );
    return { ids: [], degraded: true };
  }
  // NO `filter`: without a metadata index on storeId Vectorize matches nothing (Ruling SEARCH-SEMANTIC-LIVE-2).
  const res = await index.query(v, {
    topK: VECTORIZE_TOPK,
    namespace: storeId,
    returnMetadata: 'none',
  });
  const maxD = vectorMaxDistance();
  const best = new Map<string, number>();
  for (const m of res.matches ?? []) {
    const productId = m.id.slice(0, m.id.lastIndexOf(':'));
    const d = 1 - m.score;
    if (productId && d <= maxD && d < (best.get(productId) ?? Infinity)) best.set(productId, d);
  }
  if (best.size === 0) return { ids: [], degraded: false };
  const { ids: visible } = await money.vectorVisible({ ids: [...best.keys()] });
  const ok = new Set(visible);
  const ids = [...best.keys()]
    .filter(id => ok.has(id))
    .sort((a, b) => best.get(a)! - best.get(b)! || (a < b ? -1 : 1))
    .slice(0, Math.max(1, Math.floor(limit)));
  return { ids, degraded: false };
}

/**
 * The vector leg with its mode. `degraded` = the leg was WANTED (semantic on, an embeddable query)
 * but did not answer: no searcher, a budget or the searcher's limit refused, the race was lost, the
 * provider or the SQL failed. Skipped by design (off, not embeddable) is not degraded, and a cached
 * query vector is a full answer. A degraded list must never be cached as the full one (SEARCH-T12-7).
 */
async function vectorLeg(
  storeId: string,
  raw: string,
  opts: { searcher?: string; limit?: number }
): Promise<{ ids: string[]; degraded: boolean }> {
  const limit = opts.limit ?? HYBRID_LEG;
  if (!semanticSearchEnabled() || !shouldEmbedQuery(raw)) return { ids: [], degraded: false };
  // Budget-spent MODE (SEARCH-T12-10): keyword-only is the full answer until the next Cairo day,
  // with no Redis round trip and no cached-vector exception, so every list of this mode agrees.
  if (queryBudgetSpent(storeId)) return { ids: [], degraded: false };
  try {
    const v = await queryVector(storeId, raw, opts.searcher);
    if (!v) return { ids: [], degraded: true };
    // A store on its Durable Object (Ruling CF-VEC-1): its vectors are in Vectorize (namespace = store id), not in halfvec.
    // Postgres stores fall through to the halfvec query below, untouched.
    const money = await storeMoney(storeId);
    if (money) return await vectorLegDo(storeId, v, limit, money);
    const q = toHalfvecLiteral(v);
    const rows = await withSavepoint(
      () => prisma.$queryRaw<Array<{ id: string }>>`
        SELECT k.id FROM (
          -- The nearer of the product's two vectors (SEARCH-T13-7): the doc and, when it has
          -- any, the AI search words alone. LEAST ignores the NULL words vector.
          SELECT e.product_id AS id, LEAST(e.embedding <=> q.v, e.terms_embedding <=> q.v) AS d
            FROM product_embeddings e
            JOIN products p ON p.id = e.product_id AND p.store_id = ${storeId}
            CROSS JOIN (SELECT ${q}::halfvec(1024) AS v) q
           WHERE e.store_id = ${storeId} AND e.model = ${EMBED_MODEL}
             AND p.status = 'active' AND p.deleted_at IS NULL
             -- B2B-7b: the storefront (this leg is storefront-only) never ranks a wholesale-only product.
             AND p.audience = 'public'
        ) k
        WHERE k.d <= ${vectorMaxDistance()}
        ORDER BY k.d, k.id
        LIMIT ${Math.max(1, Math.floor(limit))}`
    );
    return { ids: rows.map(r => r.id), degraded: false };
  } catch (err) {
    const kind = err instanceof EmbeddingError ? err.kind : 'sql';
    const log = kind === 'timeout' || kind === 'aborted' ? logger.info : logger.warn;
    log.call(logger, { storeId, kind }, '[search] vector leg unavailable; keyword results only');
    return { ids: [], degraded: true };
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
  return (await rankedSearchWithMode(storeId, raw, opts)).ids;
}

/** `rankedSearch` plus whether the vector leg was wanted but unavailable (see `vectorLeg`). */
export async function rankedSearchWithMode(
  storeId: string,
  raw: string,
  opts: { searcher?: string } = {}
): Promise<{ ids: string[]; degraded: boolean }> {
  const lexical = await searchProductIds(storeId, raw, { scope: 'storefront' });
  if (lexical.length >= KEYWORD_STRONG_AT) return { ids: lexical, degraded: false };
  const vector = await vectorLeg(storeId, raw, { searcher: opts.searcher });
  return { ids: hybridOrder(lexical, vector.ids, HYBRID_LEG), degraded: vector.degraded };
}
