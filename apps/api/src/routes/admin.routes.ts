import { revokeForAccount } from '../lib/wa/consent';
import { requirePlatformDb } from '../lib/platform-db';
import { d1StoreBriefs, platformDb as platformDirectoryDb } from '../lib/platform-directory';
import { aiUsageFeatureStats } from '../services/usage-aggregates.service';
import { platformFamilyOnD1 } from '../services/platform/cutover';
import { customerAuthRoute } from '../lib/customer-auth';
import { repairProductNames } from '../services/product-name-repair.service';
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod/v3';
import { authenticate } from '../middleware/auth';
import {
  eraseIdentityUser,
  getAccountState,
  inviteIdentity,
  getAccountsBrief,
  revokeIdentityUser,
  setAccountRole,
  setAccountStatus,
  updateIdentityProfile,
} from '../lib/identity-client';
import { AuthService } from '../services/auth.service';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireRole } from '../middleware/rbac';
import { bustStoreCaches } from '../services/store.service';
import { featureService } from '../services/feature.service';
import { invalidateCached } from '../lib/public-cache';
import { listGrants } from '../services/billing/grants.service';
import { hasAnyRateConfigured } from '../lib/ai-pricing';
import { ProvisioningService } from '../services/provisioning.service';
import { searchProductIds } from '../services/product-search.service';
import { auditLog } from '../middleware/security';
import { syncSubscriptionFromLegacyPlan } from '../services/plan-sync';
import {
  listHeldBillingWebhooks,
  listLedger,
  listSubscriptionsForAdmin,
  refundCharge,
  resolveHeldBillingWebhook,
} from '../services/billing/subscription-billing.service';
import {
  listClaimsForAdmin,
  recordManualPayment,
  recordManualRefund,
  rejectClaim,
  suggestManualPeriod,
} from '../services/billing/account.service';
import multer from 'multer';
import {
  INSTAPAY_RECEIPT_MAX_BYTES,
  JWT_AUDIENCE,
  JWT_ISSUER,
  REGION,
  zonedLocalToUtc,
} from '@ebda/shared';
import { InstapayReceiptService } from '../services/payment-providers/instapay-receipt.service';
import { config } from '../config';
import logger from '../lib/logger';
import { inngest } from '../lib/inngest/client';
import { streamXlsxResponse } from '../lib/exports/xlsx';
import { emailQueue } from '../services/email-queue.service';
import { smsQueue } from '../services/sms-queue.service';
import { redis } from '../services/redis.service';
import { maskEmail, maskPhone } from '../lib/pii-mask';
import {
  prisma,
  acrossStores,
  acrossStoresFlat,
  withStore,
  asPlatformOperator,
  currentTenantGucs,
  currentStoreId,
  storeDirectory,
  Prisma,
  UserRole,
  ProductStatus,
  OrderStatus,
  OrderPaymentStatus,
} from '@ebda/database';
import {
  csvField,
  isValidTimeZone,
  fromMinor,
  excelMoneyFormat,
  updatePlanSchema,
  assignSubscriptionSchema,
  isReservedSlug,
} from '@ebda/shared';
import { platformUserContext } from '../middleware/tenant-context';
import { impersonationTargetD1 } from '../lib/impersonation-target';
import { getEntityStoreId, lookupStore, platformAuditLogs, webhookInbox } from '../lib/definer';
import { onAccessD1, storeBriefsD1 } from '../services/platform/access-d1';
import { eraseHubUserData } from '../services/platform/hub-user-data';
import { revokeUserMerchantKeysD1 } from '../services/platform/platform-d1';
import { ownedStoreIds, pageAcrossStores } from '../lib/cross-store';
import { planService } from '../services/plan.service';
import { referralSignupCounts } from '../services/lifecycle-emails.service';
import { storeUpdate } from '../lib/repo-factory';
import { toSafeStoreResponse } from '../lib/store-response';
import {
  HUB_FANOUT_CAP,
  hubAccountIds,
  hubFanout,
  hubFanoutStoreIds,
  hubOnD1,
  hubOwnedStores,
  hubOwners,
  hubStorePage,
  hubSearchCustomers,
  hubStoresById,
  hubUsers,
} from '../lib/platform-hub';
import { storeDb } from '../lib/repo-factory';
import { customerRows } from '../lib/customer-directory';

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

// Every authenticated /admin request runs in ONE request transaction scoped to
// the acting user (`app.current_user_id`). `users` is RLS-scoped to the user —
// a super_admin principal sees the whole platform directory, a store admin sees
// themselves and their stores' owners/staff — so the owner joins on store lists,
// the user directory and the role checks all resolve under it. Exports stream
// for longer than the 30s request-transaction budget, so they stay outside it
// and scope themselves (they fan out per store).
const adminUserContext = platformUserContext(req => req.user?.userId);
router.use((req: Request, res: Response, next: NextFunction) =>
  req.path.startsWith('/export') ? next() : adminUserContext(req, res, next)
);

// A super_admin request reads the PLATFORM directory (every store row, the user
// directory): under the code-level tenant guard (R-EBDA-003) that is the named
// 'platform-operator' hatch, opened only after `ebda_is_super_admin()` confirms the
// acting user inside this request's transaction. It opens `Store` and the identity
// models only; per-store tenant tables still go through `acrossStores`.
//
// The hatch is entered ONLY on the request transaction `adminUserContext` opened for
// this same user: `asPlatformOperator` then joins it (no transaction of its own), so
// the hatch can never outlive a transaction that committed before the handler
// finished. Without that transaction the hatch stays shut and the guard refuses.
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'super_admin' || req.path.startsWith('/export')) return next();
  if (currentTenantGucs()?.userId !== req.user.userId) return next();
  asPlatformOperator(req.user.userId, async () => next()).catch(next);
});

// Helper: enforce ownership when a store_admin is the caller. Super admins
// pass through unscoped. Returns the userId to filter by, or undefined
// when no scoping is needed.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The stores a super-admin list is limited to by its `storeId` query filter:
 * none given = every store; a malformed id matches no store (as before, an
 * empty page rather than an error).
 */
/**
 * BE:E-4: the super-admin pages fan out one short tenant transaction per store. That is O(stores) per request and was
 * unbounded; past a few hundred stores a page would sit behind hundreds of sequential-ish transactions. Every fan-out below
 * now takes its store list through this guard: at most SUPER_ADMIN_FANOUT_CAP stores per request, with a warning when the
 * list is cut. RESIDUAL (Ruling FP-7): beyond the cap the totals cover the first CAP stores by id; a cursor/rollup table is the
 * real fix and is a platform decision. Cost if wrong: a platform with more stores than the cap sees partial super-admin totals.
 */
export const SUPER_ADMIN_FANOUT_CAP = 500;
export async function boundedFanoutStoreIds(ids?: string[]): Promise<string[]> {
  // NEON-ZERO (Ruling NZ-C-4): the hub lists stores from D1 (already capped, newest first).
  if (!ids && (await hubOnD1())) return (await hubFanoutStoreIds()).ids;
  const all = ids ?? (await storeDirectory()).map(s => s.id);
  if (all.length <= SUPER_ADMIN_FANOUT_CAP) return all;
  logger.warn(
    { stores: all.length, cap: SUPER_ADMIN_FANOUT_CAP },
    '[admin] cross-store fan-out truncated to the cap'
  );
  return all.slice(0, SUPER_ADMIN_FANOUT_CAP);
}

async function findProductStoreOnHub(productId: string): Promise<string | null> {
  const { ids } = await hubFanoutStoreIds();
  const hits = await hubFanout(
    ids,
    async sid =>
      (await (
        await storeDb(sid)
      ).product.findUnique({ where: { id: productId }, select: { id: true } }))
        ? sid
        : null,
    () => undefined
  );
  return hits.find(h => h.value)?.value ?? null;
}

/** On the hub the `store` relation is not a join (DO read clients cannot reach D1): attach {id,name,slug} from the directory. */
async function attachStoreRel<T extends { storeId: string }>(rows: T[], on: boolean): Promise<T[]> {
  if (!on || rows.length === 0) return rows;
  const byId = new Map(
    (await hubStoresById(rows.map(r => r.storeId))).map(s => [
      s.id,
      { id: s.id, name: s.name, slug: s.slug },
    ])
  );
  return rows.map(r => ({ ...r, store: byId.get(r.storeId) ?? null }));
}

/** DO-store orders carry `customerId` only (the customer lives in the store's customer directory): attach {id,email,names}. */
async function attachCustomerRel<T extends { storeId: string; customerId?: string | null }>(
  rows: T[],
  on: boolean
): Promise<
  Array<
    T & { customer?: { id?: string; email: string; firstName: string; lastName: string } | null }
  >
