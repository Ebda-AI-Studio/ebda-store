import type { NextFunction, Request, Response } from 'express';
import { AppError } from './error-handler';

/**
 * A customer token is bound to the ONE store it was issued for (`token.storeId`, = `users.store_id`).
 * `authenticate` binds it to the store named by the request's Origin / X-Store-ID, but not to the `:storeId` in the URL,
 * so a customer of store A could call `/stores/B/...` with A's headers. This closes that: on a store-scoped route a
 * customer token must carry exactly the URL's store. Staff and admins pass through (they are authorised by
 * `requireStoreAccess` / `checkStoreAccess`). Same 404 as `assertStoreCustomer` (Ruling SEC-CUSTOMER-SCOPE-1).
 * Mount AFTER `authenticate`. No database read: the token already carries the store.
 */
export function requireCustomerStoreMatch(req: Request, _res: Response, next: NextFunction): void {
  const user = req.user;
  const storeId = req.params.storeId;
  if (user?.role === 'customer' && (!storeId || user.storeId !== storeId)) {
    return next(new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found'));
  }
  next();
}
