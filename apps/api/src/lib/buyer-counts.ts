import type { CustomerGroups } from './customer-groups';
import { loadCustomerGroups } from './customer-groups-store';
import { storeDb, storeMoney } from './repo-factory';

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
 * rows (Postgres below, the Durable Object's `analyticsBuyerIdentities`) and the grouping happens here, once.
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

/** Bound on orders folded per count on a Postgres store (500k in the busiest realistic store is far beyond this; the list scans 20k). */
const MAX_ORDERS_SCANNED = 200_000;

type Window = { mode: 'all'; start: Date; end: Date } | { mode: 'paid'; since: Date };

async function identityRows(storeId: string, w: Window): Promise<BuyerIdentityRow[]> {
  const money = await storeMoney(storeId);
  if (money) {
    return money.analyticsBuyerIdentities(
      w.mode === 'all'
        ? { mode: 'all', startMs: w.start.getTime(), endMs: w.end.getTime() }
        : { mode: 'paid', sinceMs: w.since.getTime() }
    );
  }
  // A Postgres store: the same identity buckets, folded from bounded keyset pages through the store client (no raw SQL on public.orders).
  const db = await storeDb(storeId);
  const buckets = new Map<string, BuyerIdentityRow>();
  const where =
    w.mode === 'all'
      ? { storeId, deletedAt: null, createdAt: { gte: w.start, lte: w.end } }
      : { storeId, paymentStatus: 'paid' as const, createdAt: { gte: w.since } };
  const PAGE = 1000;
  let cursor: string | undefined;
  for (let scanned = 0; scanned < MAX_ORDERS_SCANNED; scanned += PAGE) {
    const page = await db.order.findMany({
      where,
      select: { id: true, customerId: true, shippingAddress: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const o of page) {
      const a = (o.shippingAddress ?? {}) as Record<string, unknown>;
      const email = typeof a.email === 'string' && a.email ? a.email.toLowerCase() : null;
      const phone = typeof a.phone === 'string' && a.phone ? a.phone : null;
      const customerId = o.customerId || null;
      const k = `${customerId}\u0000${email}\u0000${phone}`;
      const b = buckets.get(k) ?? { customerId, email, phone, n: 0 };
      b.n += 1;
      buckets.set(k, b);
    }
    if (page.length < PAGE) break;
    cursor = page[page.length - 1].id;
  }
  return [...buckets.values()];
}

/** Distinct customers with an order in [start, end] (every status, not deleted), the way the Customers list groups them. */
export async function countDistinctCustomersGrouped(
  storeId: string,
  start: Date,
  end: Date
): Promise<number> {
  const [rows, groups] = await Promise.all([
    identityRows(storeId, { mode: 'all', start, end }),
    loadCustomerGroups(storeId),
  ]);
  return distinctCustomersFrom(rows, groups);
}

/** Repeat buyers over paid orders since `since`, the way the Customers list groups them. */
export async function repeatBuyersGrouped(
  storeId: string,
  since: Date
): Promise<{ repeat: number; buyers: number }> {
  const [rows, groups] = await Promise.all([
    identityRows(storeId, { mode: 'paid', since }),
    loadCustomerGroups(storeId),
  ]);
  return repeatBuyersFrom(rows, groups);
}
