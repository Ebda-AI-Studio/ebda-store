import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { AuthService } from '../services/auth.service';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireRole } from '../middleware/rbac';
import { bustStoreCaches } from '../services/store.service';
import { featureService } from '../services/feature.service';
import { invalidateCached } from '../lib/public-cache';
import { hasAnyRateConfigured } from '../lib/ai-pricing';
import { ProvisioningService } from '../services/provisioning.service';
import { auditLog } from '../middleware/security';
import { config } from '../config';
import logger from '../lib/logger';
import { inngest } from '../lib/inngest/client';
import { streamXlsxResponse } from '../lib/exports/xlsx';
import { emailQueue } from '../services/email-queue.service';
import { maskEmail } from '../lib/pii-mask';
import {
  prisma,
  withRlsBypass,
  Prisma,
  UserRole,
  ProductStatus,
  OrderStatus,
  OrderPaymentStatus,
} from '@force/database';
import { csvField } from '@force/shared';

const router = Router();

// Admin routes are authenticated. The default authorization is super_admin
// (enforced via `requireRole('super_admin')` on every write/management
// route), but a few read endpoints — list-stores, dashboard, and the
// per-store fetch — are also available to store_admins so the same admin
// frontend can serve a tenant. Those routes apply ownership filtering at
// the service layer (see ownerId scoping below).
router.use(authenticate);

// MFA enrollment gate: super_admin users MUST have MFA enabled to access
// any admin route. store_admin and other roles pass through (opt-in).
// Placed after authenticate (req.user is set) but before all route handlers.
// Auth/MFA enroll routes are on a separate router (/auth, /auth/mfa) and
// never reach this middleware, so enrollment is always reachable.
router.use(requireMfaEnrolled);

// Helper: enforce ownership when a store_admin is the caller. Super admins
// pass through unscoped. Returns the userId to filter by, or undefined
// when no scoping is needed.
function ownerScopeForReq(req: Request): string | undefined {
  if (req.user?.role === 'super_admin') return undefined;
  return req.user?.userId;
}

// Pagination helper to bound inputs
function parsePagination(page?: string | unknown, limit?: string | unknown) {
  const p = Math.max(1, parseInt(String(page || '1')) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit || '10')) || 10));
  return { page: p, limit: l, skip: (p - 1) * l };
}

