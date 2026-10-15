import { prisma, Prisma } from '@ebda/database';
import { searchTokens, escapeLike, normalizeArabicSearch } from '@ebda/shared';

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
  const arms = tokens.map(t => {
    const pattern = `%${escapeLike(t)}%`;
    return opts.scope === 'admin'
      ? Prisma.sql`(${doc} LIKE ${pattern} OR public.ebda_ar_norm(coalesce(p.sku, '')) LIKE ${pattern})`
      : Prisma.sql`${doc} LIKE ${pattern}`;
  });
  const status = opts.scope === 'storefront' ? Prisma.sql`AND p.status = 'active'` : Prisma.empty;
  const deleted = opts.includeDeleted ? Prisma.empty : Prisma.sql`AND p.deleted_at IS NULL`;
  const qNorm = normalizeArabicSearch(raw);
  // limit + 1: the extra row only says "there were more" (truncated).
  return Prisma.sql`SELECT p.id FROM products p
    WHERE p.store_id = ${storeId} ${deleted} ${status}
      AND ${Prisma.join(arms, ' AND ')}
    ORDER BY similarity(public.ebda_product_name_doc(p.name, p.name_ar, p.search_terms), ${qNorm}) DESC, p.id
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

/**
 * Small per-store admin lists searched by name + Arabic name with the same folding (bundles,
 * promotions). These tables are tiny per store (store_id-indexed), so the normalised LIKE runs on
 * the store's rows without an expression index. Each table has its own literal statement (no
 * Prisma.raw table name).
 */
export async function searchNameIds(
  table: 'bundles' | 'promotions',
  storeId: string,
  raw: string
): Promise<string[]> {
  const tokens = searchTokens(raw);
  if (tokens.length === 0) return [];
  const match = Prisma.join(
    tokens.map(
      t =>
        Prisma.sql`public.ebda_ar_norm(coalesce(t.name, '') || ' ' || coalesce(t.name_ar, '')) LIKE ${`%${escapeLike(t)}%`}`
    ),
    ' AND '
  );
  const rows =
    table === 'bundles'
      ? await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT t.id FROM bundles t WHERE t.store_id = ${storeId} AND ${match}
          LIMIT ${PRODUCT_SEARCH_ID_CAP}`
      : await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT t.id FROM promotions t WHERE t.store_id = ${storeId} AND ${match}
          LIMIT ${PRODUCT_SEARCH_ID_CAP}`;
  return rows.map(r => r.id);
}
