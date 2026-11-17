import { upgradePlanFor } from '@ebda/shared';
import { Request, Response, NextFunction } from 'express';
import { withStore, type Prisma } from '@ebda/database';
import { AppError } from './error-handler';
import { auditLog } from './security';
import { gateRead, onAccessD1 } from '../services/platform/access-d1';
import { sendOnboardingHelpToCi } from '../lib/ci/emit';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !/\/billing(\/|$)/.test(`${req.baseUrl}${req.path}`)
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
  user: { userId: string; role: string }
): Promise<
  | { ok: true; store: { id: string; ownerId: string; status: string } }
  | { ok: false; status: number; code: string; message: string }
> {
  const onD1 = UUID_RE.test(storeId) && (await onAccessD1());
  const d1Gate = onD1 ? await gateRead(storeId, user.userId) : null;
  const store = onD1
    ? (d1Gate?.store ?? null)
    : await readStoreForAccess(storeId, { id: true, ownerId: true, status: true });
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