> {
  if (!on || rows.length === 0) return rows;
  const byStore = new Map<string, Set<string>>();
  for (const r of rows)
    if (r.customerId)
      byStore.set(r.storeId, (byStore.get(r.storeId) ?? new Set()).add(r.customerId));
  const found = new Map<
    string,
    { id: string; email: string; firstName: string; lastName: string }
  >();
  await hubFanout(
    [...byStore.keys()],
    async sid => {
      const list = await customerRows(sid, [...byStore.get(sid)!]);
      for (const c of list ?? [])
        found.set(c.id, { id: c.id, email: c.email, firstName: c.firstName, lastName: c.lastName });
    },
    () => undefined
  );
  return rows.map(r => ({ ...r, customer: (r.customerId && found.get(r.customerId)) || null }));
}

function storeIdsFromFilter(storeId: unknown): string[] | undefined {
  if (!storeId) return undefined;
  return UUID_RE.test(String(storeId)) ? [String(storeId)] : [];
}

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
    // A platform host (`accounts`, `wa`, `api`...) must never become a merchant store, even by a super admin's slip.
    .refine(s => !isReservedSlug(s), 'This slug is reserved for a platform host')
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
      // Governs the store's tax periods — reject a non-IANA name rather than
      // silently falling back to Egypt days (issue 2412).
      timezone: z
        .string()
        .refine(isValidTimeZone, { message: 'timezone must be a valid IANA time zone' })
        .optional(),
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
        // store_staff matches `user_id = app.current_user_id`, which the
        // /admin user context sets to the acting staff member.
        const memberships = await prisma.storeStaff.findMany({
          where: { userId: req.user!.userId },
          select: { storeId: true },
        });
        const storeIds = memberships.map(m => m.storeId);
        if (storeIds.length === 0) {
          res.json({
            success: true,
            data: { stores: [], pagination: { page: 1, limit, total: 0, totalPages: 0 } },
          });
          return;
        }
        // Fetch the actual store rows for these ids. After the `access` cutover the Postgres `stores` policy (which reads the
        // emptied Postgres membership) would show a staff member added after the flip an EMPTY list, so the rows come from D1.
        if (await onAccessD1()) {
          res.json({ success: true, data: { stores: await storeBriefsD1(storeIds) } });
          return;
        }
        const stores = await prisma.store.findMany({
          where: { id: { in: storeIds } },
          select: { id: true, name: true, nameAr: true, logo: true, slug: true, status: true },
        });
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

      // `stores` is under RLS (R-EBDA-005): resolve the id through the definer, then read
      // the row inside that store's own scope. Ownership is checked below.
      const hit = await lookupStore({ id }, ['active', 'inactive', 'suspended']);
      const store = hit
        ? (await hubOnD1())
          ? await (async () => {
              const rec = await (await storeDb(hit.id)).store.findUnique({ where: { id: hit.id } });
              const owner = rec ? (await hubOwners([rec.ownerId])).get(rec.ownerId) : undefined;
              return rec ? { ...rec, owner: owner ?? null } : null;
            })()
          : await withStore(hit.id, tx =>
              tx.store.findUnique({
                where: { id: hit.id },
                include: {
                  owner: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                  },
                },
              })
            )
        : null;

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
        data: { store: toSafeStoreResponse(store), stats },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /admin/stores/:id/repair-product-names — one-time name-pair repair (Ruling NAME-PAIR-1). DRY-RUN unless the body
 * says `{ "apply": true, "productIds": [...] }`: the dry run lists every product whose names are swapped, Arabic-in-English
 * or an untranslated placeholder, and what each would become; apply writes ONLY the listed ids, and never overwrites an
 * English name the merchant typed. Super admin only.
 */
router.post(
  '/stores/:id/repair-product-names',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { apply, productIds } = z
        .object({
          apply: z.boolean().optional(),
          productIds: z.array(z.string().min(1).max(64)).max(500).optional(),
        })
        .strict()
        .refine(b => b.apply !== true || (b.productIds?.length ?? 0) > 0, {
          message: 'apply needs productIds: the products to repair, from the dry run',
          path: ['productIds'],
        })
        .parse(req.body ?? {});
      const report = await repairProductNames(req.params.id, {
        apply: apply === true,
        productIds,
      });
      if (report.apply) {
        await auditLog({
          action: 'product.names_repaired',
          userId: req.user!.userId,
          storeId: req.params.id,
          resourceType: 'store',
          resourceId: req.params.id,
          details: { repaired: report.applied, skipped: report.skipped },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }
      res.json({ success: true, data: report });
    } catch (error) {
      next(error);
    }
  }
);

const adminStoreStatusBody = z.object({ status: z.enum(['active', 'inactive', 'suspended']) });

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
      // BE:S-15: shape-checked, so a non-object body is the same 400.
      const parsedStatus = adminStoreStatusBody.safeParse(req.body);
      if (!parsedStatus.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_STATUS', message: 'Invalid status' },
        });
        return;
      }
      const { status } = parsedStatus.data;

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
        data: { store: toSafeStoreResponse(store) },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Billing ledger (SP5 task 3) — super-admin view of every `billing_events` row
 * (checkouts, renewals, upgrades, refunds) with provider references, plus a
 * refund action. GET /admin/billing/events?storeId&status&type&limit&before.
 */
router.get(
  '/billing/events',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = z
        .object({
          storeId: z.string().uuid().optional(),
          status: z.enum(['pending', 'succeeded', 'failed', 'refunded']).optional(),
          type: z
            .enum(['checkout', 'renewal', 'upgrade', 'refund', 'card_setup', 'manual_payment'])
            .optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          before: z.coerce.date().optional(),
        })
        .parse(req.query);
      res.json({ success: true, data: { events: await listLedger(q) } });
    } catch (error) {
      next(error);
    }
  }
);

/** Free-month grants (FOUNDING-1): founding-20 + referral ledger with totals. */
router.get(
  '/billing/grants',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = z
        .object({ limit: z.coerce.number().int().min(1).max(500).optional() })
        .parse(req.query);
      res.json({ success: true, data: await listGrants(q.limit) });
    } catch (error) {
      next(error);
    }
  }
);

