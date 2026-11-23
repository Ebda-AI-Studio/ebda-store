import { storeDb } from './repo-factory';
import { CustomerGroups, type GuestIdentity } from './customer-groups';

/** Same bound as the Customers list scan (customer-aggregate.service MAX_ORDERS_SCANNED). */
const MAX_ORDERS_SCANNED = 20000;

function toIdentity(email: unknown, phone: unknown): GuestIdentity | null {
  const e = typeof email === 'string' ? email.toLowerCase() : '';
  const p = typeof phone === 'string' ? phone : '';
  const key = e || p;
  return key ? { key, email: e, phone: p } : null;
}

/**
 * The store's guest identities (distinct email + phone pairs of orders with no customer account), as `CustomerGroups`. This is the
 * ONE loader behind every group-aware surface that does not already hold the orders (detail, RFM, consent gate, analytics). Read through
 * the store's own backend (Postgres or Durable Object, neither has a portable JSON-path DISTINCT) as newest-first bounded pages, the
 * same 20k cap as the list.
 */
export async function loadCustomerGroups(storeId: string): Promise<CustomerGroups> {
  const seen = new Map<string, GuestIdentity>();
  const note = (email: unknown, phone: unknown): void => {
    const i = toIdentity(email, phone);
    if (i) seen.set(`${i.email}\u0000${i.phone}`, i);
  };
  // The store's own backend client (Postgres or its Durable Object) with bounded newest-first paging: no raw SQL on public.orders.
  const odb = await storeDb(storeId);
  const PAGE = 500;
  for (let skip = 0; skip < MAX_ORDERS_SCANNED; skip += PAGE) {
    const page = await odb.order.findMany({
      where: { storeId, deletedAt: null, customerId: null },
      select: { shippingAddress: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE,
      skip,
    });
    for (const o of page) {
      const a = (o.shippingAddress ?? {}) as Record<string, unknown>;
      note(a.email, a.phone);
    }
    if (page.length < PAGE) break;
  }
  return new CustomerGroups(seen.values());
}
