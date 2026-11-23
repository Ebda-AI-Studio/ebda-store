import { storeDb } from './repo-factory';
import { CustomerGroups, type GuestIdentity } from './customer-groups';
import logger from './logger';

/** Same bound as the Customers list scan (customer-aggregate.service MAX_ORDERS_SCANNED). */
const MAX_ORDERS_SCANNED = 20000;
const PAGE = 500;

/**
 * STALENESS CLASS: BOUNDED-stale (display and analytics only, NEVER consent: the consent gate does not use groups, Ruling QA98-ALIAS-2).
 * One dashboard load asks for the groups from several places (two period stats, the repeat rate, the rollups); the in-flight promise
 * is shared and a result is reused for 10 s, so a load scans the store once. A new guest order shows in the grouping within 10 s.
 */
const TTL_MS = 10_000;
const memo = new Map<string, { at: number; groups: Promise<CustomerGroups> }>();

function toIdentity(email: unknown, phone: unknown): GuestIdentity | null {
  const e = typeof email === 'string' ? email.toLowerCase() : '';
  const p = typeof phone === 'string' ? phone : '';
  const key = e || p;
  return key ? { key, email: e, phone: p } : null;
}

async function scanGroups(storeId: string): Promise<CustomerGroups> {
  const seen = new Map<string, GuestIdentity>();
  // The store's own backend client (its Durable Object or the legacy SQL backend), newest first by KEYSET (cursor on the id, never skip/offset): a
  // guest order placed while the scan runs cannot shift a page and make it skip or repeat a member.
  const odb = await storeDb(storeId);
  let cursor: string | undefined;
  let scanned = 0;
  for (;;) {
    const page = await odb.order.findMany({
      where: { storeId, deletedAt: null, customerId: null },
      select: { id: true, shippingAddress: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const o of page) {
      const a = (o.shippingAddress ?? {}) as Record<string, unknown>;
      const i = toIdentity(a.email, a.phone);
      if (i) seen.set(`${i.email}\u0000${i.phone}`, i);
    }
    scanned += page.length;
    if (page.length < PAGE) break;
    if (scanned >= MAX_ORDERS_SCANNED) {
      logger.warn(
        { storeId, scanned },
        '[customer-groups] guest scan hit its cap: older guest orders are not grouped'
      );
      break;
    }
    cursor = page[page.length - 1].id;
  }
  return new CustomerGroups(seen.values());
}

/**
 * The store's guest identities (distinct email + phone pairs of orders with no customer account), as `CustomerGroups`. The ONE loader
 * behind every group-aware DISPLAY surface that does not already hold the orders (detail, RFM, analytics counts).
 */
export function loadCustomerGroups(storeId: string): Promise<CustomerGroups> {
  const now = Date.now();
  const hit = memo.get(storeId);
  if (hit && now - hit.at < TTL_MS) return hit.groups;
  const groups = scanGroups(storeId);
  memo.set(storeId, { at: now, groups });
  // a failed scan is never reused
  groups.catch(() => {
    if (memo.get(storeId)?.groups === groups) memo.delete(storeId);
  });
  if (memo.size > 500) for (const [k, v] of memo) if (now - v.at >= TTL_MS) memo.delete(k);
  return groups;
}
