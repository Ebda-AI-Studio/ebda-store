import type { CustomerGroups } from './customer-groups';
import { loadCustomerGroups } from './customer-groups-store';
import { storeMoney } from './repo-factory';

/** One (customer id, email, phone) bucket of orders: what both backends hand back for the customer counts. */
interface BuyerIdentityRow {
  customerId: string | null;
  email: string | null;
  phone: string | null;
  n: number;
}

/**
 * QA98-ALIAS-1: the customer counts the dashboard shows (distinct customers, repeat buyers) fold guests through
 * `CustomerGroups`, the ONE grouping the Customers list uses, instead of re-deriving a key in SQL. Both backends return identity
 * rows and the grouping happens here, once: a Durable Object store through its `analyticsBuyerIdentities` op, a Postgres store through
 * the exact SQL aggregation its caller passes in (`pgRows`: a GROUP BY, never a row scan, so nothing is silently truncated).
 */
function buyerKey(r: BuyerIdentityRow, groups: CustomerGroups): string | null {
  if (r.customerId) return r.customerId;
  return groups.keyOfContact({ email: r.email, phone: r.phone });
}

/** Distinct customers: a guest with no contact is one customer per order (the list's `guest:<orderId>` row). */
// pq-allow(unused-export): test seam, imported by tests/unit/buyer-counts-grouped.test.ts
export function distinctCustomersFrom(rows: BuyerIdentityRow[], groups: CustomerGroups): number {
  const keys = new Set<string>();
  let anonymous = 0;
  for (const r of rows) {
    const k = buyerKey(r, groups);
    if (k) keys.add(k);
    else anonymous += r.n;
  }
  return keys.size + anonymous;
}

/** Repeat buyers over identifiable buyers only (an order with no id, email or phone is skipped). */
// pq-allow(unused-export): test seam, imported by tests/unit/buyer-counts-grouped.test.ts
export function repeatBuyersFrom(
  rows: BuyerIdentityRow[],
  groups: CustomerGroups
): { repeat: number; buyers: number } {
  const perBuyer = new Map<string, number>();
  for (const r of rows) {
    const k = buyerKey(r, groups);
    if (k) perBuyer.set(k, (perBuyer.get(k) ?? 0) + r.n);
  }
  let repeat = 0;
  for (const n of perBuyer.values()) if (n >= 2) repeat += 1;
  return { repeat, buyers: perBuyer.size };
}

type PgIdentityRows = () => Promise<BuyerIdentityRow[]>;

/** Distinct customers with an order in [start, end] (every status, not deleted), the way the Customers list groups them. */
export async function countDistinctCustomersGrouped(
  storeId: string,
  start: Date,
  end: Date,
  pgRows: PgIdentityRows
): Promise<number> {
  const money = await storeMoney(storeId);
  const [rows, groups] = await Promise.all([
    money
      ? money.analyticsBuyerIdentities({
          mode: 'all',
          startMs: start.getTime(),
          endMs: end.getTime(),
        })
      : pgRows(),
    loadCustomerGroups(storeId),
  ]);
  return distinctCustomersFrom(rows, groups);
}

/** Repeat buyers over paid orders since `since`, the way the Customers list groups them. */
export async function repeatBuyersGrouped(
  storeId: string,
  since: Date,
  pgRows: PgIdentityRows
): Promise<{ repeat: number; buyers: number }> {
  const money = await storeMoney(storeId);
  const [rows, groups] = await Promise.all([
    money ? money.analyticsBuyerIdentities({ mode: 'paid', sinceMs: since.getTime() }) : pgRows(),
    loadCustomerGroups(storeId),
  ]);
  return repeatBuyersFrom(rows, groups);
}
