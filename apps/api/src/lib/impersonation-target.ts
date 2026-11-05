/**
 * NEON-ZERO (Ruling NZ-PG-2): the account a super-admin impersonates, read WITHOUT Postgres once the `access` family is on D1.
 * An admin-namespace account (store_admin / staff) is the identity service's; a storefront customer is its store's DO (found
 * through the D1 entity index, then `userState` / `profiles` of that store). Unknown anywhere = null (a 404).
 */
import { getAccountState } from './identity-client';
import { getEntityStoreId } from './definer';
import { customerAuthRoute } from './customer-auth';
import { customerRow } from './customer-directory';
import { redis } from '../services/redis.service';

export interface ImpersonationTarget {
  id: string;
  email: string;
  role: string;
  storeId: string | null;
  deletedAt: Date | null;
  tokenVersion: number;
  status: string;
}

export async function impersonationTargetD1(userId: string): Promise<ImpersonationTarget | null> {
  const acc = await getAccountState(userId);
  if (acc && acc.role !== 'customer') {
    return {
      id: acc.id,
      email: acc.email,
      role: acc.role,
      storeId: null,
      deletedAt: null,
      tokenVersion: (await redis.getUserTokenVersion(userId)) ?? 0,
      status: acc.status,
    };
  }
  const storeId = await getEntityStoreId('customer', userId);
  if (!storeId) return null;
  const route = await customerAuthRoute(storeId, { write: false });
  if (route.kind !== 'do') return null;
  const [row, st] = await Promise.all([
    customerRow(storeId, userId),
    route.client.call<{ tokenVersion: number } | null>('userState', { userId }),
  ]);
  if (!row || !st) return null;
  return {
    id: row.id,
    email: row.email,
    role: 'customer',
    storeId,
    deletedAt: row.deletedAt,
    tokenVersion: st.tokenVersion,
    status: row.status,
  };
}
