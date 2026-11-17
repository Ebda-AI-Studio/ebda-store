/**
 * Staff membership reads and removal, shared by the staff routes and the Store assistant (`staff_remove`). Moved out of
 * routes/staff.routes.ts unchanged (behaviour identical); the route keeps the audit row and the HTTP shape.
 */
import { withStore } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { getAccountsBrief } from '../lib/identity-client';
import { inAccessScope, onAccessD1, removeStaffMember } from './platform/access-d1';
import { sendAlert } from './alerts.service';
import logger from '../lib/logger';

interface StaffListUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  lastLoginAt: Date | string | null;
  createdAt: Date | string;
}

/**
 * Memberships plus the people behind them. Before the `access` cutover: the Postgres join, unchanged. After it the
 * membership rows are D1 (no relation to the identity-owned user) and the display facts come from the identity service in
 * ONE batched call; a member the identity no longer knows (erased) is not listed.
 */
export async function listStaffWithUsers(
  storeId: string
): Promise<Array<{ id: string; createdAt: Date; user: StaffListUser }>> {
  if (!(await onAccessD1())) {
    return withStore(storeId, tx =>
      tx.storeStaff.findMany({
        where: { storeId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              status: true,
              lastLoginAt: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      })
    );
  }
  const rows = await inAccessScope(storeId, tx =>
    tx.storeStaff.findMany({
      where: { storeId },
      select: { id: true, userId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    })
  );
  const briefs = new Map(
    (await getAccountsBrief(rows.map((r: { userId: string }) => r.userId))).map(b => [b.id, b])
  );
  const out: Array<{ id: string; createdAt: Date; user: StaffListUser }> = [];
  for (const r of rows as Array<{ id: string; userId: string; createdAt: Date }>) {
    const b = briefs.get(r.userId);
    if (b) out.push({ id: r.id, createdAt: r.createdAt, user: b });
  }
  return out;
}

/** Removes a staff member's membership (and the invitations and merchant MCP keys that could bring them back). Returns the membership id for the audit row. */
export async function removeStaffFromStore(
  storeId: string,
  userId: string
): Promise<{ membershipId: string }> {
  const d1Access = await onAccessD1();
  const found = d1Access
    ? await inAccessScope(storeId, tx =>
        tx.storeStaff.findUnique({
          where: { userId_storeId: { userId, storeId } },
          select: { id: true },
        })
      )
    : await withStore(storeId, tx =>
        tx.storeStaff.findUnique({
          where: { userId_storeId: { userId, storeId } },
          include: { user: { select: { email: true } } },
        })
      );

  if (!found) {
    throw new AppError(404, 'NOT_FOUND', 'Staff member not found in this store.');
  }
  const membership = { id: (found as { id: string }).id };
  // The address whose pending invitations die with the membership: from the profile row before the cutover, from the
  // identity service after it (an erased account has no address left, and no live invitation can name it).
  const memberEmail = d1Access
    ? ((await getAccountsBrief([userId]))[0]?.email ?? null)
    : (found as unknown as { user: { email: string } }).user.email;

  // Ruling PASSKEY-11: this ends the person's access to THIS store and nothing else. Sessions and
  // passkeys are per user, not per store; access is the membership row, re-checked on every request,
  // so deleting it is immediate. Signing them out (or touching their passkeys) here would let store A's
  // owner kick the same person out of store B or out of a store they own.
  if (d1Access) {
    // One atomic batch: the membership and every pending invitation that could bring the member back (Ruling ID-13).
    if (!memberEmail)
      logger.warn(
        { storeId, userId },
        'staff removal: no address for the member, invites matched by user only'
      );
    await removeStaffMember(storeId, userId, memberEmail);
  } else {
    await inAccessScope(storeId, tx =>
      tx.storeStaff.delete({
        where: { userId_storeId: { userId, storeId } },
      })
    );

    // Any invitation to this address that is still pending dies with the membership (Ruling ID-13): a removed member
    // cannot come back through an old link.
    await inAccessScope(storeId, tx =>
      tx.staffInvite.updateMany({
        where: { storeId, email: memberEmail!.toLowerCase(), status: 'pending' },
        data: { status: 'expired', decidedAt: new Date() },
      })
    );
  }

  // Their merchant-MCP keys die with the membership. verifyMerchantKey already
  // refuses a non-member on every call; revoking here also stops a key
  // resurrecting if the same person is later re-added to this store.
  // Access has already ended (membership gone, atomically). The key rows are a Postgres write: after the cutover a failure
  // is retried and, if it persists, raised as a P1 (never swallowed) so a later re-add cannot resurrect a live key.
  const revokeKeys = () =>
    withStore(storeId, tx =>
      tx.merchantApiKey.updateMany({
        where: { storeId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    );
  if (!d1Access) await revokeKeys();
  else {
    let lastErr: unknown;
    let revoked = false;
    for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
      try {
        await revokeKeys();
        revoked = true;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!revoked) {
      logger.error({ err: lastErr, storeId, userId }, 'staff removal: merchant key revoke failed');
      void sendAlert({
        level: 'p1',
        source: 'staff.remove.key_revoke_failed',
        title: 'Removed staff member still has live merchant MCP keys',
        body: 'Membership was removed but the key revoke failed 3 times. Revoke the keys before the user is ever re-added to this store.',
        context: { storeId, userId },
      }).catch(() => undefined);
    }
  }

  return { membershipId: membership.id };
}
