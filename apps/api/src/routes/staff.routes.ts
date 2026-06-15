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
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma, withRlsBypass, UserRole } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const members = await withRlsBypass(tx =>
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const input = inviteStaffSchema.parse(req.body);

      // Look for an existing staff/admin user with this email (global namespace)
      let staffUser = await withRlsBypass(tx =>
        tx.user.findFirst({
          where: {
            email: input.email,
            storeId: null, // admin-namespace users have NULL storeId
          },
        })
      );

      if (staffUser) {
        // User exists — must already be a staff or store_admin role
        if (staffUser.role === UserRole.customer || staffUser.role === UserRole.super_admin) {
          throw new AppError(
            409,
            'ROLE_CONFLICT',
            'This email belongs to a customer or platform admin account and cannot be used for store staff.'
          );
        }
      } else {
        // Create a new staff user in the global (storeId=null) namespace
        // Cryptographically-strong fallback password (never Math.random for secrets).
        const password = input.password ?? randomBytes(18).toString('base64url') + 'A1!';
        const passwordHash = await bcrypt.hash(password, 12);

        staffUser = await withRlsBypass(tx =>
          tx.user.create({
            data: {
              email: input.email,
              firstName: input.firstName,
              lastName: input.lastName,
              passwordHash,
              role: UserRole.staff,
              storeId: null, // staff live in the global namespace
            },
          })
        );
      }

      // Prevent double-add
      const existing = await withRlsBypass(tx =>
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

      const membership = await withRlsBypass(tx =>
        tx.storeStaff.create({
          data: { storeId, userId: staffUser.id },
        })
      );

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, userId } = req.params;

      const membership = await withRlsBypass(tx =>
        tx.storeStaff.findUnique({
          where: { userId_storeId: { userId, storeId } },
        })
      );

      if (!membership) {
        throw new AppError(404, 'NOT_FOUND', 'Staff member not found in this store.');
      }

      await withRlsBypass(tx =>
        tx.storeStaff.delete({
          where: { userId_storeId: { userId, storeId } },
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
