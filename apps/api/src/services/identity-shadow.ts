/**
 * The Store keeps a PROFILE row per merchant (`users`, same id as the identity) so every foreign key (stores.owner_id,
 * store_staff, audit logs, legal acceptances) stays valid. Credentials live only in the identity service. The row is
 * reconciled from the identity service at every sign-in and session refresh (`POST /auth/session`): email, verified flag,
 * MFA status and status. The password column of a row created here is the unusable marker '!identity'.
 */
import { withUser } from '@ebda/database';
import type { AccountState } from '../cf/bindings';
import { getAccountState } from '../lib/identity-client';
import { postgresRemovedOnThisWorker } from '../lib/postgres-present';
import { AppError } from '../middleware/error-handler';

export async function reconcileShadowUser(userId: string): Promise<AccountState> {
  const st = await getAccountState(userId);
  if (!st) throw new AppError(401, 'TOKEN_INVALID', 'Account not found');
  if (st.status !== 'active') throw new AppError(401, 'TOKEN_REVOKED', 'Account is not active');
  // NZ-D23: no Postgres profile table on the Worker; the identity service is the whole account.
  if (postgresRemovedOnThisWorker()) return st;
  await withUser(userId, async tx => {
    const exists = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (exists) {
      await tx.user.update({
        where: { id: userId },
        data: {
          email: st.email,
          emailVerified: st.emailVerified,
          mfaEnabled: st.mfaEnabled,
          mfaEnrolledAt: st.mfaEnrolledAt ? new Date(st.mfaEnrolledAt) : null,
          status: st.status,
          role: st.role,
        },
      });
    } else {
      await tx.user.create({
        data: {
          id: userId,
          storeId: null,
          email: st.email,
          passwordHash: '!identity',
          firstName: st.firstName,
          lastName: st.lastName,
          phone: st.phone,
          role: st.role,
          status: st.status,
          emailVerified: st.emailVerified,
          mfaEnabled: st.mfaEnabled,
          mfaEnrolledAt: st.mfaEnrolledAt ? new Date(st.mfaEnrolledAt) : null,
          language: st.language,
        },
      });
    }
  });
  return st;
}
