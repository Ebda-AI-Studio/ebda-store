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
import { z } from 'zod/v3';
import { withStore, withUser, UserRole } from '@ebda/database';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { isStaffRoleConflict, STAFF_ROLE_CONFLICT_MESSAGE } from '../lib/staff-role-conflict';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import { ensureAdminUser, findUserIdByEmail } from '../lib/definer';
import { getAccountState, inviteIdentity } from '../lib/identity-client';
import { STAFF_INVITE_TTL_MINUTES, signStaffInviteToken } from '../lib/staff-invite-token';
import { assertWithinLimit } from '../services/plan-limit.service';
import { getEntitlements } from '../services/plan-entitlements';
import { addStaffWithinCap, inAccessScope, onAccessD1 } from '../services/platform/access-d1';
import { RESET_TOKEN_TTL_MINUTES, storeAppOrigin } from '../services/auth.service';
import { sendStaffInviteEmail } from '../services/platform-mailer';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { listStaffWithUsers, removeStaffFromStore } from '../services/staff-members.service';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

/**
 * Add a membership on D1 under the plan seat cap, atomically (access-d1.ts). `null` from the insert means: already a member
 * (409), no such store (404) or the cap is full (the plan-limit guard then raises the standard 402 with the upsell).
 */
async function addStaffMemberD1(storeId: string, userId: string): Promise<{ id: string }> {
  const e = await getEntitlements(storeId);
  if (!e) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found'); // never "unlimited" for an unknown store
  const raw = e.limits.maxStaff;
  const cap = typeof raw === 'number' ? raw : null; // null = unlimited
  const id = await addStaffWithinCap(storeId, userId, cap);
  if (id) return { id };
  const again = await inAccessScope(storeId, tx =>
    tx.storeStaff.findUnique({ where: { userId_storeId: { userId, storeId } } })
  );
  if (again) {
    throw new AppError(409, 'ALREADY_MEMBER', 'This user is already a staff member of this store.');
  }
  await assertWithinLimit(storeId, 'maxStaff'); // throws the 402 when the seats are full
  throw new AppError(409, 'STAFF_SEAT_CONFLICT', 'Could not add the staff member, try again.');
}
function assertInvitableRole(role: string): void {
  if (isStaffRoleConflict(role)) {
    throw new AppError(409, 'ROLE_CONFLICT', STAFF_ROLE_CONFLICT_MESSAGE);
  }
}

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

      const members = await listStaffWithUsers(storeId);

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
  requireMfaEnrolled,
  // BE:S-2 (Ruling FP-3): adding a staff member grants durable access; not from an impersonated session.
  rejectImpersonated,
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
      // After the `access` cutover the identity service is the only place that knows an address: it creates the account or
      // answers that it exists (then the invitation + ACCEPT step below), so the Postgres lookup/creation is skipped.
      const d1Access = await onAccessD1();
      const exists = d1Access
        ? null
        : await findUserIdByEmail(input.email, null, { includeDeleted: true });
      const storeNameForInvite = req.store?.name ?? 'your store';
      const requestedId = crypto.randomUUID();
      // ONE rule for an address that already has an account (Ruling ID-13): a store is never attached to someone else's
      // account silently. A brand-new address gets a fresh identity and an emailed code. An address whose account is
      // unverified, mid-signup, has no Store profile yet, or is a merchant (store_admin) gets an invitation e-mail with an
      // explicit ACCEPT step (POST /staff-invites/accept, signed in as that very address). Only an already-verified staff
      // account is added at once (it already is staff; the notice mail below tells them).
      let pendingAcceptance = false;
      let staffUser: Awaited<ReturnType<typeof ensureAdminUser>> | undefined;
      if (!exists) {
        const invited = await inviteIdentity({
          id: requestedId,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          role: 'staff',
          language: 'ar',
          storeName: storeNameForInvite,
        });
        if (invited.created) {
          // The profile row must carry the id THIS request generated: an identity that answers with another id is someone
          // else's account and is never bound (cross-tenant takeover).
          if (invited.id !== requestedId) {
            throw new AppError(409, 'ROLE_CONFLICT', 'This email cannot be invited as staff.');
          }
          const createShadow = () =>
            withUser(invited.id, tx =>
              tx.user.create({
                data: {
                  id: invited.id,
                  storeId: null,
                  email: input.email,
                  passwordHash: '!pending',
                  firstName: input.firstName,
                  lastName: input.lastName,
                  role: UserRole.staff,
                  emailVerified: false,
                  language: 'ar',
                },
              })
            );
          // The Postgres profile row is a shadow of the identity (never authoritative). After the cutover it must not
          // block the invite when Postgres is down; the identity service already holds the account.
          if (d1Access)
            await createShadow().catch(err =>
              logger.warn({ err: (err as Error).message }, 'staff shadow profile not written')
            );
          else await createShadow();
          staffUser = {
            id: invited.id,
            created: true,
            role: 'staff',
            status: 'active',
            email: input.email,
            firstName: input.firstName,
            lastName: input.lastName,
          };
        } else {
          assertInvitableRole(invited.role);
          pendingAcceptance = true;
        }
      } else {
        const acc = await getAccountState(exists);
        if (!acc) {
          throw new AppError(409, 'ROLE_CONFLICT', 'This account cannot be invited as staff.');
        }
        assertInvitableRole(acc.role);
        if (!acc.emailVerified || acc.role !== 'staff') {
          pendingAcceptance = true;
        } else {
          staffUser = await ensureAdminUser({
            email: input.email,
            passwordHash: '',
            firstName: input.firstName,
            lastName: input.lastName,
            role: UserRole.staff,
          });
          if (staffUser.id !== exists) {
            throw new AppError(409, 'ROLE_CONFLICT', 'This email cannot be invited as staff.');
          }
        }
      }

      if (pendingAcceptance || !staffUser) {
        // The link is honoured only while this pending row exists: any earlier pending invite to the same address is
        // superseded, and the row is consumed by the accept in the same transaction that creates the membership.
        const inviteEmail = input.email.toLowerCase();
        const inviteId = crypto.randomUUID();
        await inAccessScope(storeId, async tx => {
          await tx.staffInvite.updateMany({
            where: { storeId, email: inviteEmail, status: 'pending' },
            data: { status: 'revoked', decidedAt: new Date() },
          });
          await tx.staffInvite.create({
            data: {
              id: inviteId,
              storeId,
              email: inviteEmail,
              role: 'staff',
              invitedBy: req.user!.userId,
              expiresAt: new Date(Date.now() + STAFF_INVITE_TTL_MINUTES * 60_000),
            },
          });
        });
        const token = signStaffInviteToken({ email: inviteEmail, storeId, jti: inviteId });
        await sendStaffInviteEmail(
          {
            email: input.email,
            name: `${input.firstName} ${input.lastName}`.trim() || input.email,
            storeName: storeNameForInvite,
            loginUrl: `${storeAppOrigin()}/login`,
            setPasswordUrl: null,
            acceptUrl: `${storeAppOrigin()}/accept-invite#token=${token}`,
            expiresInMinutes: STAFF_INVITE_TTL_MINUTES,
          },
          'ar'
        ).catch(err => logger.error({ err }, 'staff-invite acceptance mail failed'));
        await auditLog({
          action: 'staff.invited',
          userId: req.user!.userId,
          resourceType: 'store',
          resourceId: storeId,
          details: { storeId, staffEmail: input.email },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        res.status(202).json({ success: true, data: { status: 'invitation_sent' } });
        return;
      }

      // User exists — must already be a staff or store_admin role
      if (staffUser.role === UserRole.customer || staffUser.role === UserRole.super_admin) {
        throw new AppError(409, 'ROLE_CONFLICT', STAFF_ROLE_CONFLICT_MESSAGE);
      }

      // Prevent double-add
      const existing = await inAccessScope(storeId, tx =>
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

      // The seat check and the insert are ONE atomic step (store row locked FOR UPDATE), so two simultaneous adds or
      // accepts cannot both take the last seat.
      const membership = d1Access
        ? await addStaffMemberD1(storeId, staffUser.id)
        : await withStore(storeId, async tx => {
            await assertWithinLimit(storeId, 'maxStaff', { tx });
            return tx.storeStaff.create({
              data: { storeId, userId: staffUser.id },
            });
          });

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
      const storeName = storeNameForInvite;
      void deferAfterTenantCommit(
        'staff.invite.notify',
        async () => {
          // Language is a nicety: a failed profile read (Postgres down after the cutover) falls back to the default.
          const existingUser = await withUser(staffUser.id, tx =>
            tx.user.findUnique({ where: { id: staffUser.id }, select: { language: true } })
          ).catch(() => null);
          const language = (existingUser?.language as 'en' | 'ar' | undefined) ?? undefined;
          // A brand-new account already received its invitation (with the set-password code) from the identity service.
          if (staffUser.created) return;
          const setPasswordUrl = null;
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
          // BE:S-20: echo what the OWNER typed, never fields read from a pre-existing account (its stored name is that
          // person's data, and showing it confirmed whose account the address belongs to).
          user: {
            id: staffUser.id,
            email: input.email,
            firstName: input.firstName,
            lastName: input.lastName,
            role: staffUser.role,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Pending invitations: list and revoke (Ruling ID-13) ──────────────────

router.get(
  '/invites',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('staff_accounts'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const invites = await inAccessScope(storeId, tx =>
        tx.staffInvite.findMany({
          where: { storeId, status: 'pending', expiresAt: { gt: new Date() } },
          select: { id: true, email: true, createdAt: true, expiresAt: true },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
      );
      res.json({ success: true, data: { invites } });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/invites/:inviteId',
  authenticate,
  requireMfaEnrolled, // BE:S-11
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('staff_accounts'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, inviteId } = req.params;
      const { count } = await inAccessScope(storeId, tx =>
        tx.staffInvite.updateMany({
          where: { id: inviteId, storeId, status: 'pending' },
          data: { status: 'revoked', decidedAt: new Date() },
        })
      );
      if (count === 0) throw new AppError(404, 'NOT_FOUND', 'No pending invitation with this id.');
      await auditLog({
        action: 'staff.invite_revoked',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: storeId,
        details: { storeId, inviteId },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { revoked: true } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Remove a staff member ────────────────────────────────────────────────

router.delete(
  '/:userId',
  authenticate,
  requireMfaEnrolled, // BE:S-11
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('staff_accounts'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, userId } = req.params;

      const { membershipId } = await removeStaffFromStore(storeId, userId);

      await auditLog({
        action: 'staff.removed',
        userId: req.user!.userId,
        resourceType: 'store_staff',
        resourceId: membershipId,
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
