import { prisma } from '@ebda/database';
import { asOperator } from '../lib/platform-scope';
import { closeGrantedRequests, type ReviewDb } from './trust-requests.service';

/**
 * The super-admin grant path closes the matching open trust request in the SAME flow (called BEFORE the grant and
 * failing loud, Ruling TRUST-2), so a helped merchant can ask again:
 *  - a super admin puts a store on a protected address (POST /stores, PUT /stores/:id, PUT /admin/stores/:id)
 *    -> every open slug claim for that address;
 */
const db = () => prisma as unknown as ReviewDb;

export function closeClaimsOnSlugGrant(actorId: string, slug: string | undefined): Promise<number> {
  if (!slug) return Promise.resolve(0);
  return asOperator(actorId, () => closeGrantedRequests(db(), { slug }));
}
