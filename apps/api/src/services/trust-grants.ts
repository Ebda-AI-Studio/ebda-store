import { prisma } from '@ebda/database';
import { asOperator } from '../lib/platform-scope';
import { storeDb } from '../lib/repo-factory';
import { closeGrantedRequests, type ReviewDb } from './trust-requests.service';

/**
 * The super-admin grant paths close the matching open trust request in the SAME flow (called BEFORE the grant and
 * failing loud, Ruling TRUST-2), so a helped merchant can ask again:
 *  - a super admin puts a store on a protected address (POST /stores, PUT /stores/:id, PUT /admin/stores/:id)
 *    -> every open slug claim for that address;
 *  - a super admin changes a store's plan (PUT /admin/stores/:id/subscription), which sets the owner's store
 *    allowance -> that owner's open store-limit request.
 */
const db = () => prisma as unknown as ReviewDb;

export function closeClaimsOnSlugGrant(actorId: string, slug: string | undefined): Promise<number> {
  if (!slug) return Promise.resolve(0);
  return asOperator(actorId, () => closeGrantedRequests(db(), { slug }));
}

export async function closeCapRequestOnPlanGrant(
  actorId: string,
  storeId: string
): Promise<number> {
  const store = await (
    await storeDb(storeId)
  ).store.findUnique({
    where: { id: storeId },
    select: { ownerId: true },
  });
  if (!store?.ownerId) return 0;
  return asOperator(actorId, () => closeGrantedRequests(db(), { ownerId: store.ownerId }));
}
