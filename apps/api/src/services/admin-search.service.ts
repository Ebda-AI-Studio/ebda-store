import { prisma, Prisma } from '@ebda/database';
import { normalizeArabicSearch, searchTokens, escapeLike, phoneSearchDigits } from '@ebda/shared';

/** Most registered customers / guest orders one admin search resolves (cap + 1 detects "more"). */
export const CUSTOMER_MATCH_USER_CAP = 1000;
export const CUSTOMER_MATCH_GUEST_ORDER_CAP = 20000;

export interface CustomerMatches {
  userIds: string[];
  guestOrderIds: string[];
  /** A cap was hit: more customers match than were returned. */
  truncated: boolean;
  /** Which half hit its cap (a caller can degrade just that half). */
  usersTruncated: boolean;
  guestsTruncated: boolean;
}

/** `%x%` LIKE patterns for the store-scoped definer (see `buildCustomerPatterns`). */
export interface CustomerPatterns {
  names: string[];
  digits: string | null;
  email: string | null;
}

/**
 * Turn what an admin typed into the definer's three arms (migration 20261027000200):
 *  - names:  every Arabic-normalised token must be contained in the full name (AND);
 *  - digits: (only for a digits-and-punctuation term) the phone in any form (+20 / 0020 / 01x / Arabic-Indic digits), see `phoneSearchDigits`;
 *  - email:  a Latin/@ term with no whitespace, 3+ characters, ILIKE-matched against the email (E18-E20).
 * A token with no letter (digits, '+20') is a phone/order-number term, never a name, so it adds no name pattern.
 */
export function buildCustomerPatterns(q: string): CustomerPatterns {
  const raw = (q ?? '').trim().slice(0, 100);
  // A phone term holds only digits and phone punctuation: "a3f09b1c4e" is not a number just
  // because 4+ of its characters are digits (that would add a broad digits arm to every id search).
  const digits = /^[+\d\s\-().]+$/.test(normalizeArabicSearch(raw)) ? phoneSearchDigits(raw) : null;
  const tokens = searchTokens(raw);
  const names = tokens.filter(t => /\p{L}/u.test(t));
  return {
    names: names.map(t => `%${escapeLike(t)}%`),
    digits: digits ? `%${digits}%` : null,
    email:
      raw.length >= 3 && !/\s/.test(raw) && /[A-Za-z@]/.test(raw) ? `%${escapeLike(raw)}%` : null,
  };
}

/**
 * Registered customers (users with an order in this store, or registered on it) and GUEST orders
 * (shipping contact only) matching `q`, through the store-scoped SECURITY DEFINER
 * `ebda_customer_search_ids`: as `ebda_app` the RLS barrier forbids every trigram index when the
 * predicate is written inline (Ruling SEARCH-T14-1). The term is only ever a bound parameter and is
 * never logged (a phone or an email is PII).
 */
export async function matchingCustomers(
  storeId: string,
  q: string,
  caps: { userCap?: number; guestCap?: number } = {}
): Promise<CustomerMatches> {
  const userCap = caps.userCap ?? CUSTOMER_MATCH_USER_CAP;
  const guestCap = caps.guestCap ?? CUSTOMER_MATCH_GUEST_ORDER_CAP;
  const p = buildCustomerPatterns(q);
  if (p.names.length === 0 && !p.digits && !p.email) {
    return {
      userIds: [],
      guestOrderIds: [],
      truncated: false,
      usersTruncated: false,
      guestsTruncated: false,
    };
  }
  const rows = await prisma.$queryRaw<Array<{ kind: string; id: string }>>(
    customerSearchIdsSql(storeId, p, userCap, guestCap)
  );
  const users = rows.filter(r => r.kind === 'user');
  const guests = rows.filter(r => r.kind === 'guest_order');
  const usersTruncated = users.length > userCap;
  const guestsTruncated = guests.length > guestCap;
  return {
    userIds: users.slice(0, userCap).map(r => r.id),
    guestOrderIds: guests.slice(0, guestCap).map(r => r.id),
    truncated: usersTruncated || guestsTruncated,
    usersTruncated,
    guestsTruncated,
  };
}

/** The statement behind `matchingCustomers`; exported so the planner tests run the real SQL. */
export function customerSearchIdsSql(
  storeId: string,
  p: CustomerPatterns,
  userCap: number = CUSTOMER_MATCH_USER_CAP,
  guestCap: number = CUSTOMER_MATCH_GUEST_ORDER_CAP
): Prisma.Sql {
  return Prisma.sql`SELECT kind, id FROM public.ebda_customer_search_ids(
    ${storeId}, ${p.names}::text[], ${p.digits}::text, ${p.email}::text,
    ${userCap + 1}::int, ${guestCap + 1}::int)`;
}
