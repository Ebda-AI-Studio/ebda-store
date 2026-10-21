import { prisma, Prisma } from '@ebda/database';

/**
 * Most customer ids the order search resolves up front. Above this the term
 * is too broad for an id list to be worth binding, and the search falls back
 * to the relation filter (same rows, unindexed plan). 1000 bind parameters is
 * nowhere near Postgres' 65535 ceiling.
 */
export const ORDER_SEARCH_CUSTOMER_ID_CAP = 1000;

/** `%term%` with LIKE metacharacters escaped, so the term is matched literally. */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * Ids (capped at `ORDER_SEARCH_CUSTOMER_ID_CAP + 1` so a caller can tell "too many") from the
 * store-scoped SECURITY DEFINER `public.ebda_order_search_ids` (migration
 * 20261024000500_order_customer_search_ids, Ruling SEARCH-T14-5):
 *   'order_number'  live orders whose number contains the term
 * (The 'guest' and 'customers' kinds were dropped by migration 20261029000300, Ruling
 * SEARCH-P2-5: customer and guest lookups go through `ebda_customer_search_ids`.)
 * The function refuses any store but the one in `app.current_store_id`; the term is only ever a
 * bound parameter, never logged (it is PII: a phone or an email).
 */
export async function orderSearchIds(
  storeId: string,
  kind: 'order_number',
  search: string,
  limit: number = ORDER_SEARCH_CUSTOMER_ID_CAP + 1
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(
    orderSearchIdsSql(storeId, kind, search, limit)
  );
  return rows.map(r => r.id);
}

/** The statement behind `orderSearchIds`; exported so the tests run the real SQL. */
export function orderSearchIdsSql(
  storeId: string,
  kind: 'order_number',
  search: string,
  limit: number
): Prisma.Sql {
  return Prisma.sql`SELECT public.ebda_order_search_ids(${storeId}, ${kind}, ${likeContains(search)}, ${limit}) AS id`;
}
