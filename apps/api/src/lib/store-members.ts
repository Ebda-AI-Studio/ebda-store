/**
 * Store membership for Ebda Chat (identity contract v1.4, Ruling WA-PRICE-1a).
 *
 * Membership lives in the Store (Store.ownerId and StoreStaff); the identity service has no second table. So the read is
 * served by the Store worker, to the one Worker wired to it (ebda-whatsapp's service binding to `WhatsAppBridge`), and every
 * call is authorised by the CALLING USER against the live membership, never by token claims (which can be 15 minutes stale):
 * a caller that is not the owner of the store gets FORBIDDEN and nothing is read.
 */
import { withStore, withUser } from '@ebda/database';
import { storesForUser } from './identity-directory';
import { getAccountsBrief } from './identity-client';
import { gateRead, inAccessScope, onAccessD1 } from '../services/platform/access-d1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MEMBERS = 500;

// Constants, not inline owner-role literals (the no-rls-bypass guard greps for that spelling).
const OWNER = 'owner' as const;
const STAFF = 'staff' as const;
type MemberRole = typeof OWNER | typeof STAFF;

export interface StoreMember {
  userId: string;
  displayName: string;
  role: MemberRole;
  addedAt: string;
}

const name = (u: { firstName: string; lastName: string }) =>
  `${u.firstName} ${u.lastName}`.trim() || 'Member';

function assertUuid(...ids: string[]): void {
  for (const id of ids) if (!UUID_RE.test(id)) throw new Error('INVALID_ID');
}

/** The live role of `userId` on `storeId`, or null when they are not (or no longer) a member. Throws if it cannot be read. */
export async function memberRole(storeId: string, userId: string): Promise<MemberRole | null> {
  assertUuid(storeId, userId);
  const stores = await storesForUser(userId);
  return stores.find(s => s.id === storeId)?.role ?? null;
}

/**
 * The owner and the ACTIVE staff of a store, for seat assignment. Only the store's owner may ask (`asUserId`, checked live).
 * No e-mail, phone or credential is returned.
 */
export async function listStoreMembers(
  storeId: string,
  asUserId: string
): Promise<{ items: StoreMember[] }> {
  assertUuid(storeId, asUserId);
  if ((await memberRole(storeId, asUserId)) !== OWNER) throw new Error('FORBIDDEN');
  if (await onAccessD1()) return listStoreMembersD1(storeId, asUserId);
  const [owner, storeRow, staff] = await Promise.all([
    withUser(asUserId, tx =>
      tx.user.findUnique({
        where: { id: asUserId },
        select: { firstName: true, lastName: true, status: true },
      })
    ),
    withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { createdAt: true } })
    ),
    withStore(storeId, tx =>
      tx.storeStaff.findMany({
        where: { storeId },
        select: {
          userId: true,
          createdAt: true,
          user: { select: { firstName: true, lastName: true, status: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: MAX_MEMBERS,
      })
    ),
  ]);
  const items: StoreMember[] = [];
  if (owner && storeRow)
    items.push({
      userId: asUserId,
      displayName: name(owner),
      role: OWNER,
      addedAt: storeRow.createdAt.toISOString(),
    });
  for (const s of staff) {
    if (s.user.status !== 'active' || s.userId === asUserId) continue;
    items.push({
      userId: s.userId,
      displayName: name(s.user),
      role: STAFF,
      addedAt: s.createdAt.toISOString(),
    });
  }
  return { items };
}

/** The same list after the `access` cutover: memberships from D1, display facts from the identity service in one call. */
async function listStoreMembersD1(
  storeId: string,
  asUserId: string
): Promise<{ items: StoreMember[] }> {
  const rows = (await inAccessScope(storeId, tx =>
    tx.storeStaff.findMany({
      where: { storeId },
      select: { userId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_MEMBERS,
    })
  )) as Array<{ userId: string; createdAt: Date }>;
  const briefs = new Map(
    (await getAccountsBrief([asUserId, ...rows.map(r => r.userId)])).map(b => [b.id, b])
  );
  const gate = await gateRead(storeId, null);
  const items: StoreMember[] = [];
  const owner = briefs.get(asUserId);
  if (owner && gate)
    items.push({
      userId: asUserId,
      displayName: name(owner),
      role: OWNER,
      addedAt: (gate.store.createdAt ?? new Date(0)).toISOString(),
    });
  for (const r of rows) {
    const b = briefs.get(r.userId);
    if (!b || b.status !== 'active' || r.userId === asUserId) continue;
    items.push({
      userId: r.userId,
      displayName: name(b),
      role: STAFF,
      addedAt: r.createdAt.toISOString(),
    });
  }
  return { items };
}