/** Every store's plan, trial end, card (last4/brand) and next charge (signup funnel). */
router.get(
  '/billing/subscriptions',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = z
        .object({
          status: z.enum(['trialing', 'active', 'past_due', 'canceled', 'comped']).optional(),
          view: z.enum(['due', 'overdue', 'suspended']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query);
      res.json({ success: true, data: { subscriptions: await listSubscriptionsForAdmin(q) } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * #627: subscription payments a provider reported as SUCCESSFUL that we could not match (unknown order, a different
 * amount or currency, no amount). The merchant may have paid without being upgraded: listed here until a person resolves.
 */
router.get(
  '/billing/held-webhooks',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = z
        .object({
          status: z.enum(['open', 'resolved']).default('open'),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query);
      res.json({ success: true, data: { held: await listHeldBillingWebhooks(q) } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/billing/held-webhooks/:id/resolve',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const { action, note } = z
        .object({
          action: z.enum(['credited', 'refunded', 'not_ours']),
          note: z.string().trim().min(3).max(500),
        })
        .parse(req.body);
      await resolveHeldBillingWebhook({ id, actorId: req.user!.userId, action, note });
      await auditLog({
        action: 'billing.held_webhook_resolved',
        userId: req.user!.userId,
        resourceType: 'billing_webhook_event',
        resourceId: id,
        details: { action, note },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

/** Super-admin queue of merchants' "I paid by InstaPay" claims. */
router.get(
  '/billing/claims',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = z
        .object({ status: z.enum(['pending', 'confirmed', 'rejected']).default('pending') })
        .parse(req.query);
      res.json({ success: true, data: { claims: await listClaimsForAdmin(status) } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/billing/claims/:id/receipt?storeId= — the merchant's InstaPay receipt
 * screenshot for a subscription claim (bytes, never a URL; private bucket). Super-admin
 * only: Ebda's team is the ONLY reviewer of subscription payments.
 */
router.get(
  '/billing/claims/:id/receipt',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = z.object({ storeId: z.string().uuid() }).parse(req.query);
      const claimId = z.string().uuid().parse(req.params.id);
      const row = await withStore(storeId, tx =>
        tx.instapayReceipt.findFirst({
          where: { storeId, claimId, kind: 'subscription' },
          select: { id: true },
        })
      );
      if (!row) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'No receipt' } });
        return;
      }
      const img = await InstapayReceiptService.readImage(storeId, row.id, { kind: 'subscription' });
      res.setHeader('Content-Type', img.mimeType);
      res.setHeader('Content-Disposition', 'inline; filename="instapay-receipt"');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(img.body);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/billing/claims/:id/reject',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, note } = z
        .object({ storeId: z.string().uuid(), note: z.string().trim().min(3).max(500) })
        .parse(req.body);
      await rejectClaim({ storeId, claimId: req.params.id, note, actorId: req.user!.userId });
      await auditLog({
        action: 'billing.claim_rejected',
        userId: req.user!.userId,
        storeId,
        resourceType: 'manual_payment_claim',
        resourceId: req.params.id,
        details: { note },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /admin/stores/:id/manual-payment — "Record manual payment & activate"
 * (InstaPay / bank / cash). Super-admin only; idempotent on (method, reference):
 * a repeat returns the first ledger row and changes nothing.
 */
router.post(
  '/stores/:id/manual-payment',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = z
        .object({
          planCode: z.string().min(1).max(64),
          interval: z.enum(['monthly', 'yearly']),
          amountMinor: z.number().int().positive().max(100_000_000),
          method: z.enum(['instapay', 'bank', 'cash']),
          reference: z.string().trim().min(3).max(100),
          paidAt: z.coerce.date(),
          // Omitted = the period rule (never burns paid days, audit M2); both = override.
          periodStart: z.coerce.date().optional().nullable(),
          periodEnd: z.coerce.date().optional().nullable(),
          claimId: z.string().uuid().optional(),
          replacesVoidedEventId: z.string().uuid().optional().nullable(),
        })
        .strict()
        .parse(req.body);
      const out = await recordManualPayment({
        storeId: req.params.id,
        ...input,
        actorId: req.user!.userId,
      });
      await auditLog({
        action: out.duplicate
          ? 'billing.manual_payment_replayed'
          : 'billing.manual_payment_recorded',
        userId: req.user!.userId,
        storeId: req.params.id,
        resourceType: 'billing_event',
        resourceId: out.billingEventId,
        details: {
          planCode: input.planCode,
          interval: input.interval,
          amountMinor: input.amountMinor,
          method: input.method,
          reference: input.reference,
          periodStart: (out.periodStart ?? input.periodStart)?.toISOString() ?? null,
          periodEnd: (out.periodEnd ?? input.periodEnd)?.toISOString() ?? null,
          periodOverride: !!input.periodStart,
          claimId: input.claimId ?? null,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(out.duplicate ? 200 : 201).json({ success: true, data: out });
    } catch (error) {
      next(error);
    }
  }
);

/** GET /admin/stores/:id/manual-payment/suggest?interval= — the period an approval would record. */
router.get(
  '/stores/:id/manual-payment/suggest',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { interval } = z
        .object({ interval: z.enum(['monthly', 'yearly']).default('monthly') })
        .parse(req.query);
      const storeId = z.string().uuid().parse(req.params.id);
      res.json({ success: true, data: await suggestManualPeriod(storeId, interval) });
    } catch (error) {
      next(error);
    }
  }
);

const refundShot = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: INSTAPAY_RECEIPT_MAX_BYTES, files: 1 },
});

/**
 * POST /admin/billing/events/:id/manual-refund — record a refund made OUTSIDE Ebda, or
 * void a payment recorded in error, for a manual (InstaPay) subscription payment
 * (audit M1). Multipart (optional `file` = the refund screenshot) or JSON. Idempotent
 * on the refund reference (void: once per payment); adjusts the paid period.
 * Super-admin only — subscription money is Ebda's to record, never the merchant's.
 */
router.post(
  '/billing/events/:id/manual-refund',
  requireRole('super_admin'),
  refundShot.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const num = (v: unknown) =>
        v === undefined || v === '' || v === null ? undefined : Number(v);
      const input = z
        .object({
          kind: z.enum(['refund', 'void']),
          reference: z.string().trim().max(40).optional().nullable(),
          refundDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          refundTime: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .default('12:00'),
          recipientName: z.string().trim().max(120).optional().nullable(),
          amountMinor: z.preprocess(num, z.number().int().positive().optional()),
          note: z.string().trim().min(3).max(500),
          newPeriodEnd: z.coerce.date().optional().nullable(),
        })
        .strict()
        .parse(req.body ?? {});
      const refundedAt = zonedLocalToUtc(input.refundDate, input.refundTime, REGION.timezone);
      if (!refundedAt) {
        res
          .status(400)
          .json({ success: false, error: { code: 'INVALID_DATE', message: 'Invalid date' } });
        return;
      }
      const out = await recordManualRefund({
        eventId: z.string().uuid().parse(req.params.id),
        kind: input.kind,
        reference: input.reference,
        refundedAt,
        recipientName: input.recipientName,
        amountMinor: input.amountMinor,
        note: input.note,
        newPeriodEnd: input.newPeriodEnd,
        screenshot: req.file?.buffer ?? null,
        actorId: req.user!.userId,
      });
      await auditLog({
        action: out.duplicate
          ? 'billing.manual_refund_replayed'
          : input.kind === 'void'
            ? 'billing.manual_payment_voided'
            : 'billing.manual_refund_recorded',
        userId: req.user!.userId,
        storeId: out.storeId,
        resourceType: 'billing_event',
        resourceId: req.params.id,
        details: {
          kind: input.kind,
          refundEventId: out.refundEventId,
          amountMinor: input.amountMinor ?? null,
          reference: input.reference ?? null,
          newPeriodEnd: out.periodEnd?.toISOString() ?? null,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(out.duplicate ? 200 : 201).json({ success: true, data: out });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/billing/events/:id/refund',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amountMinor } = z
        .object({ amountMinor: z.number().int().positive().optional() })
        .parse(req.body ?? {});
      const out = await refundCharge({ eventId: req.params.id, amountMinor });
      await auditLog({
        action: 'billing.refund',
        userId: req.user!.userId,
        resourceType: 'billing_event',
        resourceId: req.params.id,
        details: { amountMinor: amountMinor ?? null, status: out.status },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: out });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /admin/plans — every plan (incl. non-public) with subscriber counts.
 * PUT /admin/plans/:code — edit names, order, visibility, prices (null = not
 * set) and the limits JSON (validated by `planLimitsSchema`).
 * PUT /admin/stores/:id/subscription — put a store on a plan (e.g. `comped`).
 */
router.get(
  '/plans',
  requireRole('super_admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: { plans: await planService.listPlans() } });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/plans/:code',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = updatePlanSchema.parse(req.body);
      const plan = await planService.updatePlan(req.params.code, input);
      await auditLog({
        action: 'plan.updated',
        userId: req.user!.userId,
        resourceType: 'plan',
        resourceId: plan.code,
        details: { limits: plan.limits, isPublic: plan.isPublic },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { plan } });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/stores/:id/subscription',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = assignSubscriptionSchema.parse(req.body);
      const result = await planService.assignPlan(req.params.id, input);
      await auditLog({
        action: 'store.plan_assigned',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: req.params.id,
        details: { ...result },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: result });
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
      // NEON-ZERO (Ruling NZ-C-4): the store row is read and written through its own backend (DO / D1 directory), the
      // owner comes from the identity service; no Postgres `stores` read.
      const onHub = await hubOnD1();
      const before = onHub
        ? await (await storeDb(id)).store.findUnique({ where: { id }, select: { slug: true } })
        : await prisma.store.findUnique({
            where: { id },
            select: { slug: true },
          });

      const updated = await storeUpdate(prisma, {
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(slug !== undefined && { slug }),
          ...(plan !== undefined && { plan }),
          ...(status !== undefined && { status }),
        },
        ...(onHub
          ? {}
          : {
              include: {
                owner: {
                  select: { id: true, email: true, firstName: true, lastName: true },
                },
              },
            }),
      });
      const store = onHub
        ? { ...updated, owner: (await hubOwners([updated.ownerId])).get(updated.ownerId) ?? null }
        : updated;

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
      // Keep the subscription (limits) on the same plan the enum now names.
      if (plan !== undefined) {
        await withStore(store.id, tx => syncSubscriptionFromLegacyPlan(tx, store.id, plan));
        await featureService.invalidateCache(store.id);
      }
      await bustStoreCaches(store.id, store.slug, store.domain, { slug: before?.slug });
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
        data: { store: toSafeStoreResponse(store) },
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

      // NEON-ZERO (Ruling NZ-C-4): there is no users table to page. The directory is every store owner and staff member (D1)
      // read through the identity service, newest stores first, capped; a search / role filter runs over that capped set
      // and says so (`truncated`). Customers are never here (they live in their store's DO, see GET /admin/customers).
      if (await hubOnD1()) {
        const { ids, truncated } = await hubAccountIds([req.user!.userId]);
        const filtered = Boolean((role && role !== 'all') || search);
        const window = filtered ? ids : ids.slice(skip, skip + limit);
        const briefs = await getAccountsBrief(window);
        const needle = typeof search === 'string' ? search.toLowerCase() : '';
        const kept = briefs.filter(
          b =>
            (!role || role === 'all' || b.role === role) &&
            (!needle || `${b.email} ${b.firstName} ${b.lastName}`.toLowerCase().includes(needle))
        );
        const pageRows = filtered ? kept.slice(skip, skip + limit) : kept;
        const total = filtered ? kept.length : ids.length;
        // Customers live in their store's DO: a search (>= 3 chars) also fans out over the stores' customer directories.
        const wantsCustomers =
          typeof search === 'string' &&
          search.trim().length >= 3 &&
          (!role || role === 'all' || role === 'customer');
        const customerSearch = wantsCustomers
          ? await hubSearchCustomers(search as string)
          : { hits: [], truncated: false };
        res.json({
          success: true,
          data: {
            users: [
              ...(await hubUsers(role === 'customer' ? [] : pageRows)),
              ...customerSearch.hits.map(c => ({
                ...c,
                stores: [{ id: c.storeId, name: c.storeName, slug: '' }],
              })),
            ],
            pagination: {
              page,
              limit,
              total: total + customerSearch.hits.length,
              totalPages: Math.ceil((total + customerSearch.hits.length) / limit),
            },
            ...(truncated || customerSearch.truncated
              ? { truncated: true, cap: HUB_FANOUT_CAP }
              : {}),
          },
        });
        return;
      }

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
        asPlatformOperator(req.user!.userId, () =>
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
          })
        ),
        asPlatformOperator(req.user!.userId, () => prisma.user.count({ where })),
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
        /** Ignored: the invitee sets their own password from the mailed link (kept so older clients still validate). */
        password: z.string().min(8).max(255).optional(),
        // Platform administrators are operator-only (Ruling ID-12): this endpoint can only invite merchants.
        role: z.literal('store_admin'),
      });
      const data = schema.parse(req.body);
      const email = data.email.toLowerCase();

      // NEON-ZERO (Ruling NZ-C-4): the identity service is the only account store; `inviteIdentity` below answers "already
      // exists" itself, and there is no Postgres profile row to create.
      const onHub = await hubOnD1();
      const existing = onHub
        ? null
        : await asPlatformOperator(req.user!.userId, () =>
            prisma.user.findFirst({
              where: { email, storeId: null },
              select: { id: true },
            })
          );
      if (existing) {
        res.status(409).json({
          success: false,
          error: { code: 'EMAIL_TAKEN', message: 'An admin user with this email already exists' },
        });
        return;
      }

      // The identity service owns the credential: it creates an unverified account and mails the invitee a one-time code
      // to set their own password (Ruling ID-2). The Store keeps the profile row under the same id.
      const requestedInviteId = crypto.randomUUID();
      const invited = await inviteIdentity({
        id: requestedInviteId,
        email,
        firstName: data.firstName,
        lastName: data.lastName,
        role: 'store_admin',
        language: 'en',
      });
      if (!invited.created || invited.id !== requestedInviteId) {
        res.status(409).json({
          success: false,
          error: { code: 'EMAIL_TAKEN', message: 'An admin user with this email already exists' },
        });
        return;
      }
      const user = onHub
        ? {
            id: invited.id,
            email,
            firstName: data.firstName,
            lastName: data.lastName,
            role: 'store_admin' as const,
            status: 'active' as const,
            createdAt: new Date(),
            lastLoginAt: null,
            stores: [] as Array<{ id: string; name: string }>,
          }
        : await asPlatformOperator(req.user!.userId, () =>
            prisma.user.create({
              data: {
                id: invited.id,
                email,
                firstName: data.firstName,
                lastName: data.lastName,
                passwordHash: '!pending',
                role: UserRole.store_admin,
                status: 'active',
                emailVerified: false,
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
            })
          );

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

      const user = (await hubOnD1())
        ? ((await hubUsers(await getAccountsBrief([id])))[0] ?? null)
        : await asPlatformOperator(req.user!.userId, () =>
            prisma.user.findUnique({
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
            })
          );

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
        // N-9: names the store of a customer that exists only in its StoreDO (no Postgres row to find)
        storeId: z.string().uuid().optional(),
      });
      const data = schema.parse(req.body);

      // NEON-ZERO (Ruling NZ-C-4): with the platform families on D1 the account is the identity service's record
      // (customers are never reachable by id alone: they live in their store's DO and are edited from that store).
      const onHub = await hubOnD1();
      const existing: {
        id: string;
        email: string;
        role: string;
        status: string;
        storeId: string | null;
      } | null = onHub
        ? ((b: { id: string; email: string; role: string; status: string } | undefined) =>
            b ? { ...b, storeId: null } : null)((await getAccountsBrief([id]))[0])
        : await asPlatformOperator(req.user!.userId, () =>
            prisma.user.findUnique({ where: { id } })
          );
      if (!existing && data.storeId) {
        const doRoute = await customerAuthRoute(data.storeId, { write: true });
        const profile =
          doRoute.kind === 'do'
            ? await doRoute.client.call<Record<string, unknown> | null>('getProfile', {
                userId: id,
              })
            : null;
        if (doRoute.kind === 'do' && profile) {
          const other = Object.keys(data).filter(
            k => k !== 'status' && k !== 'storeId' && (data as never)[k] !== undefined
          );
          if (other.length > 0) {
            res.status(409).json({
              success: false,
              error: {
                code: 'CUSTOMER_ON_STORE_DO',
                message:
                  'This customer is served by its store: only the status can be changed here.',
              },
            });
            return;
          }
          if (data.status !== undefined) {
            await AuthService.setCustomerStatusOnDo(id, data.storeId, data.status);
            await auditLog({
              action: 'user.updated',
              userId: req.user!.userId,
              resourceType: 'user',
              resourceId: id,
              details: { changedFields: 'status', backend: 'store-do', status: data.status },
              ip: req.ip,
              userAgent: req.headers['user-agent'],
            });
          }
          res.json({
            success: true,
            data: { user: { ...profile, status: data.status ?? profile.status } },
          });
          return;
        }
      }
      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found' },
        });
        return;
      }

      // N-9: a customer of a store served by its StoreDO lives THERE (its Postgres row is a stale copy). Status goes to the DO,
      // where it revokes every session in the same section; every other field would only edit the stale copy, so it is refused.
      if (existing.role === 'customer' && existing.storeId) {
        const doRoute = await customerAuthRoute(existing.storeId, { write: true });
        if (doRoute.kind === 'do') {
          const other = Object.keys(data).filter(
            k => k !== 'status' && k !== 'storeId' && (data as never)[k] !== undefined
          );
          if (other.length > 0) {
            res.status(409).json({
              success: false,
              error: {
                code: 'CUSTOMER_ON_STORE_DO',
                message:
                  'This customer is served by its store: only the status can be changed here (it signs them out at once).',
              },
            });
            return;
          }
          if (data.status !== undefined) {
            await AuthService.setCustomerStatusOnDo(id, existing.storeId, data.status);
            await auditLog({
              action: 'user.updated',
              userId: req.user!.userId,
              resourceType: 'user',
              resourceId: id,
              details: {
                changedFields: 'status',
                transitions: { status: { from: existing.status, to: data.status } },
                backend: 'store-do',
              },
              ip: req.ip,
              userAgent: req.headers['user-agent'],
            });
          }
          const profile = await doRoute.client.call<Record<string, unknown> | null>('getProfile', {
            userId: id,
          });
          res.json({ success: true, data: { user: profile } });
          return;
        }
      }

      // Merchant, staff and super-admin accounts (users.store_id NULL) keep their credentials, email, role and status in the
      // shared identity service (Rulings ID-1/ID-2). The Store refuses to edit a credential or an email here (it would only
      // change a profile row the identity service ignores); status and role go to the identity service first.
      const identityManaged = existing.storeId === null && existing.role !== 'customer';
      if (
        identityManaged &&
        (data.password ||
          data.role === 'customer' ||
          (data.email && data.email.toLowerCase() !== existing.email.toLowerCase()))
      ) {
        // An e-mail is the recovery channel: changing another account's e-mail from an admin session (or a stolen one) and then
        // resetting the password is an account takeover. Only the verified self-service flow may change it (security review).
        if (data.email && data.email.toLowerCase() !== existing.email.toLowerCase()) {
          res.status(409).json({
            success: false,
            error: {
              code: 'EMAIL_CHANGE_SELF_SERVICE',
              message:
                'An account e-mail is changed by its owner through the verified flow that confirms the new address and notifies the old one.',
              messageEn:
                'An account e-mail is changed by its owner through the verified flow that confirms the new address and notifies the old one.',
              messageAr:
                'صاحب الحساب هو اللي بيغيّر بريده بنفسه من خطوات التحقق، وبتأكد البريد الجديد وتبلّغ البريد القديم.',
            },
          });
          return;
        }
        res.status(409).json({
          success: false,
          error: {
            code: 'MANAGED_BY_IDENTITY',
            message:
              'This account is managed by the sign-in service: use its password reset, not an admin edit, for the password.',
          },
        });
        return;
      }
      if (data.role === 'super_admin' && existing.role !== 'super_admin') {
        res.status(409).json({
          success: false,
          error: {
            code: 'OPERATOR_ONLY',
            message:
              'Platform administrators are granted by the platform operator, not through this endpoint.',
          },
        });
        return;
      }
      // Name and phone of an identity-managed account are the identity service's rows (never the e-mail, see above). A
      // super_admin target is editable only by that same user (the identity service enforces it too).
      if (
        onHub &&
        (data.firstName !== undefined || data.lastName !== undefined || data.phone !== undefined)
      ) {
        if (existing.role === 'super_admin' && id !== req.user!.userId) {
          res.status(403).json({
            success: false,
            error: {
              code: 'SUPER_ADMIN_SELF_ONLY',
              message: 'A platform administrator profile can only be edited by that administrator.',
            },
          });
          return;
        }
        const r = await updateIdentityProfile(
          id,
          { firstName: data.firstName, lastName: data.lastName, phone: data.phone },
          'admin-update',
          req.user!.userId
        );
        if (!r.ok) {
          const forbidden = r.code === 'FORBIDDEN_TARGET';
          res.status(forbidden ? 403 : 404).json({
            success: false,
            error: forbidden
              ? {
                  code: 'SUPER_ADMIN_SELF_ONLY',
                  message:
                    'A platform administrator profile can only be edited by that administrator.',
                }
              : { code: 'NOT_FOUND', message: 'User not found' },
          });
          return;
        }
      }
      if (identityManaged && data.status !== undefined && data.status !== existing.status) {
        await setAccountStatus(id, data.status, 'admin-update');
      }
      if (identityManaged && data.role !== undefined && data.role !== existing.role) {
        await setAccountRole(id, data.role as 'store_admin', 'admin-update');
      }

      // Email collision: if changing email, ensure no other user has it.
      if (!onHub && data.email && data.email.toLowerCase() !== existing.email.toLowerCase()) {
        const newEmail = data.email.toLowerCase();
        const collide = await asPlatformOperator(req.user!.userId, () =>
          prisma.user.findFirst({
            where: { email: newEmail, id: { not: id } },
            select: { id: true },
          })
        );
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

      const user = onHub
        ? ((await hubUsers(await getAccountsBrief([id])))[0] as NonNullable<
            Awaited<ReturnType<typeof hubUsers>>[number]
          >)
        : await asPlatformOperator(req.user!.userId, () =>
            prisma.user.update({
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
            })
          );

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
        if (onHub) {
          await revokeIdentityUser(id, 'admin-update');
          await revokeUserMerchantKeysD1(id, new Date());
        } else await AuthService.revokeAllSessions(id);
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

      // NEON-ZERO (Ruling NZ-C-4): the account is the identity service's; erasing it ends every session and passkey there, the
      // membership rows go from D1, and owned stores still block exactly as before. Deleting a super_admin is refused here (the
      // directory cannot count super_admins without a users table, and platform administrators are operator-only, Ruling ID-12).
      if (await hubOnD1()) {
        const acct = (await getAccountsBrief([id]))[0];
        if (!acct) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'User not found' },
          });
          return;
        }
        if (acct.role === 'super_admin') {
          res.status(409).json({
            success: false,
            error: {
              code: 'OPERATOR_ONLY',
              message:
                'Platform administrators are removed by the platform operator, not through this endpoint.',
            },
          });
          return;
        }
        const owned = (await hubOwnedStores([id])).get(id) ?? [];
        if (owned.length > 0) {
          res.status(409).json({
            success: false,
            error: {
              code: 'USER_OWNS_STORES',
              message: `User still owns ${owned.length} store(s) (${owned.map(s => s.name).join(', ')}). Reassign or delete those first.`,
            },
          });
          return;
        }
        await eraseIdentityUser(id);
        await eraseHubUserData({ userId: id, email: acct.email });
        await auditLog({
          action: 'user.deleted',
          userId: req.user!.userId,
          resourceType: 'user',
          resourceId: id,
          // no e-mail address: the audit row outlives the erasure it records
          details: { role: acct.role },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        res.json({ success: true, data: { message: 'User deleted' } });
        return;
      }

      const target = await asPlatformOperator(req.user!.userId, () =>
        prisma.user.findUnique({
          where: { id },
          select: {
            id: true,
            email: true,
            role: true,
            storeId: true,
            stores: { select: { id: true, name: true } },
          },
        })
      );
      // N-9: a customer that exists only in its StoreDO (?storeId=<store>) is erased there.
      const doStore = typeof req.query.storeId === 'string' ? req.query.storeId : null;
      if (!target && doStore && /^[0-9a-f-]{36}$/i.test(doStore)) {
        const doRoute = await customerAuthRoute(doStore, { write: true });
        if (doRoute.kind === 'do') {
          await AuthService.eraseAccount(id, { actorId: req.user!.userId, storeHint: doStore });
          await auditLog({
            action: 'user.deleted',
            userId: req.user!.userId,
            resourceType: 'user',
            resourceId: id,
            details: { role: 'customer', backend: 'store-do', storeId: doStore },
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });
          res.json({ success: true, data: { message: 'User deleted' } });
          return;
        }
      }
      if (!target) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'User not found' },
        });
        return;
      }

      if (target.role === 'super_admin') {
        const supers = await asPlatformOperator(req.user!.userId, () =>
          prisma.user.count({ where: { role: 'super_admin' } })
        );
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
      // through to withUser(req.user!.userId, tx => tx.user.delete()), which then violated stores_owner_id_fkey
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

      // N-9: a customer served by its StoreDO is erased there (store rows + auth rows + sessions), not hard-deleted from the stale
      // Postgres copy, which would leave the live account signing in.
      if (target.role === 'customer' && target.storeId) {
        const doRoute = await customerAuthRoute(target.storeId, { write: true });
        if (doRoute.kind === 'do') {
          await AuthService.eraseAccount(id, {
            actorId: req.user!.userId,
            storeHint: target.storeId,
          });
          await auditLog({
            action: 'user.deleted',
            userId: req.user!.userId,
            resourceType: 'user',
            resourceId: id,
            details: { email: target.email, role: target.role, backend: 'store-do' },
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });
          res.json({ success: true, data: { message: 'User deleted' } });
          return;
        }
      }

      // The identity is erased FIRST: its sessions, refresh tokens and passkeys go with it, so no token of this user can be
      // honoured again and the Store cannot re-create the profile row from it. If this fails the user still exists everywhere.
      if (target.storeId === null && target.role !== 'customer') await eraseIdentityUser(id);
      // After the `access` cutover the Postgres FK cascade no longer reaches the membership rows (they live in D1): an erased
      // user would keep holding a staff seat. Idempotent and verified; a failure stops here, before the Postgres delete.
      if (await onAccessD1()) await eraseHubUserData({ userId: id, email: target.email });

      // WA-CONSENT-1: withdraw the account's WhatsApp marketing consent before the hard delete.
      const doomed = await asPlatformOperator(req.user!.userId, () =>
        prisma.user.findUnique({ where: { id }, select: { storeId: true, phone: true } })
      );
      if (doomed?.storeId) await revokeForAccount(doomed.storeId, id, doomed.phone);
      try {
        await asPlatformOperator(req.user!.userId, () => prisma.user.delete({ where: { id } }));
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
      // a DO store's read client cannot join `store` (it lives in D1): the hub attaches the name afterwards
      const HUB_ON = await hubOnD1();
      // Store admins see only stats for the stores they own. Super admins
      // get the platform-wide aggregate.
      const ownerScope = ownerScopeForReq(req);
      const storeFilter: Prisma.StoreWhereInput = ownerScope ? { ownerId: ownerScope } : {};
      const orderFilter: Prisma.OrderWhereInput = ownerScope
        ? { store: { ownerId: ownerScope } }
        : {};

      // orders/customers are on RLS-protected tables, so the platform-wide
      // aggregate is assembled store by store (`acrossStores`: one short tenant
      // transaction per store) and merged here. A store admin's dashboard spans
      // only the stores they own.
      const dashboardStoreIds = await boundedFanoutStoreIds(await ownedStoreIds(ownerScope));
      // NEON-ZERO (Ruling NZ-C-4): store / account counts and the recent-stores card come from D1 + identity.
      const onHub = await hubOnD1();
      const [storeCount, userCount, orderTotals, recentStores, recentOrdersPage] =
        await Promise.all([
          onHub
            ? hubStorePage({ ownerId: ownerScope, skip: 0, take: 1 }).then(r => r.total)
            : prisma.store.count({ where: storeFilter }),
          // User count is platform-wide and only meaningful for super admins.
          // Store admins don't have access to the cross-tenant user table —
          // return 0 so the dashboard widget renders without leaking data.
          ownerScope
            ? Promise.resolve(0)
            : onHub
              ? hubAccountIds([req.user!.userId]).then(r => r.ids.length)
              : asPlatformOperator(req.user!.userId, () => prisma.user.count()),
          acrossStores(
            async storeId => {
              const [count, revenue] = await Promise.all([
                (await storeDb(storeId)).order.count({ where: { storeId } }),
                (await storeDb(storeId)).order.aggregate({
                  where: { storeId, paymentStatus: 'paid' },
                  _sum: { total: true },
                }),
              ]);
              return { count, revenue: revenue._sum.total ?? 0 };
            },
            { storeIds: dashboardStoreIds }
          ),
          onHub
            ? hubStorePage({ ownerId: ownerScope, skip: 0, take: 5 }).then(async r => {
                const owners = await hubOwners(r.rows.map(s => s.ownerId));
                return r.rows.map(s => ({
                  ...s,
                  owner: { email: owners.get(s.ownerId)?.email ?? '' },
                }));
              })
            : prisma.store.findMany({
                where: storeFilter,
                take: 5,
                orderBy: { createdAt: 'desc' },
                include: {
                  owner: { select: { email: true } },
                },
              }),
          pageAcrossStores({
            storeIds: dashboardStoreIds,
            skip: 0,
            take: 10,

            orderKey: (row: { createdAt: Date }) => row.createdAt,
            fetch: async window => ({
              rows: await (
                await storeDb(currentStoreId())
              ).order.findMany({
                where: { storeId: currentStoreId() },
                take: window,
                orderBy: { createdAt: 'desc' },
                include: {
                  ...(HUB_ON
                    ? {}
                    : { customer: { select: { email: true, firstName: true, lastName: true } } }),
                  ...(HUB_ON ? {} : { store: { select: { name: true } } }),
                },
              }),
              total: 0,
            }),
          }),
        ]);
      // Super-admin only: signups that came through the store badge / referral email (UTM first touch).
      const referrals =
        ownerScope || onHub
          ? null
          : await asPlatformOperator(req.user!.userId, () => referralSignupCounts());
      const orderCount = orderTotals.reduce((n, r) => n + r.value.count, 0);
      const revenueResult = {
        _sum: { total: orderTotals.reduce((n, r) => n + r.value.revenue, 0) },
      };
      const recentOrders = await attachCustomerRel(
        await attachStoreRel(recentOrdersPage.rows, HUB_ON),
        HUB_ON
      );

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
          referrals,
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
      // a DO store's read client cannot join `store` (it lives in D1): the hub attaches the name afterwards
      const HUB_ON = await hubOnD1();
      const { page: pageStr, limit: limitStr, storeId, status, search } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.ProductWhereInput = {};
      if (status) where.status = status as ProductStatus;

      // products is RLS-protected; this is a cross-store super-admin list, so it
      // is read store by store and merged (see lib/cross-store.ts). The `storeId`
      // query filter narrows which stores are visited.
      const { rows: productRows, total } = await pageAcrossStores({
        storeIds: storeIdsFromFilter(storeId),
        skip,
        take: limit,

        orderKey: (row: { createdAt: Date }) => row.createdAt,
        fetch: async window => {
          const sid = currentStoreId();
          const scoped: Prisma.ProductWhereInput = { ...where, storeId: sid };
          // Arabic-normalised names/terms/descriptions + SKU, per visited store. Capped at the
          // closest 1,000 matches PER STORE, not surfaced: no admin UI consumes this route
          // (Ruling SEARCH-T3-6). pageAcrossStores calls fetch once per store (cross-store.ts).
          if (search) {
            scoped.id = {
              in: await searchProductIds(sid, search as string, {
                scope: 'admin',
                includeDeleted: true,
              }),
            };
          }
          const [rows, count] = await Promise.all([
            (await storeDb(sid)).product.findMany({
              where: scoped,
              take: window,
              orderBy: { createdAt: 'desc' },
              include: {
                ...(HUB_ON ? {} : { store: { select: { id: true, name: true } } }),
                images: { take: 1 },
              },
            }),
            (await storeDb(sid)).product.count({ where: scoped }),
          ]);
          return { rows, total: count };
        },
      });

      res.json({
        success: true,
        data: {
          products: await attachStoreRel(productRows, HUB_ON),
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
      // a DO store's read client cannot join `store` (it lives in D1): the hub attaches the name afterwards
      const HUB_ON = await hubOnD1();
      const { id } = req.params;

      // products is RLS-protected and the id alone does not say which store owns
      // it: a definer (`ebda_entity_store_id`, exact primary-key match, store id
      // only) finds the store, and the read runs in that store's scope.
      // NEON-ZERO (Ruling NZ-C-4): D1 has no product index, so on the hub the owning store is found by a bounded fan-out of
      // primary-key reads over the capped store list (a rare, human-driven lookup).
      const productStoreId = (await hubOnD1())
        ? await findProductStoreOnHub(id)
        : await getEntityStoreId('product', id);
      const product = productStoreId
        ? await (
            await storeDb(productStoreId)
          ).product.findUnique({
            where: { id, storeId: productStoreId },
            include: {
              ...(HUB_ON ? {} : { store: { select: { id: true, name: true, slug: true } } }),
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
        : null;

      if (!product) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Product not found' },
        });
        return;
      }

      // Transform categories to flat array
      const transformedProduct = {
        ...(HUB_ON ? (await attachStoreRel([product], true))[0] : product),
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
      // a DO store's read client cannot join `store` (it lives in D1): the hub attaches the name afterwards
      const HUB_ON = await hubOnD1();
      const { page: pageStr, limit: limitStr, storeId, status, paymentStatus } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.OrderWhereInput = {};
      if (status) where.status = status as OrderStatus;
      if (paymentStatus) where.paymentStatus = paymentStatus as OrderPaymentStatus;

      // orders is RLS-protected; this is a cross-store super-admin list, read
      // store by store and merged (see lib/cross-store.ts).
      const { rows: orderRows, total } = await pageAcrossStores({
        storeIds: storeIdsFromFilter(storeId),
        skip,
        take: limit,

        orderKey: (row: { createdAt: Date }) => row.createdAt,
        fetch: async window => {
          const scoped: Prisma.OrderWhereInput = { ...where, storeId: currentStoreId() };
          const [rows, count] = await Promise.all([
            (await storeDb(currentStoreId())).order.findMany({
              where: scoped,
              take: window,
              orderBy: { createdAt: 'desc' },
              include: {
                ...(HUB_ON ? {} : { store: { select: { id: true, name: true } } }),
                ...(HUB_ON
                  ? {}
                  : {
                      customer: {
                        select: { id: true, email: true, firstName: true, lastName: true },
                      },
                    }),
                items: { take: 3 },
              },
            }),
            (await storeDb(currentStoreId())).order.count({ where: scoped }),
          ]);
          return { rows, total: count };
        },
      });

      res.json({
        success: true,
        data: {
          orders: await attachCustomerRel(await attachStoreRel(orderRows, HUB_ON), HUB_ON),
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
      // a DO store's read client cannot join `store` (it lives in D1): the hub attaches the name afterwards
      const HUB_ON = await hubOnD1();
      const { page: pageStr, limit: limitStr, storeId, search } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      const where: Prisma.CustomerWhereInput = {};
      if (search) {
        where.OR = [
          { email: { contains: search as string, mode: 'insensitive' } },
          { firstName: { contains: search as string, mode: 'insensitive' } },
          { lastName: { contains: search as string, mode: 'insensitive' } },
        ];
      }

      // customers is RLS-protected; this is a cross-store super-admin list, read
      // store by store and merged (see lib/cross-store.ts).
      const { rows: customerRows, total } = await pageAcrossStores({
        storeIds: storeIdsFromFilter(storeId),
        skip,
        take: limit,

        orderKey: (row: { createdAt: Date }) => row.createdAt,
        fetch: async window => {
          const scoped: Prisma.CustomerWhereInput = { ...where, storeId: currentStoreId() };
          const [rows, count] = await Promise.all([
            (await storeDb(currentStoreId())).customer.findMany({
              where: scoped,
              take: window,
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
                storeId: true,
                ...(HUB_ON ? {} : { store: { select: { id: true, name: true } } }),
              },
            }),
            (await storeDb(currentStoreId())).customer.count({ where: scoped }),
          ]);
          return { rows, total: count };
        },
      });

      res.json({
        success: true,
        data: {
          customers: await attachStoreRel(customerRows, HUB_ON),
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
      const { page: pageStr, limit: limitStr, action, userId, resourceType, storeId } = req.query;
      const { page, limit, skip } = parsePagination(pageStr, limitStr);

      // audit_logs is store-scoped under RLS and also holds platform events with
      // NO store (login failures, user management, impersonation). The
      // cross-store viewer is therefore a definer that checks the actor is an
      // active super_admin and leaves its own audit row.
      const { rows: logs, total } = await platformAuditLogs.list({
        actorUserId: req.user!.userId,
        action: typeof action === 'string' && action ? action : undefined,
        userId: typeof userId === 'string' && userId ? userId : undefined,
        resourceType: typeof resourceType === 'string' && resourceType ? resourceType : undefined,
        storeId: typeof storeId === 'string' && storeId ? storeId : undefined,
        limit,
        offset: skip,
      });

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

      // aiUsage has RLS: aggregate store by store (`acrossStores`, one short tenant
      // transaction each) and merge the per-store partials.
      const result = await (async () => {
        const perStoreFn = async (storeId: string) => {
          const [today, month, cached] = await Promise.all([
            prisma.aiUsage.count({
              where: { storeId, createdAt: { gte: startOfDay }, cachedHit: false },
            }),
            prisma.aiUsage.count({
              where: { storeId, createdAt: { gte: startOfMonth }, cachedHit: false },
            }),
            prisma.aiUsage.count({
              where: { storeId, createdAt: { gte: startOfMonth }, cachedHit: true },
            }),
          ]);
          // Per-store aggregations: today count, month count, last call, feature breakdown. No raw SQL (Ruling NZ-AN-1): the
          // model router serves D1 or Postgres. SUM ignores NULLs, so unpriced rows do not silently contribute 0 - they are
          // counted separately and surfaced in the UI ("no rate configured" and "free" are different facts; ai-pricing.ts).
          const features = await aiUsageFeatureStats(storeId, startOfDay, startOfMonth);
          const stats = features.map(f => ({
            store_id: storeId,
            today_count: f.todayCount,
            month_count: f.monthCount,
            last_call_at: f.lastCallAt,
            feature: f.feature,
            feature_count: f.featureCount,
            month_cost_micros: f.monthCostMicros,
            month_unpriced: f.monthUnpriced,
          }));
          return { today, month, cached, stats };
        };
        const storeIdsForAi = await boundedFanoutStoreIds();
        // `ai_usage` on D1 has no RLS: one plain pass, no Postgres transaction per store. Before the cutover it is store by store
        // (`acrossStores`, one short tenant transaction each) because the Postgres table is strict-RLS.
        const perStore = (await platformFamilyOnD1('ai-usage'))
          ? await (async () => {
              // bounded concurrency: 500 stores x 8 statements at once would queue behind D1's single writer thread
              const out: Array<{ storeId: string; value: Awaited<ReturnType<typeof perStoreFn>> }> =
                [];
              let next = 0;
              await Promise.all(
                Array.from({ length: 6 }, async () => {
                  while (next < storeIdsForAi.length) {
                    const storeId = storeIdsForAi[next++];
                    out.push({ storeId, value: await perStoreFn(storeId) });
                  }
                })
              );
              return out;
            })()
          : await acrossStores(perStoreFn, { storeIds: storeIdsForAi });
        const platformToday = perStore.reduce((n, p) => n + p.value.today, 0);
        const platformMonth = perStore.reduce((n, p) => n + p.value.month, 0);
        const platformCached = perStore.reduce((n, p) => n + p.value.cached, 0);
        const platformUncached = platformMonth;
        const totalCalls = platformCached + platformUncached;
        const cacheHitRatio = totalCalls > 0 ? platformCached / totalCalls : 0;
        const storeStats = perStore.flatMap(p => p.value.stats);

        // Fetch store metadata for all referenced storeIds
        const storeIds = [...new Set(storeStats.map(r => r.store_id))];

        const stores = (await hubOnD1())
          ? await hubStoresById(storeIds)
          : await prisma.store.findMany({
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
      })();

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Every snapshot row of the newest `months` distinct periods (issue 2329).
 *
 * The period pick is a `groupBy`, which Postgres evaluates as a
 * GROUP BY … ORDER BY … LIMIT. The previous `findMany({ distinct, take })`
 * returned ONE period for months=3 over 3 stores × 3 months — reproduced on
 * Postgres (tests/integration/usage-history-periods.test.ts): Prisma's
 * in-memory `distinct` over this `@db.Date` column did not collapse the
 * newest month's rows, so the viewer showed one period as the whole history.
 * (A string-key sibling — the warehouse backfill's `distinct` + `skip` /
 * `take` over 240 rows — was checked the same way and pages correctly.)
 */
export async function loadUsageHistoryRows(
  tx: Prisma.TransactionClient,
  months: number,
  // The store being read. `acrossStores` always passes it; only the owner-role
  // integration test (RLS bypassed, every store at once) calls without.
  storeId?: string
) {
  const storeFilter = storeId ? { storeId } : {};
  const periods = await tx.storeUsageSnapshot.groupBy({
    by: ['periodStart'],
    where: storeFilter,
    orderBy: { periodStart: 'desc' },
    take: months,
  });
  if (periods.length === 0) return [];
  return tx.storeUsageSnapshot.findMany({
    where: { ...storeFilter, periodStart: { in: periods.map(p => p.periodStart) } },
    orderBy: [{ periodStart: 'desc' }],
    include: { store: { select: { slug: true, name: true, plan: true } } },
  });
}

/**
 * `loadUsageHistoryRows` across every store: each store's newest `months`
 * periods are read in its own tenant transaction, then the newest `months`
 * DISTINCT periods of the union are kept (a store's rows inside the global top
 * `months` are always inside that store's own top `months`).
 */
export async function loadUsageHistoryRowsAcrossStores(months: number) {
  // `store_usage_snapshots` is on D1 once the `ai-usage` family moved (Ruling NZ-INTEG-1): one global read, no per-store Postgres
  // transaction. The routed delegate has no `include`, so the store's slug / name / plan come from the D1 directory.
  if (await platformFamilyOnD1('ai-usage')) {
    const d1db = await requirePlatformDb(); // D1 has no RLS: the platform client directly, no store scope to open
    const periods: Array<{ periodStart: Date }> = await d1db.storeUsageSnapshot.groupBy({
      by: ['periodStart'],
      orderBy: { periodStart: 'desc' },
      take: months,
    });
    if (periods.length === 0) return [];
    const snaps: Awaited<ReturnType<typeof loadUsageHistoryRows>> =
      await d1db.storeUsageSnapshot.findMany({
        where: { periodStart: { in: periods.map(p => p.periodStart) } },
        orderBy: [{ periodStart: 'desc' }],
      });
    const d1 = platformDirectoryDb();
    const briefs = new Map(
      (d1
        ? await d1StoreBriefs(
            d1,
            snaps.map(r => r.storeId)
          )
        : []
      ).map(b => [b.id, b])
    );
    return snaps.map(r => ({
      ...r,
      store: briefs.has(r.storeId)
        ? {
            slug: briefs.get(r.storeId)!.slug,
            name: briefs.get(r.storeId)!.name,
            plan: briefs.get(r.storeId)!.plan,
          }
        : null,
    }));
  }
  const perStore = await acrossStores(
    storeId => loadUsageHistoryRows(prisma as unknown as Prisma.TransactionClient, months, storeId),
    { storeIds: await boundedFanoutStoreIds() }
  );
  const rows = perStore.flatMap(p => p.value);
  const keep = new Set(
    [...new Set(rows.map(r => r.periodStart.getTime()))].sort((a, b) => b - a).slice(0, months)
  );
  return rows
    .filter(r => keep.has(r.periodStart.getTime()))
    .sort((a, b) => b.periodStart.getTime() - a.periodStart.getTime());
}

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

      // Cross-tenant by nature — read store by store, same as the ai-usage summary.
      //
      // Paged by PERIOD, not by a flat row budget (PR 2301 audit): the old
      // `take: months * 200` let the newest months consume the whole budget on
      // a platform past 200 stores, so older months came back silently partial
      // while the viewer rendered them as complete. Pick the newest `months`
      // distinct periods first, then read every row of those periods.
      const rows = await loadUsageHistoryRowsAcrossStores(months);

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
// @ebda/shared — single canonical implementation across every exporter.

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
const exportOrdersQuery = z.object({
  storeId: z.string().uuid().optional(),
  status: z.nativeEnum(OrderStatus).optional(),
  paymentStatus: z.nativeEnum(OrderPaymentStatus).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

router.get(
  '/export/orders',
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // a DO store's read client cannot join `store` (it lives in D1): the hub attaches the name afterwards
      const HUB_ON = await hubOnD1();
      // BE:S-21: every filter is validated; an unknown status / unparseable date used to reach Prisma (or `new Date(...)`) and 500.
      const { storeId, status, paymentStatus, from, to } = exportOrdersQuery.parse(req.query);

      const where: Prisma.OrderWhereInput = {};
      if (status) where.status = status;
      if (paymentStatus) where.paymentStatus = paymentStatus;
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = from;
        if (to) where.createdAt.lte = to;
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

      let totalRows = 0;

      // Store by store, each chunk in its own short tenant transaction: the
      // cursor loop fetches one page, streams it to the response, then closes the
      // transaction, which keeps lifetimes <1s even on large exports (a single
      // long one would blow the 30s budget).
      const exportStoreIds =
        storeIdsFromFilter(storeId) ??
        ((await hubOnD1())
          ? (await hubFanoutStoreIds()).ids
          : (await prisma.store.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map(
              st => st.id
            ));
      for (const exportStoreId of exportStoreIds) {
        let cursor: string | undefined;
        while (true) {
          const rows = await (
            await storeDb(exportStoreId)
          ).order.findMany({
            where: { ...where, storeId: exportStoreId },
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
              ...(HUB_ON ? {} : { store: { select: { name: true } } }),
              ...(HUB_ON
                ? { customerId: true }
                : { customer: { select: { email: true, firstName: true, lastName: true } } }),
            },
          });

          if (rows.length === 0) break;
          const rowsWithStore = await attachCustomerRel(await attachStoreRel(rows, HUB_ON), HUB_ON);

          // Build and flush this chunk to the TCP buffer
          const chunk = rowsWithStore
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
                csvField(
                  o.customer ? `${o.customer.firstName} ${o.customer.lastName}`.trim() : null
                ),
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
      // a DO store's read client cannot join `store` (it lives in D1): the hub attaches the name afterwards
      const HUB_ON = await hubOnD1();
      const { storeId, status, paymentStatus, from, to } = req.query;

      const where: Prisma.OrderWhereInput = {};
      if (status) where.status = status as OrderStatus;
      if (paymentStatus) where.paymentStatus = paymentStatus as OrderPaymentStatus;
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from as string);
        if (to) where.createdAt.lte = new Date(to as string);
      }

      // Per store (each in its own tenant transaction), merged oldest-first and
      // cut to the same 50 000-row ceiling as before.
      const orders = (
        await acrossStoresFlat(
          async sid =>
            (await storeDb(sid)).order.findMany({
              where: { ...where, storeId: sid },
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
                ...(HUB_ON ? {} : { store: { select: { name: true } } }),
                ...(HUB_ON
                  ? { customerId: true }
                  : { customer: { select: { email: true, firstName: true, lastName: true } } }),
              },
            }),
          {
            // the cap is the hub's (D1 list); off the hub no filter still means every store, as before
            storeIds:
              storeIdsFromFilter(storeId) ??
              ((await hubOnD1()) ? await boundedFanoutStoreIds() : undefined),
          }
        )
      )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, 50000);

      const rows = (await attachCustomerRel(await attachStoreRel(orders, HUB_ON), HUB_ON)).map(
        o => {
          const addr = o.shippingAddress as Record<string, string> | null;
          return {
            orderNumber: o.orderNumber ?? '',
            storeId: o.storeId,
            storeName: o.store?.name ?? '',
            status: o.status,
            paymentStatus: o.paymentStatus,
            total: fromMinor(o.total),
            customerEmail: o.customer?.email ?? '',
            customerName: o.customer ? `${o.customer.firstName} ${o.customer.lastName}`.trim() : '',
            shippingCountry: addr?.country ?? '',
            shippingCity: addr?.city ?? '',
            shippingArea: addr?.area ?? '',
            createdAt: o.createdAt.toISOString(),
          };
        }
      );

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
          {
            header: 'Total (EGP)',
            key: 'total',
            width: 14,
            numFmt: excelMoneyFormat({ grouped: true }),
          },
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

      // users table has no RLS — plain lookup works under ebda_app without bypass.
      // We intentionally leave this as-is: adding withRlsBypass here would be
      // over-engineering (the policy doesn't exist) and would waste a tx slot.
      // Ruling NZ-PG-2: once the `access` family is on D1 the account is the identity service's (or its store's DO for a
      // customer); the Postgres `users` row no longer exists.
      const target = (await onAccessD1())
        ? await impersonationTargetD1(userId)
        : await asPlatformOperator(req.user!.userId, () =>
            prisma.user.findUnique({
              where: { id: userId },
              select: {
                id: true,
                email: true,
                role: true,
                storeId: true,
                deletedAt: true,
                tokenVersion: true,
                status: true,
              },
            })
          );

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

      // A suspended or deactivated account must not be re-entered through an impersonation token (the Store row, and for an
      // identity-managed account also the identity service, which is the source of truth for status).
      let targetStatus: string = target.status;
      if (target.storeId === null && target.role !== 'customer') {
        const acc = await getAccountState(target.id);
        if (acc) targetStatus = acc.status === 'active' ? targetStatus : acc.status;
      }
      if (targetStatus !== 'active') {
        res.status(403).json({
          success: false,
          error: { code: 'ACCOUNT_SUSPENDED', message: 'Cannot impersonate an inactive account' },
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
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
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
      // The inbox spans every store (and holds NULL-store rows), so the viewer is
      // a definer that checks the actor is an active super_admin and audits the read.
      const { events, total } = await webhookInbox.adminList({
        actorUserId: req.user!.userId,
        status: typeof status === 'string' && status ? status : undefined,
        provider: typeof provider === 'string' && provider ? provider : undefined,
        limit,
        offset: skip,
      });
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

const webhookReplayParams = z.object({ id: z.string().uuid() });
const webhookReplayBody = z.object({ force: z.boolean().optional() });

router.post(
  '/webhook-events/:id/replay',
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // BE:S-32: a non-uuid id / non-boolean force is a 400, not a database error.
      const { id } = webhookReplayParams.parse(req.params);
      const force =
        webhookReplayBody.parse(req.body ?? {}).force === true || req.query.force === 'true';
      const row = await webhookInbox.get(id);
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
      await webhookInbox.update(id, { requeue: true });
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
      const [emails, stats, corrupt] = await Promise.all([
        emailQueue.getFailedEmails(limit),
        emailQueue.getStats(),
        emailQueue.getCorruptEntries(50),
      ]);
      res.json({
        success: true,
        data: {
          // Redis down → the counts are UNKNOWN, not zero (the page renders
          // "Queue status unknown" for null).
          stats: redis.isAvailable()
            ? { pending: stats.pending, failed: stats.failed, corrupt: stats.corrupt }
            : null,
          // Issue 2353: the unreadable set-aside entries — size only (they
          // cannot be parsed, so nothing can be masked; no payload returned).
          corrupt,
          // `getFailedEmails` returns only entries that pass `isQueuedEmail`
          // (issue 2374); the optional chains are the second net, so one bad
          // row can never 500 the whole list and lock the operator out.
          emails: emails.map(e => ({
            id: e.id,
            storeId: e.storeId ?? null,
            to: (Array.isArray(e.options?.to) ? e.options.to : [e.options?.to]).map(maskEmail),
            subject: e.options?.subject ?? '',
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
      const { retried, skipped, kept } = await emailQueue.retryFailed();
      await auditLog({
        action: 'email_queue.retry_failed',
        userId: req.user!.userId,
        resourceType: 'setting',
        resourceId: 'email:failed',
        details: { retried, skipped, kept },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { retried, skipped, kept } });
    } catch (err) {
      next(err);
    }
  }
);

// Issue 2353: the only drain for `email:failed:corrupt` besides its 30-day
// expiry. Those entries cannot be parsed, so they cannot be replayed.
router.post(
  '/email-queue/corrupt/discard',
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const discarded = await emailQueue.discardCorrupt();
      await auditLog({
        action: 'email_queue.discard_corrupt',
        userId: req.user!.userId,
        resourceType: 'setting',
        resourceId: 'email:failed:corrupt',
        details: { discarded },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { discarded } });
    } catch (err) {
      next(err);
    }
  }
);

// ── SMS queue dead-letter — super-admin observability + replay (issue 2363) ──
// The twin of the email-queue handlers above. An SMS that fails every attempt
// lands in the Redis list `sms:failed`; before this, that list had no viewer,
// no replay and no discard (the only drain was `railway connect Redis`). The
// recipient number is masked; the message text is never returned.
router.get(
  '/sms-queue/failed',
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100) || 100));
      const [messages, stats, corrupt] = await Promise.all([
        smsQueue.getFailedMessages(limit),
        smsQueue.getStats(),
        smsQueue.getCorruptEntries(50),
      ]);
      res.json({
        success: true,
        data: {
          stats: redis.isAvailable()
            ? { pending: stats.pending, failed: stats.failed, corrupt: stats.corrupt }
            : null,
          corrupt,
          messages: messages.map(m => ({
            id: m.id,
            storeId: m.storeId ?? null,
            event: m.event ?? null,
            to: maskPhone(m.recipientPhone),
            attempts: m.attempts,
            error: m.error ?? null,
            createdAt: m.createdAt,
            lastAttempt: m.lastAttempt ?? null,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/sms-queue/failed/retry',
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { retried, skipped, kept } = await smsQueue.retryFailed();
      await auditLog({
        action: 'sms_queue.retry_failed',
        userId: req.user!.userId,
        resourceType: 'setting',
        resourceId: 'sms:failed',
        details: { retried, skipped, kept },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { retried, skipped, kept } });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/sms-queue/corrupt/discard',
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const discarded = await smsQueue.discardCorrupt();
      await auditLog({
        action: 'sms_queue.discard_corrupt',
        userId: req.user!.userId,
        resourceType: 'setting',
        resourceId: 'sms:failed:corrupt',
        details: { discarded },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { discarded } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
