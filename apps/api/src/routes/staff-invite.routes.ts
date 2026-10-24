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
import { z } from 'zod';
import { withStore } from '@ebda/database';
import { authenticate, rejectImpersonated } from '../middleware/auth';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import { ownedStoreIds } from '../lib/definer';
import { getAccountState, setAccountRole } from '../lib/identity-client';
import { verifyStaffInviteToken } from '../lib/staff-invite-token';
import { assertWithinLimit } from '../services/plan-limit.service';

const router = Router();

router.post(
  '/accept',
  authenticate,
  rejectImpersonated,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = z.object({ token: z.string().min(20).max(2000) }).parse(req.body);
      const claims = verifyStaffInviteToken(token);
      const userId = req.user!.userId;

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
      const store = await withStore(storeId, tx =>
        tx.store.findUnique({ where: { id: storeId }, select: { id: true, deletedAt: true } })
      );
      if (!store || store.deletedAt) {
        throw new AppError(
          400,
          'INVITE_INVALID',
          'This invitation link is invalid or has expired.'
        );
      }

      // Consume the invitation and create the membership in ONE transaction. The link works only while its row is pending,
      // unexpired and addressed to this store and address; a revoked, superseded, expired, already-used or post-removal link
      // finds no pending row and creates nothing. The one repeat allowed is the account that already accepted it, while its
      // membership still stands (finishing a half-done role switch).
      let alreadyMember = false;
      let seatCheck: unknown = null;
      try {
        await assertWithinLimit(storeId, 'maxStaff');
      } catch (e) {
        seatCheck = e;
      }
      await withStore(storeId, async tx => {
        const membership = await tx.storeStaff.findUnique({
          where: { userId_storeId: { userId, storeId } },
        });
        // A full store only blocks a NEW member; an existing one may still finish a role switch.
        if (seatCheck && !membership) throw seatCheck;
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
        if (consumed.count === 1) {
          if (!membership) await tx.storeStaff.create({ data: { storeId, userId } });
          else alreadyMember = true;
          return;
        }
        const prior = await tx.staffInvite.findFirst({
          where: { id: claims.jti, storeId, status: 'accepted', acceptedBy: userId },
          select: { id: true },
        });
        if (!prior || !membership) {
          throw new AppError(
            400,
            'INVITE_INVALID',
            'This invitation link is invalid, used or revoked.'
          );
        }
        alreadyMember = true;
      });

      // Idempotent on purpose: if a previous attempt added the membership but failed here, a retry finishes the switch.
      let requiresSignIn = false;
      if (acc.role === 'store_admin') {
        await setAccountRole(userId, 'staff', 'staff-invite-accepted');
        requiresSignIn = true;
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
    }
  }
);

export default router;
