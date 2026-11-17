import { upgradePlanFor } from '@ebda/shared';
import { Request, Response, NextFunction } from 'express';
import { withStore, type Prisma } from '@ebda/database';
import { AppError } from './error-handler';
import { auditLog } from './security';
import { gateRead, onAccessD1 } from '../services/platform/access-d1';
import { sendOnboardingHelpToCi } from '../lib/ci/emit';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];
/**
 * The ONE place that knows which paths are the store's billing routes (Ruling TEN-6: it was an unanchored `/billing(/|$)` that
 * matched any segment, so `/stores/:id/products/billing` slipped the over-limit gate). Anchored at the `/stores/:id/billing`
 * mount (case-insensitive, like Express routing).
 */
const BILLING_ROUTE_RE = /^(?:\/api\/v\d+)?\/stores\/[^/]+\/billing(?:\/|$)/i;
// pq-allow(unused-export): exported for unit tests
export function isStoreBillingRoute(path: string): boolean {
  return BILLING_ROUTE_RE.test(path);
}

/**
 * A suspended store's owner must always be able to ask for it back (#804): the suspension appeal and a support request are
 * the way out of a suspension, so no suspension (platform or billing) refuses them here. The appeal route itself decides
 * what can be appealed (a billing suspension is settled on the Billing page, 409), and the over-limit 402 is decided before.
 */
const STORE_SUPPORT_RE =
  /^(?:\/api\/v\d+)?\/stores\/[^/]+\/(?:suspension\/appeal|support-requests)\/?$/i;
// pq-allow(unused-export): exported for unit tests
export function isStoreSupportRoute(method: string, path: string): boolean {
  return method.toUpperCase() === 'POST' && STORE_SUPPORT_RE.test(path);
}

/**
 * Ruling SUSPEND-REFUND-1: a suspension never strands a CUSTOMER's money. The routes that send money back to customers (a
 * refund, recording or settling one, cancelling an order) stay open during a BILLING suspension (unpaid, over limit); a
 * PLATFORM suspension (abuse / fraud) blocks them for the merchant, and a super admin refunds on the store's behalf
 * through POST /payments/refund with a reason. Anchored at the order mount; the status route counts only for a cancel or
 * a refund in the body.
 */
const ORDER_MONEY_BACK_RE =
  /^(?:\/api\/v\d+)?\/stores\/[^/]+\/orders\/[^/]+\/(?:refund-via-provider|instapay-refund|refund-match-claim|refresh-refund-status)\/?$/i;
const ORDER_STATUS_RE = /^(?:\/api\/v\d+)?\/stores\/[^/]+\/orders\/[^/]+\/status\/?$/i;
// pq-allow(unused-export): exported for unit tests
export function isCustomerMoneyBackRoute(method: string, path: string, body?: unknown): boolean {
  const m = method.toUpperCase();
  if (m === 'POST' && ORDER_MONEY_BACK_RE.test(path)) return true;
  if (m === 'PUT' && ORDER_STATUS_RE.test(path)) {
    const status = (body as { status?: unknown } | undefined)?.status;
    return status === 'cancelled' || status === 'refunded';
  }
  return false;
}

// pq-allow(unused-export): exported for unit tests
export const STORE_SUSPENDED_MESSAGES = {
  /** Suspended by the platform (no billing reason): nothing but reads. */
  platform: {
    en: 'This store is suspended, so you can view your data but not change anything. Contact support to bring it back.',
    ar: 'المتجر ده موقوف دلوقتي، فتقدر تشوف بياناتك بس ومش هتقدر تعدّل أي حاجة. كلّم الدعم عشان نرجّعه تاني.',
  },
  /** Suspended for a billing reason: reads plus billing, so the owner can pay. */
  billing: {
    en: 'This store is suspended over billing, so you can view your data but not change anything. Settle your subscription from the Billing page to bring it back.',
    ar: 'المتجر ده موقوف بسبب الاشتراك، فتقدر تشوف بياناتك بس ومش هتقدر تعدّل أي حاجة. جدّد اشتراكك من صفحة الفواتير عشان المتجر يرجع يشتغل تاني.',
  },
} as const;

