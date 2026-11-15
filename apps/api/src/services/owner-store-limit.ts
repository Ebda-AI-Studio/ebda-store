import { withUser } from '@ebda/database';

/** A self-serve owner may hold this many stores (abuse bound; staff can grant more through a store-limit request). */
export const MAX_SELF_SERVE_STORES_PER_OWNER = 3;
/** The most staff may grant through the trust-requests screen. */
export const STORE_LIMIT_MAX = 20;

interface LimitDb {
  trustRequest: {
    findMany(args: Record<string, unknown>): Promise<Array<{ grantedLimit: number | null }>>;
  };
}

/** The owner's granted limit (largest across their resolved store-limit requests), or null when none was granted. */
export async function grantedStoreLimit(db: LimitDb, ownerId: string): Promise<number | null> {
  const rows = await db.trustRequest.findMany({
    where: { userId: ownerId, kind: 'store_cap', status: 'resolved', grantedLimit: { not: null } },
    orderBy: { grantedLimit: 'desc' },
    take: 1,
    select: { grantedLimit: true },
  });
  return rows[0]?.grantedLimit ?? null;
}

/** How many stores this owner may hold: the staff-granted limit when there is one, else the constant. */
export async function ownerStoreLimit(ownerId: string): Promise<number> {
  const granted = await withUser(ownerId, tx =>
    grantedStoreLimit(tx as unknown as LimitDb, ownerId)
  );
  return Math.max(granted ?? 0, MAX_SELF_SERVE_STORES_PER_OWNER);
}
