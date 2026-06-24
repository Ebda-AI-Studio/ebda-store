import { Request, Response, NextFunction } from 'express';
import { prisma, withRlsBypass } from '@force/database';
import { AppError } from './error-handler';
import { auditLog } from './security';

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

    // Validate store exists
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, ownerId: true, name: true, status: true },
    });

    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
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
      const membership = await withRlsBypass(tx =>
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
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, ownerId: true, status: true },
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
    const membership = await withRlsBypass(tx =>
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
