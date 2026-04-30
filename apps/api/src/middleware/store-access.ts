import { Request, Response, NextFunction } from 'express';
import { prisma } from '@force/database';
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

    // Super admin can access any store, but we log the access
    if (user.role === 'super_admin') {
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
  return {
    ok: false,
    status: 403,
    code: 'FORBIDDEN',
    message: 'You do not have access to this store',
  };
}

/**
 * Lightweight store access check (no database lookup)
 * Use when store ownership was already verified in the route
 */
export function requireStoreRole(...allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user;

    if (!user) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!allowedRoles.includes(user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
    }

    next();
  };
}

/**
 * Validate store status middleware
 * Prevents operations on suspended/inactive stores
 */
export async function requireActiveStore(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const store = req.store;

    if (!store) {
      // If store not attached, fetch it. Same param precedence rule as
      // requireStoreAccess: prefer the unambiguous `:storeId` over `:id`,
      // because nested routers leak a nested entity's `:id` here.
      const storeId = req.params.storeId || req.params.id;
      if (!storeId) {
        throw new AppError(400, 'MISSING_STORE_ID', 'Store ID is required');
      }

      const fetchedStore = await prisma.store.findUnique({
        where: { id: storeId },
        select: { status: true },
      });

      if (!fetchedStore) {
        throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
      }

      if (fetchedStore.status !== 'active') {
        throw new AppError(403, 'STORE_INACTIVE', 'This store is currently inactive');
      }
    } else if (store.status !== 'active') {
      throw new AppError(403, 'STORE_INACTIVE', 'This store is currently inactive');
    }

    next();
  } catch (error) {
    next(error);
  }
}
