/**
 * Staff account management routes.
 *
 * Store owners (store_admin) and super_admins can add / remove staff members
 * from a store.  Staff themselves can only read their own membership.
 *
 * Routes:
 *   GET    /stores/:storeId/staff            — list staff for a store
 *   POST   /stores/:storeId/staff            — add a staff user (invite by email)
 *   DELETE /stores/:storeId/staff/:userId    — remove a staff member
 */
import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod/v3';
import bcrypt from 'bcryptjs';
import { withStore, withUser, UserRole } from '@ebda/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import { ensureAdminUser, findUserIdByEmail } from '../lib/definer';
import { assertWithinLimit } from '../services/plan-limit.service';
import { AuthService, RESET_TOKEN_TTL_MINUTES, storeAppOrigin } from '../services/auth.service';
import { sendStaffInviteEmail } from '../services/platform-mailer';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

const inviteStaffSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  /** Optional initial password; if omitted, a random one is generated and must be reset. */
  password: z.string().min(8).max(128).optional(),
});

// ─── List staff members ────────────────────────────────────────────────────

router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('staff_accounts'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const members = await withStore(storeId, tx =>
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

      res.json({
        success: true,
        data: {
          staff: members.map(m => ({
            membershipId: m.id,
            ...m.user,
            // membership createdAt (when added as staff) wins over the user's createdAt
            createdAt: m.createdAt,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Add / invite a staff member ──────────────────────────────────────────

router.post(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('staff_accounts'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const input = inviteStaffSchema.parse(req.body);

      // Plan ceiling (SP5): one more seat must fit the store's maxStaff.
      await assertWithinLimit(storeId, 'maxStaff');

      // The admin namespace (users.store_id NULL) is not visible from a store's
      // scope, so find-or-create goes through the `ebda_admin_user_ensure`
      // definer: it returns the existing account untouched, or creates a staff
      // account. The password is only hashed when no account exists yet.
      const exists = await findUserIdByEmail(input.email, null, { includeDeleted: true });
      let passwordHash = '';
      if (!exists) {
        // Cryptographically-strong fallback password (never Math.random for secrets).
        const password = input.password ?? randomBytes(18).toString('base64url') + 'A1!';
        passwordHash = await bcrypt.hash(password, 12);
      }
      const staffUser = await ensureAdminUser({
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        role: UserRole.staff,
      });

      // User exists — must already be a staff or store_admin role
      if (staffUser.role === UserRole.customer || staffUser.role === UserRole.super_admin) {
        throw new AppError(
          409,
          'ROLE_CONFLICT',
          'This email belongs to a customer or platform admin account and cannot be used for store staff.'
        );
      }

      // Prevent double-add
      const existing = await withStore(storeId, tx =>
        tx.storeStaff.findUnique({
          where: { userId_storeId: { userId: staffUser.id, storeId } },
        })
      );
      if (existing) {
        throw new AppError(
          409,
          'ALREADY_MEMBER',
          'This user is already a staff member of this store.'
        );
      }

      const membership = await withStore(storeId, tx =>
        tx.storeStaff.create({
          data: { storeId, userId: staffUser.id },
        })
      );

      // Consent/notice (lens-2, 2026-09-22 audit): every staff add now mails the
      // invitee, instead of leaving it to the owner to tell them out of band. A
      // brand-new account gets a real set-password link (closes the "nobody but
      // the owner knows the password, and there's no invite-token flow to
      // discover it" gap); an account that already exists elsewhere just gets a
      // short notice, since its password already works.
      //
      // Deferred to AFTER this request's tenant transaction commits (not a bare
      // `cfWaitUntil`): for a brand-new account, `staffUser` was just inserted
      // by `ensureAdminUser` inside this same still-open transaction. Issuing
      // its invite token from a detached promise before that commit lands a
      // `refreshToken.create` against a `userId` the rest of the database can't
      // see yet — a foreign-key violation (reproduced locally against a real
      // Postgres before this fix). `deferAfterTenantCommit` is exactly the
      // ordering primitive `after-tenant-commit.ts` exists for.
      //
      // `connections: 2`: this task opens up to two SEQUENTIAL nested
      // transactions of its own (the language read below, then — for a
      // brand-new account — `issueStaffInviteToken`'s `withUser`), the same
      // nested-transaction shape `r2-cleanup.service.ts` already declares
      // `connections: 2` for; the global deferred-work cap needs both counted.
      const staffName = `${staffUser.firstName} ${staffUser.lastName}`.trim() || staffUser.email;
      const storeName = req.store?.name ?? 'your store';
      void deferAfterTenantCommit(
        'staff.invite.notify',
        async () => {
          const existingUser = await withUser(staffUser.id, tx =>
            tx.user.findUnique({ where: { id: staffUser.id }, select: { language: true } })
          );
          const language = (existingUser?.language as 'en' | 'ar' | undefined) ?? undefined;
          const setPasswordUrl = staffUser.created
            ? `${storeAppOrigin()}/reset-password?token=${await AuthService.issueStaffInviteToken(staffUser.id)}`
            : null;
          await sendStaffInviteEmail(
            {
              email: staffUser.email,
              name: staffName,
              storeName,
              loginUrl: `${storeAppOrigin()}/login`,
              setPasswordUrl,
              expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
            },
            language
          );
        },
        { connections: 2 }
      ).catch(err => logger.error({ err, staffUserId: staffUser.id }, 'staff-invite mail failed'));

      await auditLog({
        action: 'staff.added',
        userId: req.user!.userId,
        resourceType: 'store_staff',
        resourceId: membership.id,
        details: {
          storeId,
          staffUserId: staffUser.id,
          staffEmail: staffUser.email,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(201).json({
        success: true,
        data: {
          membershipId: membership.id,
          user: {
            id: staffUser.id,
            email: staffUser.email,
            firstName: staffUser.firstName,
            lastName: staffUser.lastName,
            role: staffUser.role,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Remove a staff member ────────────────────────────────────────────────

router.delete(
  '/:userId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('staff_accounts'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, userId } = req.params;

      const membership = await withStore(storeId, tx =>
        tx.storeStaff.findUnique({
          where: { userId_storeId: { userId, storeId } },
        })
      );

      if (!membership) {
        throw new AppError(404, 'NOT_FOUND', 'Staff member not found in this store.');
      }

      // Ruling PASSKEY-11: this ends the person's access to THIS store and nothing else. Sessions and
      // passkeys are per user, not per store; access is the membership row, re-checked on every request,
      // so deleting it is immediate. Signing them out (or touching their passkeys) here would let store A's
      // owner kick the same person out of store B or out of a store they own.
      await withStore(storeId, tx =>
        tx.storeStaff.delete({
          where: { userId_storeId: { userId, storeId } },
        })
      );

      // Their merchant-MCP keys die with the membership. verifyMerchantKey already
      // refuses a non-member on every call; revoking here also stops a key
      // resurrecting if the same person is later re-added to this store.
      await withStore(storeId, tx =>
        tx.merchantApiKey.updateMany({
          where: { storeId, userId, revokedAt: null },
          data: { revokedAt: new Date() },
        })
      );

      await auditLog({
        action: 'staff.removed',
        userId: req.user!.userId,
        resourceType: 'store_staff',
        resourceId: membership.id,
        details: { storeId, staffUserId: userId },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({ success: true, data: { message: 'Staff member removed.' } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
