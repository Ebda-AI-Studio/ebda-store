import { prisma, Prisma } from '@ebda/database';
import { storeMoney } from '../lib/repo-factory';
import { buildCustomerPatterns, type CustomerPatterns } from '@ebda/shared';

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

export { buildCustomerPatterns, type CustomerPatterns } from '@ebda/shared';

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
  // A store on its Durable Object matches against its own customer / guest-contact index (Ruling CF-R6A-1).
  const money = await storeMoney(storeId);
  if (money) return money.searchCustomers({ q, userCap, guestCap });
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