/**
 * Ruling TEN-1 (live state beats token claims, ebda-foundation PR #28): a merchant/staff token is minted while the store is
 * live and stays valid for hours, so suspension is read from the store row on EVERY request. A `suspended` store is READ-ONLY
 * for everyone but a super-admin: every write is refused 403 STORE_SUSPENDED. Exception: with a billing reason
 * (`billingSuspendedReason` set: unpaid, over_store_limit) the billing routes stay open so the owner can pay.
 * `over_store_limit` keeps its own 402 upsell, decided before this. Returns the error to throw, or null.
 */
// pq-allow(unused-export): exported for unit tests
export function suspendedWriteBlock(
  store: { status: string; billingSuspendedReason?: string | null },
  role: string,
  method: string,
  fullPath: string,
  /** The request body: a status change counts as money back only for a cancel or a refund (SUSPEND-REFUND-1). */
  body?: unknown,
  /** The caller IS a customer-money-back action (POST /payments/refund), whatever its path. */
  moneyBack = false
): AppError | null {
  if (role === 'super_admin' || store.status !== 'suspended') return null;
  if (READ_METHODS.includes(method.toUpperCase())) return null;
  if (isStoreSupportRoute(method, fullPath)) return null;
  const billingReason = store.billingSuspendedReason ?? null;
  if (billingReason && isStoreBillingRoute(fullPath)) return null;
  // SUSPEND-REFUND-1: a billing suspension never blocks money going back to customers.
  if (billingReason && (moneyBack || isCustomerMoneyBackRoute(method, fullPath, body))) return null;
  const m = billingReason ? STORE_SUSPENDED_MESSAGES.billing : STORE_SUSPENDED_MESSAGES.platform;
  return new AppError(403, 'STORE_SUSPENDED', m.en, {
    reason: billingReason ?? 'platform',
    messageEn: m.en,
    messageAr: m.ar,
  });
}

/** The store row an access check decides on, read in that store's own scope; null if none. */
async function readStoreForAccess<S extends Prisma.StoreSelect>(storeId: string, select: S) {
  if (!UUID_RE.test(storeId)) return null;
  return withStore(storeId, tx => tx.store.findUnique({ where: { id: storeId }, select }));
}

/**
 * NEON-ZERO-1 (N-6): once the `access` family is on D1 the whole decision input (store row + this user's membership) is ONE
 * D1 read, memoised for the request. Before the cutover: the Postgres reads above, unchanged. NEVER cached across requests
 * (access is a permission: see services/platform/access-d1.ts).
 */
type Gate = Awaited<ReturnType<typeof gateRead>>;
const requestMemo = new WeakMap<object, Map<string, Gate>>();
/** Keyed by store AND user: a request that touches two stores (or acts as two users) must never reuse the other's answer. */
async function gateForRequest(req: Request, storeId: string, userId: string): Promise<Gate> {
  let m = requestMemo.get(req);
  if (!m) requestMemo.set(req, (m = new Map()));
  const k = `${storeId}:${userId}`;
  if (m.has(k)) return m.get(k) as Gate;
  const g = await gateRead(storeId, userId); // resolved value shared, never the promise (workerd)
  m.set(k, g);
  return g;
}

/**
 * Store Access Control Middleware
 *
 * Validates that the authenticated user has permission to access the requested store.
 * - super_admin: Can access any store (with audit logging)
 * - store_admin: Can only access stores they own
 * - customer: Cannot access store admin routes
 */