// Validation schemas
const updateStoreAdminSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(100)
    .optional(),
  plan: z.enum(['free', 'starter', 'professional', 'enterprise']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

const provisionStoreSchema = z.object({
  storeName: z.string().min(1).max(100),
  storeSlug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  domain: z.string().optional(),
  plan: z.enum(['free', 'starter', 'professional', 'enterprise']).optional(),
  ownerEmail: z.string().email(),
  ownerName: z.string().min(1),
  ownerPassword: z.string().min(8).optional(),
  settings: z
    .object({
      theme: z.string().optional(),
      currency: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
});

/**
 * POST /admin/stores
 * Provision a new store
 */
router.post(
  '/stores',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = provisionStoreSchema.parse(req.body);

      const result = await ProvisioningService.provisionStore(input);

      await auditLog({
        action: 'store.provisioned',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: result.store.id,
        details: {
          storeName: result.store.name,
          ownerEmail: result.owner.email,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/stores
 * List all stores.
 *   - super_admin: all stores
 *   - store_admin: only stores they own
 *   - staff: only stores they are a member of (via store_staff)
 */
router.get(
  '/stores',
  requireRole(['super_admin', 'store_admin', 'staff']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, status, search } = req.query;
      const { page, limit } = parsePagination(pageStr, limitStr);

      // Staff users are scoped to the stores they are explicitly added to.
      if (req.user?.role === 'staff') {
        const memberships = await withRlsBypass(tx =>
          tx.storeStaff.findMany({
            where: { userId: req.user!.userId },
            select: { storeId: true },
          })
        );
        const storeIds = memberships.map(m => m.storeId);
        if (storeIds.length === 0) {
          res.json({
            success: true,
            data: { stores: [], pagination: { page: 1, limit, total: 0, totalPages: 0 } },
          });
          return;
        }
        // Fetch the actual store rows for these ids
        const stores = await withRlsBypass(tx =>
          tx.store.findMany({
            where: { id: { in: storeIds } },
            select: { id: true, name: true, nameAr: true, logo: true, slug: true, status: true },
          })
        );
        res.json({ success: true, data: { stores } });
        return;
      }

      const result = await ProvisioningService.listStores({
        page,
        limit,
        status: status as string,
        search: search as string,
        // Store admins see only their own stores; super admins see everything.
        ownerId: ownerScopeForReq(req),
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/stores/:id
 * Get store details with stats. Store admins can view their own stores;
 * super admins can view any store.
 */
router.get(
  '/stores/:id',
  requireRole(['super_admin', 'store_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const store = await prisma.store.findUnique({
        where: { id },
        include: {
          owner: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      });

      if (!store) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Store not found' },
        });
        return;
      }

      // Store admins can only view stores they own.
      const ownerScope = ownerScopeForReq(req);
      if (ownerScope && store.ownerId !== ownerScope) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Not authorized to view this store' },
        });
        return;
      }

      const stats = await ProvisioningService.getStoreStats(id);

      res.json({
        success: true,
        data: { store, stats },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /admin/stores/:id/status
 * Update store status
 */
router.patch(
  '/stores/:id/status',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!['active', 'inactive', 'suspended'].includes(status)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_STATUS', message: 'Invalid status' },
        });
        return;
      }

      const store = await ProvisioningService.updateStoreStatus(id, status);

      await auditLog({
        action: 'store.status.updated',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: id,
        details: { newStatus: status },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /admin/stores/:id
 * Update store details
 */
router.put(
  '/stores/:id',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { name, slug, plan, status } = updateStoreAdminSchema.parse(req.body);

      // Pre-read so a slug change can bust the OLD slug's cache key too.
      const before = await prisma.store.findUnique({
        where: { id },
        select: { slug: true },
      });

      const store = await prisma.store.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(slug !== undefined && { slug }),
          ...(plan !== undefined && { plan }),
          ...(status !== undefined && { status }),
        },
        include: {
          owner: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      });

      // Account status / slug / name are NEVER-stale on the storefront
      // (adversarial audit P1-7): bust the public resolve/slug/id caches +
      // fire the storefront revalidate purge on this writer too — it used
      // to write store.status with no invalidation at all.
      //
      // A plan change ALSO changes the resolved feature map that the public
      // payload embeds as `enabledFeatures` — and that map is read from
      // FeatureService's own `features:store:*` cache (300s). Busting only
      // the public keys made the very next public request re-seed them from
      // the STALE feature map (issue 2172), so the feature cache is dropped
      // FIRST, exactly as `featureService.setStorePlan` does.
      if (plan !== undefined) await featureService.invalidateCache(store.id);
      await bustStoreCaches(store.id, store.slug, store.domain);
      if (before?.slug && before.slug !== store.slug) {
        await invalidateCached(`public:store:${before.slug}`);
      }

      await auditLog({
        action: 'store.updated',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: id,
        details: {
          ...(name !== undefined && { name }),
          ...(slug !== undefined && { slug }),
          ...(plan !== undefined && { plan }),
          ...(status !== undefined && { status }),
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/users
 * List platform users (super_admin + store_admin only).
 *
 * Customers are store-scoped (storeId != null) and are managed via the
 * separate GET /admin/customers endpoint. This page is intentionally
 * platform-only: it shows only users with storeId = null (i.e. admin
 * accounts that sit in the global namespace).
 *
 * If a caller passes ?role=customer the storeId=null filter still applies
 * so the result is always empty — customers will never appear here regardless
 * of the role filter passed.
 */
router.get(
  '/users',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, role, search } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      // Platform users have storeId = null. Customers are store-scoped and
      // must be managed via GET /admin/customers, not this endpoint.
      const where: Prisma.UserWhereInput = { storeId: null };
      if (role && role !== 'all') where.role = role as UserRole;
      if (search) {
        where.OR = [
          { email: { contains: search as string, mode: 'insensitive' } },
          { firstName: { contains: search as string, mode: 'insensitive' } },
          { lastName: { contains: search as string, mode: 'insensitive' } },
        ];
      }

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            status: true,
            createdAt: true,
            lastLoginAt: true,
            stores: {
              select: { id: true, name: true },
            },
          },
        }),
        prisma.user.count({ where }),
      ]);

      res.json({
        success: true,
        data: {
          users,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /admin/users
 * Create a new user. Super-admin only. Used by the platform-wide
 * "Invite user" button. Creates a user in the admin namespace
 * (storeId=NULL) so the partial unique `users_admin_email_key` fires
 * if the email already exists as an admin.
 *
 * For store_admin creation: storeId-NULL is correct — the user
 * becomes an owner of zero stores at create-time and is then assigned
 * via the per-store team flow (Store.ownerId update). Customers are
 * NOT createable here; that goes through the public registration
 * route on the storefront.
 */
router.post(
  '/users',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        email: z.string().email().max(255),
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
        password: z.string().min(8).max(255),
        role: z.enum(['super_admin', 'store_admin']),
      });
      const data = schema.parse(req.body);
      const email = data.email.toLowerCase();

      const existing = await prisma.user.findFirst({
        where: { email, storeId: null },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          error: { code: 'EMAIL_TAKEN', message: 'An admin user with this email already exists' },
        });
        return;
      }

      const user = await prisma.user.create({
        data: {
          email,
          firstName: data.firstName,
          lastName: data.lastName,
          passwordHash: await bcrypt.hash(data.password, 12),
          role: data.role as UserRole,
          status: 'active',
          emailVerified: true,
          language: 'en',
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          stores: { select: { id: true, name: true } },
        },
      });

      await auditLog({
        action: 'user.created',
        userId: req.user!.userId,
        resourceType: 'user',
        resourceId: user.id,
        details: { email: user.email, role: user.role },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(201).json({ success: true, data: { user } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/users/:id
 * Get a single user by ID
 */
router.get(
  '/users/:id',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          stores: {
            select: { id: true, name: true, slug: true },
          },
        },
      });

      if (!user) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /admin/users/:id
 * Update a user's profile fields, role, status, and (optionally)
 * password. The password field is the admin-side reset path —
 * super_admin can set a new password for any user without knowing
 * the old one. The old password is required only on the user-self
 * change-password flow (see auth.routes).
 */
router.put(
  '/users/:id',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const schema = z.object({
        firstName: z.string().min(1).max(100).optional(),
        lastName: z.string().min(1).max(100).optional(),
        email: z.string().email().max(255).optional(),
        phone: z.string().max(40).optional().nullable(),
        role: z.enum(['super_admin', 'store_admin', 'customer']).optional(),
        status: z.enum(['active', 'inactive', 'suspended']).optional(),
        password: z.string().min(8).max(255).optional(),
      });
      const data = schema.parse(req.body);

      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found' },
        });
        return;
      }

      // Email collision: if changing email, ensure no other user has it.
      if (data.email && data.email.toLowerCase() !== existing.email.toLowerCase()) {
        const collide = await prisma.user.findFirst({
          where: { email: data.email.toLowerCase(), id: { not: id } },
          select: { id: true },
        });
        if (collide) {
          res.status(409).json({
            success: false,
            error: { code: 'EMAIL_TAKEN', message: 'Another user already has this email' },
          });
          return;
        }
      }

      const updateData: Prisma.UserUpdateInput = {
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email ? data.email.toLowerCase() : undefined,
        phone: data.phone === undefined ? undefined : data.phone,
        role: data.role as UserRole | undefined,
        status: data.status as 'active' | 'inactive' | 'suspended' | undefined,
      };
      if (data.password) {
        // 12 rounds matches the auth service's SALT_ROUNDS.
        updateData.passwordHash = await bcrypt.hash(data.password, 12);
      }

      const user = await prisma.user.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          stores: {
            select: { id: true, name: true, slug: true },
          },
        },
      });

      // Don't include `password` in the audit metadata — only that it
      // changed. Same treatment as auth.service.changePassword.
      const changed = Object.keys(data).filter(k => k !== 'password');
      if (data.password) changed.push('password');

      // Capture from/to for sensitive fields so a forensic reviewer
      // doesn't need raw DB access to reconstruct what changed. Role
      // and status changes are the highest-risk transitions — a role
      // escalation from store_admin → super_admin warrants explicit
      // before/after capture, not just "role changed."
      const fromTo: Record<string, { from: string; to: string }> = {};
      if (data.role !== undefined && data.role !== existing.role) {
        fromTo.role = { from: existing.role, to: data.role };
      }
      if (data.status !== undefined && data.status !== existing.status) {
        fromTo.status = { from: existing.status, to: data.status };
      }
      if (data.email && data.email.toLowerCase() !== existing.email.toLowerCase()) {
        fromTo.email = { from: existing.email, to: data.email.toLowerCase() };
      }

      // S3-1 / S3-2 (2026-09-22 security audit): a status or role change
      // must not leave the user's EXISTING sessions live under the old
      // grant. Without this, a suspended user's open session (and any token
      // it still holds) kept working — the status column was recorded but
      // never enforced — and a demoted role kept authorizing at the old
      // level in every already-issued access token for up to its full
      // 30-minute life. `revokeAllSessions` bumps tokenVersion (which every
      // request checks) and revokes every refresh token, so both cases are
      // now bounded by "next request", not "token expiry".
      //
      // Status: only a transition AWAY FROM 'active' revokes — reactivating
      // a suspended user (inactive/suspended -> active) is not itself a
      // reason to kill sessions, and there are none live to kill in the
      // ordinary case anyway.
      const statusLeftActive =
        fromTo.status !== undefined &&
        fromTo.status.from === 'active' &&
        fromTo.status.to !== 'active';
      const roleChanged = fromTo.role !== undefined;
      if (statusLeftActive || roleChanged) {
        await AuthService.revokeAllSessions(id);
      }

      await auditLog({
        action: 'user.updated',
        userId: req.user!.userId,
        resourceType: 'user',
        resourceId: id,
        details: { changedFields: changed.join(', '), transitions: fromTo },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /admin/users/:id
 * Hard-delete a user. Super-admin only. Refuses to delete the caller's
 * own account, the last super_admin, or a store_admin who still owns
 * stores (the merchant should reassign / archive the stores first to
 * avoid orphaning tenant data).
 */
router.delete(
  '/users/:id',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      if (id === req.user!.userId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'CANNOT_DELETE_SELF',
            message: 'You cannot delete your own account',
          },
        });
        return;
      }

      const target = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          role: true,
          stores: { select: { id: true, name: true } },
        },
      });
      if (!target) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found' },
        });
        return;
      }

      if (target.role === 'super_admin') {
        const supers = await prisma.user.count({ where: { role: 'super_admin' } });
        if (supers <= 1) {
          res.status(400).json({
            success: false,
            error: {
              code: 'LAST_SUPER_ADMIN',
              message: 'Cannot delete the last super_admin',
            },
          });
          return;
        }
      }

      // Store ownership is independent of role — a super_admin (or any user)
      // can be a store's `ownerId`. The guard must key on ownership, NOT on
      // role: gating on `role === 'store_admin'` let an owning super_admin fall
      // through to prisma.user.delete(), which then violated stores_owner_id_fkey
      // and 500'd (Sentry: DELETE /admin/users/:id — FK constraint). Reassign or
      // delete the owned stores first.
      if (target.stores.length > 0) {
        const names = target.stores.map(s => s.name).join(', ');
        res.status(409).json({
          success: false,
          error: {
            code: 'USER_OWNS_STORES',
            message: `User still owns ${target.stores.length} store(s) (${names}). Reassign or delete those first.`,
          },
        });
        return;
      }

      try {
        await prisma.user.delete({ where: { id } });
      } catch (delErr) {
        // Any remaining FK reference (beyond the store-ownership guard above)
        // surfaces as a clean 409 instead of a raw 500.
        if (delErr instanceof Prisma.PrismaClientKnownRequestError && delErr.code === 'P2003') {
          res.status(409).json({
            success: false,
            error: {
              code: 'USER_HAS_REFERENCES',
              message:
                'User cannot be deleted because other records still reference them. Reassign or remove those first.',
            },
          });
          return;
        }
        throw delErr;
      }

      await auditLog({
        action: 'user.deleted',
        userId: req.user!.userId,
        resourceType: 'user',
        resourceId: id,
        details: { email: target.email, role: target.role },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({ success: true, data: { message: 'User deleted' } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/dashboard
 * Get platform-wide dashboard stats
 */
router.get(
  '/dashboard',
  requireRole(['super_admin', 'store_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Store admins see only stats for the stores they own. Super admins
      // get the platform-wide aggregate.
      const ownerScope = ownerScopeForReq(req);
      const storeFilter: Prisma.StoreWhereInput = ownerScope ? { ownerId: ownerScope } : {};
      const orderFilter: Prisma.OrderWhereInput = ownerScope
        ? { store: { ownerId: ownerScope } }
        : {};

      // orders/customers are on RLS-protected tables. The dashboard is a
      // cross-tenant read (super_admin sees all stores; store_admin sees all
      // their own stores, which is still cross-tenant). Wrap order queries in
      // withRlsBypass so no tenant GUC is needed — the where clause provides
      // the application-level scoping via storeFilter/orderFilter.
      const [storeCount, userCount, orderCount, revenueResult, recentStores, recentOrders] =
        await Promise.all([
          prisma.store.count({ where: storeFilter }),
          // User count is platform-wide and only meaningful for super admins.
          // Store admins don't have access to the cross-tenant user table —
          // return 0 so the dashboard widget renders without leaking data.
          ownerScope ? Promise.resolve(0) : prisma.user.count(),
          withRlsBypass((tx: Prisma.TransactionClient) => tx.order.count({ where: orderFilter })),
          withRlsBypass((tx: Prisma.TransactionClient) =>
            tx.order.aggregate({
              where: { ...orderFilter, paymentStatus: 'paid' },
              _sum: { total: true },
            })
          ),
          prisma.store.findMany({
            where: storeFilter,
            take: 5,
            orderBy: { createdAt: 'desc' },
            include: {
              owner: { select: { email: true } },
            },
          }),
          withRlsBypass((tx: Prisma.TransactionClient) =>
            tx.order.findMany({
              where: orderFilter,
              take: 10,
              orderBy: { createdAt: 'desc' },
              include: {
                customer: { select: { email: true, firstName: true, lastName: true } },
                store: { select: { name: true } },
              },
            })
          ),
        ]);

      res.json({
        success: true,
        data: {
          stats: {
            stores: storeCount,
            users: userCount,
            orders: orderCount,
            revenue: revenueResult._sum.total || 0,
          },
          recentStores,
          recentOrders,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/products
 * List all products across all stores
 */
router.get(
  '/products',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, storeId, status, search } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.ProductWhereInput = {};
      if (storeId) where.storeId = storeId as string;
      if (status) where.status = status as ProductStatus;
      if (search) {
        where.OR = [
          { name: { contains: search as string, mode: 'insensitive' } },
          { sku: { contains: search as string, mode: 'insensitive' } },
        ];
      }

      // products is RLS-protected; this is a cross-tenant super-admin list.
      // withRlsBypass allows reading across all stores; the where clause
      // (storeId / status / search) provides application-level scoping.
      const [products, total] = await withRlsBypass((tx: Prisma.TransactionClient) =>
        Promise.all([
          tx.product.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            include: {
              store: { select: { id: true, name: true } },
              images: { take: 1 },
            },
          }),
          tx.product.count({ where }),
        ])
      );

      res.json({
        success: true,
        data: {
          products,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/products/:id
 * Get a single product by ID across all stores
 */
router.get(
  '/products/:id',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      // products is RLS-protected. The tenantContext middleware sets the GUC
      // to req.params.id here, which is a product UUID, not a store UUID —
      // that would cause RLS to filter to zero rows. Use withRlsBypass instead
      // so the lookup works regardless of which store owns the product.
      const product = await withRlsBypass((tx: Prisma.TransactionClient) =>
        tx.product.findUnique({
          where: { id },
          include: {
            store: { select: { id: true, name: true, slug: true } },
            images: { orderBy: { position: 'asc' } },
            categories: {
              include: { category: { select: { id: true, name: true } } },
            },
            variants: {
              include: {
                options: {
                  include: {
                    value: {
                      include: { option: true },
                    },
                  },
                },
              },
            },
          },
        })
      );

      if (!product) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Product not found' },
        });
        return;
      }

      // Transform categories to flat array
      const transformedProduct = {
        ...product,
        categories: product.categories.map(pc => pc.category),
      };

      res.json({
        success: true,
        data: { product: transformedProduct },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/orders
 * List all orders across all stores
 */
router.get(
  '/orders',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, storeId, status, paymentStatus } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.OrderWhereInput = {};
      if (storeId) where.storeId = storeId as string;
      if (status) where.status = status as OrderStatus;
      if (paymentStatus) where.paymentStatus = paymentStatus as OrderPaymentStatus;

      // orders is RLS-protected; this is a cross-tenant super-admin list.
      // withRlsBypass allows reading across all stores; the where clause
      // (storeId / status / paymentStatus) provides application-level scoping.
      const [orders, total] = await withRlsBypass((tx: Prisma.TransactionClient) =>
        Promise.all([
          tx.order.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            include: {
              store: { select: { id: true, name: true } },
              customer: { select: { id: true, email: true, firstName: true, lastName: true } },
              items: { take: 3 },
            },
          }),
          tx.order.count({ where }),
        ])
      );

      res.json({
        success: true,
        data: {
          orders,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/customers
 * List all customers across all stores
 */
router.get(
  '/customers',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, storeId, search } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.CustomerWhereInput = {};
      if (storeId) where.storeId = storeId as string;
      if (search) {
        where.OR = [
          { email: { contains: search as string, mode: 'insensitive' } },
          { firstName: { contains: search as string, mode: 'insensitive' } },
          { lastName: { contains: search as string, mode: 'insensitive' } },
        ];
      }

      // customers is RLS-protected; this is a cross-tenant super-admin list.
      // withRlsBypass allows reading across all stores; the where clause
      // (storeId / search) provides application-level scoping.
      const [customers, total] = await withRlsBypass((tx: Prisma.TransactionClient) =>
        Promise.all([
          tx.customer.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              totalOrders: true,
              totalSpent: true,
              createdAt: true,
              store: { select: { id: true, name: true } },
            },
          }),
          tx.customer.count({ where }),
        ])
      );

      res.json({
        success: true,
        data: {
          customers,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/audit-logs
 * Get audit logs
 */
router.get(
  '/audit-logs',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, action, userId, resourceType } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.AuditLogWhereInput = {};
      if (action) where.action = { contains: action as string };
      if (userId) where.userId = userId as string;
      if (resourceType) where.resourceType = resourceType as string;

      // audit_logs is RLS-protected; this is a cross-tenant super-admin viewer.
      // withRlsBypass allows reading across all stores; the where clause
      // (action / userId / resourceType) provides application-level scoping.
      const [logs, total] = await withRlsBypass((tx: Prisma.TransactionClient) =>
        Promise.all([
          tx.auditLog.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            include: {
              user: {
                select: { id: true, email: true, firstName: true, lastName: true },
              },
            },
          }),
          tx.auditLog.count({ where }),
        ])
      );

      res.json({
        success: true,
        data: {
          logs,
          meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// Super-admin platform-wide AI usage summary.
// Uses withRlsBypass so the query can aggregate across all stores
// without being filtered by the tenant RLS policy.
// Never exposed to store_admin — requireRole('super_admin') enforces this.
// =====================================================================

/**
 * GET /admin/super-admin/ai-usage/summary
 *
 * Returns:
 *   platform: { todayCount, monthCount, totalCached, totalUncached, cacheHitRatio,
 *               monthCostMicros, monthUnpricedCalls, ratesConfigured }
 *   stores:   [{ storeId, slug, name, plan, today, month, dailyCap, monthlyCap,
 *               dailyPct, monthlyPct, lastCallAt, featureCounts,
 *               monthCostMicros, monthUnpricedCalls }]
 *
 * Spend is in MICROS of the billing currency (1_000_000 = 1 unit). `unpriced`
 * counts billable calls whose model had no configured rate — those contribute
 * NOTHING to the spend total, so a non-zero unpriced count means the figure is
 * a floor. Never render the two folded together.
 *
 * Stores sorted by today desc (highest consumer first).
 */
router.get(
  '/super-admin/ai-usage/summary',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dailyCap = parseInt(process.env.AI_DAILY_REQUEST_CAP ?? '450', 10);
      const monthlyCap = parseInt(process.env.AI_MONTHLY_REQUEST_CAP ?? '20000', 10);

      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setUTCHours(0, 0, 0, 0);
      const startOfMonth = new Date(now);
      startOfMonth.setUTCDate(1);
      startOfMonth.setUTCHours(0, 0, 0, 0);

      // withRlsBypass: aiUsage has RLS — must bypass to aggregate cross-tenant
      const result = await withRlsBypass(async tx => {
        // Platform-level totals
        const [platformToday, platformMonth, platformCached] = await Promise.all([
          tx.aiUsage.count({ where: { createdAt: { gte: startOfDay }, cachedHit: false } }),
          tx.aiUsage.count({ where: { createdAt: { gte: startOfMonth }, cachedHit: false } }),
          tx.aiUsage.count({ where: { createdAt: { gte: startOfMonth }, cachedHit: true } }),
        ]);
        const platformUncached = platformMonth;
        const totalCalls = platformCached + platformUncached;
        const cacheHitRatio = totalCalls > 0 ? platformCached / totalCalls : 0;

        // Per-store aggregations: today count, month count, last call, feature breakdown
        const storeStats = await tx.$queryRaw<
          Array<{
            store_id: string;
            today_count: bigint;
            month_count: bigint;
            last_call_at: Date | null;
            feature: string;
            feature_count: bigint;
            month_cost_micros: bigint | null;
            month_unpriced: bigint;
          }>
        >`
          SELECT
            store_id,
            COUNT(*) FILTER (WHERE created_at >= ${startOfDay} AND cached_hit = false) AS today_count,
            COUNT(*) FILTER (WHERE created_at >= ${startOfMonth} AND cached_hit = false) AS month_count,
            MAX(created_at) AS last_call_at,
            feature,
            COUNT(*) AS feature_count,
            -- Spend this month. SUM ignores NULLs, so unpriced rows do not
            -- silently contribute 0 - they are counted separately below and
            -- surfaced in the UI, because "no rate configured" and "free" are
            -- different facts and folding them together makes an unpriced
            -- deployment look free. See apps/api/src/lib/ai-pricing.ts.
            SUM(cost_micros) FILTER (WHERE created_at >= ${startOfMonth}) AS month_cost_micros,
            COUNT(*) FILTER (
              WHERE created_at >= ${startOfMonth}
                AND cached_hit = false
                AND cost_micros IS NULL
            ) AS month_unpriced
          FROM ai_usage
          GROUP BY store_id, feature
        `;

        // Fetch store metadata for all referenced storeIds
        const storeIds = [...new Set(storeStats.map(r => r.store_id))];

        const stores = await tx.store.findMany({
          where: { id: { in: storeIds } },
          select: { id: true, slug: true, name: true, plan: true },
        });
        const storeMap = new Map(stores.map(s => [s.id, s]));

        // Aggregate per-store
        type StoreAgg = {
          storeId: string;
          today: number;
          month: number;
          lastCallAt: Date | null;
          featureCounts: Record<string, number>;
          monthCostMicros: number;
          monthUnpricedCalls: number;
        };
        const byStore = new Map<string, StoreAgg>();

        // NOTE (2026-08-09): today/month are SUMMED across feature rows, not MAX'd.
        //
        // The query GROUPs BY (store_id, feature), so every aggregate - including
        // the FILTERed today/month counts - is scoped to ONE feature. The previous
        // code took Math.max across a store's feature rows on the stated belief
        // that "today/month are the same value across feature rows". They are not,
        // and the effect was that each store reported only its single busiest
        // FEATURE instead of its total: a store using translate + seo + categorize
        // showed roughly a third of its real usage, and dailyPct/monthlyPct - the
        // cap-pressure numbers this page exists to show - were wrong by the same
        // factor.
        for (const row of storeStats) {
          const existing = byStore.get(row.store_id);
          if (!existing) {
            byStore.set(row.store_id, {
              storeId: row.store_id,
              today: Number(row.today_count),
              month: Number(row.month_count),
              lastCallAt: row.last_call_at,
              featureCounts: { [row.feature]: Number(row.feature_count) },
              monthCostMicros: Number(row.month_cost_micros ?? 0),
              monthUnpricedCalls: Number(row.month_unpriced),
            });
          } else {
            existing.today += Number(row.today_count);
            existing.month += Number(row.month_count);
            existing.monthCostMicros += Number(row.month_cost_micros ?? 0);
            existing.monthUnpricedCalls += Number(row.month_unpriced);
            if (
              row.last_call_at &&
              (!existing.lastCallAt || row.last_call_at > existing.lastCallAt)
            ) {
              existing.lastCallAt = row.last_call_at;
            }
            existing.featureCounts[row.feature] = Number(row.feature_count);
          }
        }

        const storeRows = [...byStore.values()]
          .map(s => {
            const meta = storeMap.get(s.storeId);
            const dailyPct = Math.min(100, Math.round((s.today / Math.max(dailyCap, 1)) * 100));
            const monthlyPct = Math.min(100, Math.round((s.month / Math.max(monthlyCap, 1)) * 100));
            return {
              storeId: s.storeId,
              slug: meta?.slug ?? s.storeId,
              name: meta?.name ?? 'Unknown',
              plan: meta?.plan ?? 'free',
              today: s.today,
              month: s.month,
              dailyCap,
              monthlyCap,
              dailyPct,
              monthlyPct,
              lastCallAt: s.lastCallAt?.toISOString() ?? null,
              featureCounts: s.featureCounts,
              monthCostMicros: s.monthCostMicros,
              monthUnpricedCalls: s.monthUnpricedCalls,
            };
          })
          // Sort by today desc, then month desc
          .sort((a, b) => b.today - a.today || b.month - a.month);

        // Platform spend is summed from the per-store rows rather than queried
        // again, so the header can never disagree with the table beneath it.
        const platformMonthCostMicros = storeRows.reduce((n, r) => n + r.monthCostMicros, 0);
        const platformUnpricedCalls = storeRows.reduce((n, r) => n + r.monthUnpricedCalls, 0);

        return {
          platform: {
            todayCount: platformToday,
            monthCount: platformMonth,
            totalCached: platformCached,
            totalUncached: platformUncached,
            cacheHitRatio,
            monthCostMicros: platformMonthCostMicros,
            // How many billable calls this month had NO configured rate. If this
            // is non-zero the spend figure is a FLOOR, not the true total, and
            // the UI must say so instead of implying the difference was free.
            monthUnpricedCalls: platformUnpricedCalls,
            ratesConfigured: hasAnyRateConfigured(),
          },
          stores: storeRows,
        };
      });

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/super-admin/usage-history?months=12
 *
 * The per-store monthly usage history written by the `store-usage-snapshot`
 * cron. This is the data that turns plan-tier ceilings from a guess into
 * something derived from what merchants actually do.
 *
 * Returns newest period first: [{ periodStart, stores: [{ slug, ...metrics }] }]
 */
router.get(
  '/super-admin/usage-history',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const months = Math.min(
        Math.max(parseInt(String(req.query.months ?? '12'), 10) || 12, 1),
        36
      );

      // Cross-tenant by nature — withRlsBypass, same as the ai-usage summary.
      //
      // Paged by PERIOD, not by a flat row budget (PR 2301 audit): the old
      // `take: months * 200` let the newest months consume the whole budget on
      // a platform past 200 stores, so older months came back silently partial
      // while the viewer rendered them as complete. Pick the newest `months`
      // distinct periods first, then read every row of those periods.
      const rows = await withRlsBypass(async tx => {
        const periods = await tx.storeUsageSnapshot.findMany({
          distinct: ['periodStart'],
          orderBy: [{ periodStart: 'desc' }],
          take: months,
          select: { periodStart: true },
        });
        if (periods.length === 0) return [];
        return tx.storeUsageSnapshot.findMany({
          where: { periodStart: { in: periods.map(p => p.periodStart) } },
          orderBy: [{ periodStart: 'desc' }],
          include: { store: { select: { slug: true, name: true, plan: true } } },
        });
      });

      const byPeriod = new Map<string, Array<Record<string, unknown>>>();
      for (const r of rows) {
        const key = r.periodStart.toISOString().slice(0, 10);
        if (!byPeriod.has(key)) byPeriod.set(key, []);
        byPeriod.get(key)!.push({
          storeId: r.storeId,
          slug: r.store?.slug ?? r.storeId,
          name: r.store?.name ?? 'Unknown',
          plan: r.store?.plan ?? 'free',
          products: r.products,
          productsActive: r.productsActive,
          variants: r.variants,
          images: r.images,
          categories: r.categories,
          orders: r.orders,
          // #1057: revenueFils/productViews/aiCostMicros are now BigInt —
          // `res.json` (JSON.stringify) throws on a raw bigint ("Do not know
          // how to serialize a BigInt"), so these serialize as strings, the
          // standard BigInt-at-a-JSON-boundary convention. The super-admin
          // viewer is apps/admin/src/app/usage-history/page.tsx (issue 1058);
          // its `UsageStoreRow` type mirrors this shape — keep them in sync.
          revenueFils: r.revenueFils.toString(),
          customers: r.customers,
          sessionsProxy: r.sessionsProxy,
          cartsWithItems: r.cartsWithItems,
          productViews: r.productViews.toString(),
          aiCalls: r.aiCalls,
          aiBillableCalls: r.aiBillableCalls,
          aiCostMicros: r.aiCostMicros.toString(),
          aiUnpricedCalls: r.aiUnpricedCalls,
        });
      }

      res.json({
        success: true,
        data: {
          periods: [...byPeriod.entries()]
            .sort((a, b) => (a[0] < b[0] ? 1 : -1))
            .slice(0, months)
            .map(([periodStart, stores]) => ({ periodStart, stores })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// Endpoint 1: Cross-tenant order export (streaming cursor CSV)
//
// WHY per-chunk bypass: a single long-lived withRlsBypass transaction
// holds a pooled connection for the entire export duration (potentially
// minutes for large platforms). This would starve the connection pool
// and risk hitting the 30s Prisma transaction timeout. Instead, each
// CHUNK_SIZE page is fetched inside its own short-lived bypass tx,
// then immediately streamed to the response. The TCP buffer handles
// back-pressure; the DB connection returns to the pool between chunks.
//
// SECURITY: super_admin only. Application-level WHERE filters (storeId,
// status, paymentStatus, date range) are preserved inside every bypass
// transaction as defense-in-depth — even with RLS bypassed, the query
// still only returns what the filter requests.
// =====================================================================

const EXPORT_CHUNK_SIZE = 250;

// CSV field escaping (formula-injection safe) is the shared `csvField` from
// @force/shared — single canonical implementation across every exporter.

/**
 * GET /admin/export/orders
 *
 * Streams a cross-tenant order export as CSV using cursor-based pagination.
 * Each page is fetched inside its own short-lived withRlsBypass transaction
 * so no single connection is held for the full export duration.
 *
 * Query params:
 *   storeId?       – filter to a single store
 *   status?        – filter by OrderStatus
 *   paymentStatus? – filter by OrderPaymentStatus
 *   from?          – ISO date string (createdAt >=)
 *   to?            – ISO date string (createdAt <=)
 */
router.get(
  '/export/orders',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, status, paymentStatus, from, to } = req.query;

      const where: Prisma.OrderWhereInput = {};
      if (storeId) where.storeId = storeId as string;
      if (status) where.status = status as OrderStatus;
      if (paymentStatus) where.paymentStatus = paymentStatus as OrderPaymentStatus;
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from as string);
        if (to) where.createdAt.lte = new Date(to as string);
      }

      const filename = `orders-export-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // Write CSV header row immediately so the browser shows progress
      const header =
        'order_number,store_id,store_name,status,payment_status,total,' +
        'customer_email,customer_name,shipping_country,shipping_city,' +
        'shipping_area,created_at\n';
      res.write(header);

      let cursor: string | undefined;
      let totalRows = 0;

      // Cursor-based streaming loop: each iteration opens a fresh bypass tx,
      // fetches one page, streams it to the response, then closes the tx.
      // This keeps individual transaction lifetimes to <1s even on large exports.
      while (true) {
        // Each chunk gets its own withRlsBypass transaction (not one long tx).
        const rows = await withRlsBypass((tx: Prisma.TransactionClient) =>
          tx.order.findMany({
            where,
            orderBy: { id: 'asc' }, // stable cursor anchor
            take: EXPORT_CHUNK_SIZE,
            // Prisma cursor: skip the cursor row itself (skip: 1) on every
            // page after the first. The `id` field is a UUID primary key so
            // it uniquely identifies the last-seen row.
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            select: {
              id: true,
              orderNumber: true,
              storeId: true,
              status: true,
              paymentStatus: true,
              total: true,
              shippingAddress: true,
              createdAt: true,
              store: { select: { name: true } },
              customer: {
                select: { email: true, firstName: true, lastName: true },
              },
            },
          })
        );

        if (rows.length === 0) break;

        // Build and flush this chunk to the TCP buffer
        const chunk = rows
          .map(o => {
            const addr = o.shippingAddress as Record<string, string> | null;
            return [
              csvField(o.orderNumber),
              csvField(o.storeId),
              csvField(o.store?.name),
              csvField(o.status),
              csvField(o.paymentStatus),
              csvField(o.total),
              csvField(o.customer?.email),
              csvField(o.customer ? `${o.customer.firstName} ${o.customer.lastName}`.trim() : null),
              csvField(addr?.country),
              csvField(addr?.city),
              csvField(addr?.area),
              csvField(o.createdAt),
            ].join(',');
          })
          .join('\n');

        res.write(chunk + '\n');

        cursor = rows[rows.length - 1].id;
        totalRows += rows.length;

        // Finished if we got fewer rows than the page size
        if (rows.length < EXPORT_CHUNK_SIZE) break;
      }

      logger.info(
        { userId: req.user?.userId, totalRows, storeId, status, paymentStatus },
        'admin: order export completed'
      );

      await auditLog({
        action: 'admin.export.orders',
        userId: req.user!.userId,
        resourceType: 'order',
        details: { totalRows, storeId, status, paymentStatus, from, to },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.end();
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// GET /admin/export/orders.xlsx — same cross-tenant export as above but
// returns an Excel workbook instead of CSV. Same auth (super_admin) and
// same query-param filters (storeId, status, paymentStatus, from, to).
// All rows are collected first (orders exports are bounded by date range)
// then flushed as one workbook — avoids chunked streaming complexity.
// =====================================================================

router.get(
  '/export/orders.xlsx',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, status, paymentStatus, from, to } = req.query;

      const where: Prisma.OrderWhereInput = {};
      if (storeId) where.storeId = storeId as string;
      if (status) where.status = status as OrderStatus;
      if (paymentStatus) where.paymentStatus = paymentStatus as OrderPaymentStatus;
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from as string);
        if (to) where.createdAt.lte = new Date(to as string);
      }

      const orders = await withRlsBypass((tx: Prisma.TransactionClient) =>
        tx.order.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          take: 50000,
          select: {
            id: true,
            orderNumber: true,
            storeId: true,
            status: true,
            paymentStatus: true,
            total: true,
            shippingAddress: true,
            createdAt: true,
            store: { select: { name: true } },
            customer: {
              select: { email: true, firstName: true, lastName: true },
            },
          },
        })
      );

      const rows = orders.map(o => {
        const addr = o.shippingAddress as Record<string, string> | null;
        return {
          orderNumber: o.orderNumber ?? '',
          storeId: o.storeId,
          storeName: o.store?.name ?? '',
          status: o.status,
          paymentStatus: o.paymentStatus,
          total: o.total / 1000,
          customerEmail: o.customer?.email ?? '',
          customerName: o.customer ? `${o.customer.firstName} ${o.customer.lastName}`.trim() : '',
          shippingCountry: addr?.country ?? '',
          shippingCity: addr?.city ?? '',
          shippingArea: addr?.area ?? '',
          createdAt: o.createdAt.toISOString(),
        };
      });

      await auditLog({
        action: 'admin.export.orders',
        userId: req.user!.userId,
        resourceType: 'order',
        details: {
          type: 'orders_xlsx',
          totalRows: rows.length,
          storeId,
          status,
          paymentStatus,
          from,
          to,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const date = new Date().toISOString().slice(0, 10);
      await streamXlsxResponse(res, {
        filename: `orders-export-${date}.xlsx`,
        sheetName: 'Orders',
        columns: [
          { header: 'Order Number', key: 'orderNumber', width: 20 },
          { header: 'Store ID', key: 'storeId', width: 38 },
          { header: 'Store Name', key: 'storeName', width: 30 },
          { header: 'Status', key: 'status', width: 16 },
          { header: 'Payment Status', key: 'paymentStatus', width: 18 },
          { header: 'Total (KWD)', key: 'total', width: 14, numFmt: '#,##0.000' },
          { header: 'Customer Email', key: 'customerEmail', width: 34 },
          { header: 'Customer Name', key: 'customerName', width: 28 },
          { header: 'Shipping Country', key: 'shippingCountry', width: 18 },
          { header: 'Shipping City', key: 'shippingCity', width: 18 },
          { header: 'Shipping Area', key: 'shippingArea', width: 18 },
          { header: 'Created At', key: 'createdAt', width: 26 },
        ],
        rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// Endpoint 2: Super-admin impersonation
//
// Issues a short-lived impersonation access token for the target user.
// The target user's record lives in the `users` table which has NO RLS
// policy (users are a global table, not tenant-scoped — see migration
// 20260404000000_add_rls_policies comment "Tables without store_id").
// A plain prisma.user.findUnique() works without bypass for that lookup.
//
// HOWEVER: the audit_logs write IS RLS-protected (rls_audit_logs_tenant).
// auditLog() uses prisma.auditLog.create which runs through the proxy.
// In the /admin context there is no tenant GUC set, so the old nullable-
// storeId policy allows the insert (store_id IS NULL → allowed). We keep
// auditLog() as-is — it's already working in other /admin routes.
//
// SECURITY: super_admin only. Generates a 1-hour token (not a full
// 30-day session) and logs the impersonation to the audit trail.
// The impersonation token carries a `impersonatedBy` field so downstream
// guards can reject it for high-privilege operations if desired.
// =====================================================================

const impersonateSchema = z.object({
  userId: z.string().uuid('userId must be a UUID'),
});

/**
 * POST /admin/impersonate
 *
 * Returns a short-lived (1h) impersonation access token for the given
 * userId. The calling super_admin's identity is recorded in the audit log.
 *
 * Body: { userId: string }
 */
router.post(
  '/impersonate',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = impersonateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'userId must be a valid UUID' },
        });
        return;
      }
      const { userId } = parsed.data;

      // users table has no RLS — plain lookup works under force_app without bypass.
      // We intentionally leave this as-is: adding withRlsBypass here would be
      // over-engineering (the policy doesn't exist) and would waste a tx slot.
      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          role: true,
          storeId: true,
          deletedAt: true,
          tokenVersion: true,
        },
      });

      if (!target) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found' },
        });
        return;
      }

      if (target.deletedAt !== null) {
        res.status(410).json({
          success: false,
          error: { code: 'USER_DELETED', message: 'Cannot impersonate a deleted user' },
        });
        return;
      }

      // Prevent impersonating another super_admin (principle of least privilege)
      if (target.role === 'super_admin') {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Cannot impersonate another super_admin' },
        });
        return;
      }

      // Issue a 1-hour impersonation token. Short TTL minimises blast radius
      // if the token is accidentally exposed. The token carries tv + jti so
      // it is revocable via the JTI denylist and per-user tokenVersion check,
      // exactly like a normal access token (H1 fix).
      const impersonationToken = jwt.sign(
        {
          userId: target.id,
          email: target.email,
          role: target.role,
          storeId: target.storeId ?? null,
          // Token version at issue time: lets revokeAllSessions() / logout-all
          // invalidate impersonation tokens in the same sweep as real sessions.
          tv: target.tokenVersion,
          // Non-standard claim — allows future guards to detect impersonation
          impersonatedBy: req.user!.userId,
        },
        config.jwtSecret,
        {
          algorithm: 'HS256',
          expiresIn: '1h',
          issuer: 'force-api',
          audience: 'force-app',
          subject: target.id,
          // Unique jti so this token can be individually revoked via the
          // JTI denylist (e.g. if the impersonation session must be ended early).
          jwtid: crypto.randomUUID(),
        }
      );

      // Audit the impersonation. auditLog() creates a row with storeId=null
      // which the audit_logs nullable policy allows without a GUC.
      await auditLog({
        action: 'admin.impersonate',
        userId: req.user!.userId,
        resourceType: 'user',
        resourceId: target.id,
        details: {
          targetEmail: target.email,
          targetRole: target.role,
          targetStoreId: target.storeId,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        { adminId: req.user?.userId, targetId: target.id, targetRole: target.role },
        'admin: impersonation token issued'
      );

      res.json({
        success: true,
        data: {
          accessToken: impersonationToken,
          expiresIn: 3600,
          targetUser: {
            id: target.id,
            email: target.email,
            role: target.role,
            storeId: target.storeId,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── Webhook events (payment inbox) — super-admin observability + replay ──
// Builder Reality Audit Lens E, E3-4. The WebhookEvent inbox is the durable
// record of every payment-provider webhook. A wedged/failed row P0-alerts
// (alerts-failure-watch + payment-webhook-stuck-sweep) but had no UI to inspect
// or replay it — an operator's only recourse was Prisma Studio. This surfaces
// the rows + a one-click replay (re-fires payment/webhook.received; safe by
// construction — handleWebhook is idempotency-guarded).
router.get(
  '/webhook-events',
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page: pageStr, limit: limitStr, status, provider } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);
      const where: Record<string, unknown> = {};
      if (typeof status === 'string' && status) where.status = status;
      if (typeof provider === 'string' && provider) where.provider = provider;
      const [events, total] = await withRlsBypass(tx =>
        Promise.all([
          tx.webhookEvent.findMany({
            where,
            select: {
              id: true,
              provider: true,
              storeId: true,
              status: true,
              attempts: true,
              lastError: true,
              resultOrderId: true,
              resultStatus: true,
              idempotencyKey: true,
              receivedAt: true,
            },
            orderBy: { receivedAt: 'desc' },
            skip,
            take: limit,
          }),
          tx.webhookEvent.count({ where }),
        ])
      );
      res.json({
        success: true,
        data: {
          events,
          pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/webhook-events/:id/replay',
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const force = req.body?.force === true || req.query.force === 'true';
      const row = await withRlsBypass(tx =>
        tx.webhookEvent.findUnique({
          where: { id },
          select: { id: true, provider: true, idempotencyKey: true, storeId: true, status: true },
        })
      );
      if (!row) {
        res.status(404).json({
          success: false,
          error: { code: 'WEBHOOK_EVENT_NOT_FOUND', message: 'Webhook event not found' },
        });
        return;
      }
      // Money-path guard: replaying an already-`processed` webhook re-fires the
      // payment mutation, and while handleWebhook is idempotency-guarded (inbox
      // status, Order.webhookProcessedAt, status equality) so it can never
      // double-APPLY, re-processing a settled payment must be a DELIBERATE act,
      // not an accidental one-click. Require `force` to replay a processed row.
      if (row.status === 'processed' && !force) {
        res.status(409).json({
          success: false,
          error: {
            code: 'WEBHOOK_ALREADY_PROCESSED',
            message: 'This webhook is already processed. Re-send force:true to replay it anyway.',
          },
        });
        return;
      }
      // Reset to a fresh received/attempts=0 so the consumer treats it as
      // undelivered, then re-fire. `receivedAt` is bumped to now so the
      // payment-webhook-stuck-sweep (which re-sends rows stuck in
      // received/attempts=0 past STUCK_WEBHOOK_MINUTES by AGE) does not ALSO
      // re-fire this row in the window before the consumer claims it — that
      // would double-send `payment/webhook.received` for one replay.
      await withRlsBypass(tx =>
        tx.webhookEvent.update({
          where: { id },
          data: { status: 'received', attempts: 0, lastError: null, receivedAt: new Date() },
        })
      );
      await inngest.send({
        name: 'payment/webhook.received',
        data: {
          webhookEventId: row.id,
          provider: row.provider,
          idempotencyKey: row.idempotencyKey,
          storeId: row.storeId ?? undefined,
        },
      });
      await auditLog({
        action: 'webhook_event.replay',
        userId: req.user!.userId,
        resourceType: 'setting',
        resourceId: row.id,
        details: { provider: row.provider },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { replayed: row.id } });
    } catch (err) {
      next(err);
    }
  }
);

// ── Email queue dead-letter — super-admin observability + replay ──
// Issue 2142: an order-lifecycle email queued with `{ queue: true }` that fails
// every attempt lands in the Redis list `email:failed` and fires a P1 alert
// (`email.queue.permanent_failure`). This is where an operator sees those
// emails and puts them back on the queue once the provider recovers. The
// recipient address is masked; the body is never returned.
router.get(
  '/email-queue/failed',
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100) || 100));
      const [emails, stats] = await Promise.all([
        emailQueue.getFailedEmails(limit),
        emailQueue.getStats(),
      ]);
      res.json({
        success: true,
        data: {
          stats: { pending: stats.pending, failed: stats.failed },
          emails: emails.map(e => ({
            id: e.id,
            storeId: e.storeId,
            to: (Array.isArray(e.options.to) ? e.options.to : [e.options.to]).map(maskEmail),
            subject: e.options.subject,
            attempts: e.attempts,
            error: e.error ?? null,
            createdAt: e.createdAt,
            lastAttempt: e.lastAttempt ?? null,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/email-queue/failed/retry',
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const retried = await emailQueue.retryFailed();
      await auditLog({
        action: 'email_queue.retry_failed',
        userId: req.user!.userId,
        resourceType: 'setting',
        resourceId: 'email:failed',
        details: { retried },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { retried } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
