import { withUser } from '@ebda/database';

/** A self-serve owner may hold this many stores (abuse bound; staff can grant more through a store-limit request). */
export const MAX_SELF_SERVE_STORES_PER_OWNER = 3;
/** The range staff may set through the trust-requests screen (lowering back to 3 is allowed). */
export const STORE_LIMIT_MAX = 20;
export const STORE_LIMIT_MIN = MAX_SELF_SERVE_STORES_PER_OWNER;

interface LimitDb {
  trustRequest: {
    findMany(args: Record<string, unknown>): Promise<Array<{ grantedLimit: number | null }>>;
  };
}

/**
 * The owner's granted limit: the LATEST decided store-limit grant (so staff can revise it, up or down), or null when
 * none was granted.
 */
async function grantedStoreLimit(db: LimitDb, ownerId: string): Promise<number | null> {
  const rows = await db.trustRequest.findMany({
    where: { userId: ownerId, kind: 'store_cap', status: 'resolved', grantedLimit: { not: null } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { grantedLimit: true },
  });
  return rows[0]?.grantedLimit ?? null;
}

/**
 * The owner's ABUSE cap: the staff-granted limit when there is one, else the constant. It never lifts the paid plan's
 * store allowance: the effective limit is min(plan allowance or unlimited, this), and the plan check stays as it is.
 */
export async function ownerStoreLimit(ownerId: string): Promise<number> {
  const granted = await withUser(ownerId, tx =>
    grantedStoreLimit(tx as unknown as LimitDb, ownerId)
  );
  return Math.max(granted ?? 0, MAX_SELF_SERVE_STORES_PER_OWNER);
}