export async function requireStoreAccess(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Param precedence MATTERS. Nested routers (e.g. productRoutes mounted
    // at `/stores/:storeId/products`) propagate the parent `:storeId` AND
    // expose the nested `:id` as the productId. Reading `req.params.id`
    // first looks up `Store.findUnique({ id: <productId> })`, which always
    // returns null and throws "Store not found" 404 — masking real product
    // updates as a phantom storefront 404. Always prefer the unambiguous
    // `:storeId` param; fall back to `:id` only for top-level
    // `/stores/:id/...` routes that don't have a nested entity.
    const storeId = req.params.storeId || req.params.id;
    const user = req.user;

    if (!user) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!storeId) {
      throw new AppError(400, 'MISSING_STORE_ID', 'Store ID is required');
    }

    // Validate store exists. `stores` is under RLS (R-EBDA-005): the row this check
    // decides on is read inside THAT store's scope (like the staff membership below);
    // the access decision itself is made here, from ownerId / role / membership.
    const onD1 = UUID_RE.test(storeId) && (await onAccessD1());
    const d1Gate = onD1 ? await gateForRequest(req, storeId, user.userId) : null;
    const store = onD1
      ? (d1Gate?.store ?? null)
      : await readStoreForAccess(storeId, {
          id: true,
          ownerId: true,
          name: true,
          status: true,
          billingSuspendedReason: true,
        });

    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
    }

    // A store beyond the owner's plan allowance is READ-ONLY for the merchant
    // (Ruling EBDA-FUNNEL-10): every write but billing (where they upgrade) is
    // refused with an upsell. Super-admins are not bound (operator override).
    if (
      user.role !== 'super_admin' &&
      store.billingSuspendedReason === 'over_store_limit' &&
      !READ_METHODS.includes(req.method) &&
      !isStoreBillingRoute(`${req.baseUrl}${req.path}`) &&
      // SUSPEND-REFUND-1: money going back to customers is never blocked by a billing gate
      !isCustomerMoneyBackRoute(req.method, `${req.baseUrl}${req.path}`, req.body)
    ) {
      const messageEn =
        'This store is read-only: your plan covers fewer stores. Upgrade to Business to edit it again.';
      const messageAr =
        'المتجر ده للقراءة بس: باقتك فيها متاجر أقل. اعمل ترقية لباقة الأعمال عشان تعدّله تاني.';
      throw new AppError(402, 'STORE_OVER_PLAN_LIMIT', messageEn, {
        limitKey: 'maxStores',
        upgradeTo: upgradePlanFor('maxStores', 2),
        messageEn,
        messageAr,
      });
    }

    // Suspension is enforced AFTER the ownership/membership decision below, so a stranger never learns a store's status.
    const refuseIfSuspended = (): void => {
      const block = suspendedWriteBlock(
        store,
        user.role,
        req.method,
        `${req.baseUrl}${req.path}`,
        req.body
      );
      if (block) throw block;
    };

    // Super admin can access any store; log only WRITES, not reads.
    // Logging every GET (dashboard polling, notification refresh,
    // analytics tabs, etc.) was generating an audit-log entry every
    // minute per super-admin per store — pure noise. Writes
    // (POST/PUT/PATCH/DELETE) are the events that actually matter
    // for compliance / forensics. STORE_ACCESS_DENIED below still
    // fires on every method since denied access IS a security event.
    if (user.role === 'super_admin') {
      const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (isWrite) {
        await auditLog({
          action: 'STORE_ACCESS',
          userId: user.userId,
          resourceType: 'store',
          resourceId: storeId,
          details: {
            storeName: store.name,
            accessType: 'super_admin_access',
            method: req.method,
            path: req.path,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        // Activation (Ruling ACT-1): a super admin writing to a store that is not live yet is a "help needed" signal.
        // Advisory and never throws (sendEventAfterCommit swallows its own failures); the planner names the open step.
        if (String(store.status) !== 'active')
          void sendOnboardingHelpToCi(storeId, 'super_admin_action');
      }

      // Attach store to request for downstream use
      req.store = store;
      return next();
    }

    // Store admin can only access their own stores
    if (user.role === 'store_admin') {
      if (store.ownerId !== user.userId) {
        await auditLog({
          action: 'STORE_ACCESS_DENIED',
          userId: user.userId,
          resourceType: 'store',
          resourceId: storeId,
          details: {
            reason: 'not_owner',
            attemptedStoreId: storeId,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        throw new AppError(403, 'FORBIDDEN', 'You do not have access to this store');
      }

      refuseIfSuspended();

      // Attach store to request for downstream use
      req.store = store;
      return next();
    }

    // Staff users can access stores they are explicitly added to
    if (user.role === 'staff') {
      const membership = onD1
        ? d1Gate?.isStaff
        : await withStore(storeId, tx =>
            tx.storeStaff.findUnique({
              where: { userId_storeId: { userId: user.userId, storeId } },
              select: { id: true },
            })
          );

      if (!membership) {
        await auditLog({
          action: 'STORE_ACCESS_DENIED',
          userId: user.userId,
          resourceType: 'store',
          resourceId: storeId,
          details: {
            reason: 'not_staff_member',
            attemptedStoreId: storeId,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        throw new AppError(403, 'FORBIDDEN', 'You do not have access to this store');
      }

      refuseIfSuspended();
      req.store = store;
      return next();
    }

    // Customers and other roles cannot access store admin routes
    throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions to access store');
  } catch (error) {
    next(error);
  }
}

/**
 * Programmatic ownership check usable inside a handler — same logic as
 * `requireStoreAccess` middleware but returns a result instead of
 * mutating Express flow. Use it on mixed-audience routes (admin OR
 * customer) where we can't apply the middleware blanket because it
 * rejects customers.
 *
 * Returns `{ ok: true, store }` when access is granted, or
 * `{ ok: false, status, code, message }` when denied. Caller writes
 * the response.
 *
 * super_admin always passes (call site is responsible for audit-log
 * if cross-tenant access matters in that context).
 */
export async function checkStoreAccess(
  storeId: string,
  user: { userId: string; role: string },
  /**
   * Pass `write` for a WRITE (upload, delete): a suspended store then refuses exactly like `requireStoreAccess` (TEN-1).
   * Add `moneyBack` for a refund to a customer: a BILLING suspension then lets it through (SUSPEND-REFUND-1).
   */
  opts?: { write?: boolean; moneyBack?: boolean }
): Promise<StoreAccessResult> {
  const r = await decideStoreAccess(storeId, user);
  if (r.ok && opts?.write) {
    // Callers are non-billing routes, so the billing-route exemption never applies here; money back may.
    const block = suspendedWriteBlock(r.store, user.role, 'POST', '/', undefined, opts.moneyBack);
    if (block) {
      return { ok: false, status: block.statusCode, code: block.code, message: block.message };
    }
  }
  return r;
}

type StoreAccessResult =
  | {
      ok: true;
      store: {
        id: string;
        ownerId: string;
        status: string;
        billingSuspendedReason?: string | null;
      };
    }
  | { ok: false; status: number; code: string; message: string };

async function decideStoreAccess(
  storeId: string,
  user: { userId: string; role: string }
): Promise<StoreAccessResult> {
  const onD1 = UUID_RE.test(storeId) && (await onAccessD1());
  const d1Gate = onD1 ? await gateRead(storeId, user.userId) : null;
  const store = onD1
    ? (d1Gate?.store ?? null)
    : await readStoreForAccess(storeId, {
        id: true,
        ownerId: true,
        status: true,
        billingSuspendedReason: true,
      });
  if (!store) {
    return { ok: false, status: 404, code: 'STORE_NOT_FOUND', message: 'Store not found' };
  }
  if (user.role === 'super_admin') {
    return { ok: true, store };
  }
  if (user.role === 'store_admin' && store.ownerId === user.userId) {
    return { ok: true, store };
  }
  if (user.role === 'staff') {
    const membership = onD1
      ? d1Gate?.isStaff
      : await withStore(storeId, tx =>
          tx.storeStaff.findUnique({
            where: { userId_storeId: { userId: user.userId, storeId } },
            select: { id: true },
          })
        );
    if (membership) {
      return { ok: true, store };
    }
  }
  return {
    ok: false,
    status: 403,
    code: 'FORBIDDEN',
    message: 'You do not have access to this store',
  };
}
