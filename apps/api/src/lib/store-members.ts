/**
 * Store membership for Ebda WhatsApp (identity contract v1.4, Ruling WA-PRICE-1a).
 *
 * Membership lives in the Store (Store.ownerId and StoreStaff); the identity service has no second table. So the read is
 * served by the Store worker, to the one Worker wired to it (ebda-whatsapp's service binding to `WhatsAppBridge`), and every
 * call is authorised by the CALLING USER against the live membership, never by token claims (which can be 15 minutes stale):
 * a caller that is not the owner of the store gets FORBIDDEN and nothing is read.
 */
import { withStore, withUser } from '@ebda/database';
import { storesForUser } from './identity-directory';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MEMBERS = 500;

export interface StoreMember {
  userId: string;
  displayName: string;
  role: 'owner' | 'staff';
  addedAt: string;
}

const name = (u: { firstName: string; lastName: string }) =>
  `${u.firstName} ${u.lastName}`.trim() || 'Member';

function assertUuid(...ids: string[]): void {
  for (const id of ids) if (!UUID_RE.test(id)) throw new Error('INVALID_ID');
}

/** The live role of `userId` on `storeId`, or null when they are not (or no longer) a member. Throws if it cannot be read. */
export async function memberRole(
  storeId: string,
  userId: string
): Promise<'owner' | 'staff' | null> {
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
  if ((await memberRole(storeId, asUserId)) !== 'owner') throw new Error('FORBIDDEN');
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
      role: 'owner',
      addedAt: storeRow.createdAt.toISOString(),
    });
  for (const s of staff) {
    if (s.user.status !== 'active' || s.userId === asUserId) continue;
    items.push({
      userId: s.userId,
      displayName: name(s.user),
      role: 'staff',
      addedAt: s.createdAt.toISOString(),
    });
  }
  return { items };
}
