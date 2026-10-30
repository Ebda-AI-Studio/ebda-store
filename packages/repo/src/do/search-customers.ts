// DO port of the customer and order lookups (ebda_customer_search_ids, ebda_order_search_ids 'order_number',
// apps/api/src/services/admin-search.service.ts `matchingCustomers`, customer-search.service.ts).
//
//   registered customers  -> the store's `customers` rows (the Postgres `users` with an order here or registered here)
//   guest orders          -> orders with customer_id NULL and not deleted, matched on the shipping contact JSON
// Names: every Arabic-folded token must be contained in the folded full name (AND); phones: the digits form matches
// `%digits%` of the digits-only phone; email: ILIKE `%term%`. Documents are folded in TS (`normalizeArabicSearch`,
// `digitsOnly`), kept fresh by the dirty-marking triggers in search.ts. Order numbers: a literal contains-match.
import { buildCustomerPatterns } from '../../../shared/src/search/customer-patterns';
import { normalizeArabicSearch, escapeLike } from '../../../shared/src/search/arabic-normalize';
import { digitsOnly } from '../../../shared/src/search/phone-search';
import { flushSearchIndex } from './search';
import type { SyncSql } from './sync-sql';

export const CUSTOMER_MATCH_USER_CAP = 1000;
export const CUSTOMER_MATCH_GUEST_ORDER_CAP = 20000;
export const ORDER_SEARCH_CAP = 5000;

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

function put(
  db: SyncSql,
  kind: 'user' | 'guest_order',
  id: string,
  store: string,
  name: string,
  phone: string,
  email: string
) {
  db.run('DELETE FROM customer_search_fts WHERE kind = ? AND ref_id = ?', [kind, id]);
  db.run(
    'INSERT INTO customer_search_fts (name_doc, digits, email, kind, ref_id, store_id) VALUES (?, ?, ?, ?, ?, ?)',
    [normalizeArabicSearch(name), digitsOnly(phone), email, kind, id, store]
  );
}
export function indexCustomer(db: SyncSql, id: string): void {
  const r = db.all(
    'SELECT id, store_id, first_name, last_name, phone, email FROM customers WHERE id = ?',
    [id]
  )[0];
  if (!r)
    return void db.run("DELETE FROM customer_search_fts WHERE kind = 'user' AND ref_id = ?", [id]);
  put(
    db,
    'user',
    id,
    r.store_id as string,
    `${s(r.first_name)} ${s(r.last_name)}`,
    s(r.phone),
    s(r.email)
  );
}
export function indexGuestOrder(db: SyncSql, id: string): void {
  const r = db.all(
    'SELECT id, store_id, customer_id, deleted_at, shipping_address FROM orders WHERE id = ?',
    [id]
  )[0];
  if (!r || r.customer_id !== null || r.deleted_at !== null)
    return void db.run(
      "DELETE FROM customer_search_fts WHERE kind = 'guest_order' AND ref_id = ?",
      [id]
    );
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(s(r.shipping_address)) ?? {};
  } catch {
    /* json_valid CHECK makes this unreachable; a bad row simply has no contact */
  }
  put(
    db,
    'guest_order',
    id,
    r.store_id as string,
    `${s(a.firstName)} ${s(a.lastName)}`,
    s(a.phone),
    s(a.email)
  );
}

export interface CustomerMatches {
  userIds: string[];
  guestOrderIds: string[];
  truncated: boolean;
  usersTruncated: boolean;
  guestsTruncated: boolean;
}

/**
 * The ids an order's `customer_id` can hold for these CRM rows (Ruling CF-FIX-1). Postgres has `orders.customer_id -> users.id`:
 * a migrated order, and any order a signed-in shopper placed, carries the PLATFORM user id, while an order a merchant opened
 * for a CRM row (`createAdminOrder`) carries `customers.id`. The CRM row links to its user through `customers.user_id`, which
 * equals `customers.id` only by chance. So a matched row stands for BOTH ids; `userIds` returns the row ids first, then the
 * linked user ids not already listed (one bound parameter: json_each).
 */
function withLinkedUserIds(db: SyncSql, storeId: string, rowIds: string[]): string[] {
  if (rowIds.length === 0) return rowIds;
  const seen = new Set(rowIds);
  const linked = db
    .all(
      'SELECT user_id FROM customers WHERE store_id = ? AND user_id IS NOT NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY id',
      [storeId, JSON.stringify(rowIds)]
    )
    .map(r => r.user_id as string)
    .filter(u => !seen.has(u) && seen.add(u));
  return [...rowIds, ...linked];
}

/** Registered customers and guest orders matching what an admin typed. Store-scoped; empty for an empty query. */
export function matchingCustomers(
  db: SyncSql,
  storeId: string,
  q: string,
  caps: { userCap?: number; guestCap?: number } = {}
): CustomerMatches {
  const userCap = caps.userCap ?? CUSTOMER_MATCH_USER_CAP;
  const guestCap = caps.guestCap ?? CUSTOMER_MATCH_GUEST_ORDER_CAP;
  const p = buildCustomerPatterns(q);
  const none = {
    userIds: [],
    guestOrderIds: [],
    truncated: false,
    usersTruncated: false,
    guestsTruncated: false,
  };
  if (!storeId || (p.names.length === 0 && !p.digits && !p.email)) return none;
  flushSearchIndex(db);
  const arms: string[] = [];
  const params: unknown[] = [];
  if (p.names.length > 0) {
    arms.push(`(${p.names.map(() => "name_doc LIKE ? ESCAPE '\\'").join(' AND ')})`);
    params.push(...p.names.slice(0, 8));
  }
  if (p.digits) {
    arms.push("digits LIKE ? ESCAPE '\\'");
    params.push(p.digits);
  }
  if (p.email) {
    arms.push("email LIKE ? ESCAPE '\\'");
    params.push(p.email);
  }
  const pick = (kind: string, cap: number) =>
    db
      .all(
        `SELECT ref_id FROM customer_search_fts WHERE store_id = ? AND kind = ? AND (${arms.join(' OR ')}) ORDER BY ref_id LIMIT ?`,
        [storeId, kind, ...params, cap + 1]
      )
      .map(r => r.ref_id as string);
  const users = pick('user', userCap);
  const guests = pick('guest_order', guestCap);
  const usersTruncated = users.length > userCap;
  const guestsTruncated = guests.length > guestCap;
  const kept = users.slice(0, userCap);
  return {
    userIds: withLinkedUserIds(db, storeId, kept),
    guestOrderIds: guests.slice(0, guestCap),
    truncated: usersTruncated || guestsTruncated,
    usersTruncated,
    guestsTruncated,
  };
}

/** Live orders whose number contains the term, literally (a `%` or `_` typed by the admin is not a wildcard). */
export function searchOrderNumbers(
  db: SyncSql,
  storeId: string,
  term: string,
  limit = ORDER_SEARCH_CAP + 1
): string[] {
  const t = (term ?? '').trim();
  if (!storeId || !t || !Number.isInteger(limit) || limit < 1) return [];
  return db
    .all(
      "SELECT id FROM orders WHERE store_id = ? AND deleted_at IS NULL AND order_number LIKE ? ESCAPE '\\' ORDER BY id LIMIT ?",
      [storeId, `%${escapeLike(t)}%`, Math.min(limit, ORDER_SEARCH_CAP)]
    )
    .map(r => r.id as string);
}
