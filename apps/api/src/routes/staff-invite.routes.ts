/**
 * Accepting a staff invitation (Ruling ID-13). The invitee signs in AS THE INVITED ADDRESS, then redeems the emailed token.
 * Nothing about the account changes before this call. Rules, in order:
 *   - the token is valid and for this store; the account is active, its e-mail VERIFIED and equal to the token's address;
 *   - a platform admin or customer account never becomes staff;
 *   - an account that OWNS a store is refused (OWNS_STORE): an owner is not downgraded. A merchant without a store
 *     (pending signup, or none yet) becomes a staff account: its sign-in role is switched in the identity service, which
 *     ends its sessions, so the response asks for a fresh sign-in;
 *   - the store's plan seat limit applies; accepting twice is harmless.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { withStore } from '@ebda/database';
import { authenticate, rejectImpersonated } from '../middleware/auth';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import { ownedStoreIds } from '../lib/definer';
import { storesForUser } from '../lib/identity-directory';
import { redis } from '../services/redis.service';
import { getAccountState, setAccountRole } from '../lib/identity-client';
import { verifyStaffInviteToken } from '../lib/staff-invite-token';
import { assertWithinLimit } from '../services/plan-limit.service';
import { getEntitlements } from '../services/plan-entitlements';
import {
  acceptInviteWithinCap,
  gateRead,
  inAccessScope,
  onAccessD1,
} from '../services/platform/access-d1';
import { featureService } from '../services/feature.service';
import logger from '../lib/logger';

const router = Router();

router.post(
  '/accept',
  authenticate,
  rejectImpersonated,
  async (req: Request, res: Response, next: NextFunction) => {
    let lockName: string | null = null;
    try {
      const { token } = z.object({ token: z.string().min(20).max(2000) }).parse(req.body);
      const claims = verifyStaffInviteToken(token);
      const userId = req.user!.userId;

      // One accept at a time per account: two overlapping accepts (two links, or a double click) would otherwise race on the
      // identity role switch and its rollback. Redis down = best effort (acquireLock allows it); the compare-and-set
      // rollback below keeps the final role and memberships consistent even then.
      lockName = `staff-accept:${userId}`;
      if (!(await redis.acquireLock(lockName, 60))) {
        lockName = null;
        throw new AppError(
          409,
          'ACCEPT_IN_PROGRESS',
          'Another invitation is being accepted on this account. Try again in a moment.'
        );
      }

      const acc = await getAccountState(userId);
      if (!acc || acc.status !== 'active') {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is not active');
      }
      if (!acc.emailVerified) {
        throw new AppError(
          403,
          'EMAIL_NOT_VERIFIED',
          'Verify your email address first, then open the invitation again.'
        );
      }
      if (acc.email.toLowerCase() !== claims.email) {
        throw new AppError(
          403,
          'INVITE_EMAIL_MISMATCH',
          'This invitation was sent to a different email address.'
        );
      }
      if (acc.role === 'customer' || acc.role === 'super_admin') {
        throw new AppError(409, 'ROLE_CONFLICT', 'This account cannot be used for store staff.');
      }
      if (acc.role === 'store_admin' && (await ownedStoreIds(userId)).length > 0) {
        throw new AppError(
          409,
          'OWNS_STORE',
          'This account owns a store, so it cannot become a staff account. Ask the store to invite a different email address.'
        );
      }

      const { storeId } = claims;
      // A store whose staff feature is off (plan downgrade, toggle) takes no new members through an old link.
      if (!(await featureService.isFeatureEnabled(storeId, 'staff_accounts'))) {
        throw new AppError(
          403,
          'FEATURE_DISABLED',
          'This store does not use staff accounts at the moment.'
        );
      }
      const d1Access = await onAccessD1();
      // After the `access` cutover the directory row (D1 `stores`) answers; a soft-deleted store is marked inactive there.
      const store = d1Access
        ? await gateRead(storeId, null).then(g =>
            g
              ? { id: g.store.id, deletedAt: g.store.status === 'inactive' ? new Date() : null }
              : null
          )
        : await withStore(storeId, tx =>
            tx.store.findUnique({ where: { id: storeId }, select: { id: true, deletedAt: true } })
          );
      const invalid = () =>
        new AppError(400, 'INVITE_INVALID', 'This invitation link is invalid, used or revoked.');
      if (!store || store.deletedAt) throw invalid();

      // Read-only pre-validation, BEFORE anything about the account changes. The link must be pending and unexpired, or be
      // this very account's earlier accept whose membership still stands (finishing a half-done role switch).
      const pre = await inAccessScope(storeId, async tx => {
        const row = await tx.staffInvite.findFirst({
          where: { id: claims.jti, storeId, email: claims.email },
          select: { status: true, expiresAt: true, acceptedBy: true },
        });
        const member = await tx.storeStaff.findUnique({
          where: { userId_storeId: { userId, storeId } },
        });
        return { row, member };
      });
      const pending = pre.row?.status === 'pending' && pre.row.expiresAt > new Date();
      const repeat =
        pre.row?.status === 'accepted' && pre.row.acceptedBy === userId && !!pre.member;
      if (!pending && !repeat) throw invalid();
      if (pending && !pre.member) await assertWithinLimit(storeId, 'maxStaff'); // early, cheap refusal; the locked check below decides

      // Switch the sign-in role FIRST (it ends the account's sessions, so it can no longer create a store), then re-check
      // ownership: a store created in the window between the first check and now is detected here and the switch is undone,
      // so the account is never left as staff while owning a store.
      let requiresSignIn = false;
      const undoRoleSwitch = async () => {
        // Compare-and-set, and only while the account holds NO staff membership: another accept for the same account may
        // have succeeded meanwhile, and then 'staff' is the right final role. (An owned store does not block the undo: that is
        // exactly the OWNS_STORE case, where the account must go back to store_admin.)
        const staffNow = (await storesForUser(userId)).filter(x => x.role === 'staff');
        if (staffNow.length > 0) return;
        await setAccountRole(userId, 'store_admin', 'staff-invite-rolled-back', 'staff').catch(e =>
          logger.error(
            { err: e, userId },
            '[staff-invite] could not restore store_admin after a failed accept'
          )
        );
      };
      if (acc.role === 'store_admin') {
        await setAccountRole(userId, 'staff', 'staff-invite-accepted');
        requiresSignIn = true;
        if ((await ownedStoreIds(userId)).length > 0) {
          await undoRoleSwitch();
          throw new AppError(
            409,
            'OWNS_STORE',
            'A store was created on this account while accepting, so it stays a store owner. Ask the store to invite a different email address.'
          );
        }
      }

      // Consume the invitation and create the membership in ONE transaction, with the seat check locked on the store row.
      let alreadyMember = false;
      try {
        if (d1Access) {
          // D1 has no interactive transaction: the insert-under-cap and the consume are ONE atomic batch (access-d1.ts).
          const e = await getEntitlements(storeId);
          if (!e) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
          const cap = typeof e.limits.maxStaff === 'number' ? e.limits.maxStaff : null;
          const r = await acceptInviteWithinCap({
            inviteId: claims.jti,
            storeId,
            email: claims.email,
            userId,
            cap,
          });
          if (r.consumed) {
            alreadyMember = !r.added;
          } else {
            const [prior, member] = await inAccessScope(storeId, async tx => [
              await tx.staffInvite.findFirst({
                where: { id: claims.jti, storeId, status: 'accepted', acceptedBy: userId },
                select: { id: true },
              }),
              await tx.storeStaff.findUnique({ where: { userId_storeId: { userId, storeId } } }),
            ]);
            if (prior && member) alreadyMember = true;
            else {
              if (!member && pending) await assertWithinLimit(storeId, 'maxStaff'); // the full-seats 402
              throw invalid();
            }
          }
        } else
          await withStore(storeId, async tx => {
            const consumed = await tx.staffInvite.updateMany({
              where: {
                id: claims.jti,
                storeId,
                email: claims.email,
                status: 'pending',
                expiresAt: { gt: new Date() },
              },
              data: { status: 'accepted', acceptedBy: userId, decidedAt: new Date() },
            });
            const membership = await tx.storeStaff.findUnique({
              where: { userId_storeId: { userId, storeId } },
            });
            if (consumed.count === 1) {
              if (membership) {
                alreadyMember = true;
                return;
              }
              await assertWithinLimit(storeId, 'maxStaff', { tx });
              await tx.storeStaff.create({ data: { storeId, userId } });
              return;
            }
            const prior = await tx.staffInvite.findFirst({
              where: { id: claims.jti, storeId, status: 'accepted', acceptedBy: userId },
              select: { id: true },
            });
            if (!prior || !membership) throw invalid();
            alreadyMember = true;
          });
      } catch (e) {
        if (requiresSignIn) await undoRoleSwitch();
        throw e;
      }

      await auditLog({
        action: 'staff.invite_accepted',
        userId,
        resourceType: 'store',
        resourceId: storeId,
        details: { storeId, alreadyMember, roleSwitched: requiresSignIn },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { storeId, requiresSignIn } });
    } catch (err) {
      next(err);
    } finally {
      if (lockName) await redis.releaseLock(lockName).catch(() => undefined);
    }
  }
);

export default router;
