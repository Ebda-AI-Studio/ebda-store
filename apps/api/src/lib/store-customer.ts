import type { Prisma } from '@ebda/database';
import { prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';

/**
 * Store-customer membership (Ruling SEC-CUSTOMER-SCOPE-1).
 *
 * Customer accounts are store-scoped: `users.store_id` = the store they registered on, `role = 'customer'`. That is the
 * ONE definition of "customer of store S" (the same one wallet, order create, wholesale and the privacy routes use).
 * `users` lives in Postgres for EVERY store (DO-backed stores included: identity is not in the StoreDO), so this check is
 * backend-independent. Never matches admin/staff rows (store_id NULL) or another store's shopper.
 *
 * Any admin route or service that takes a customer/user id from the URL or body and reads or writes per-store customer
 * data MUST call {@link assertStoreCustomer} first: an FK to the global users table is not a tenancy check.
 */
export function storeCustomerWhere(storeId: string, customerId: string): Prisma.UserWhereInput {
  return {
    id: customerId,
    role: 'customer',
    // Top-level `storeId` (the tenant guard refuses an `OR`).
    storeId,
  };
}

/** 404 CUSTOMER_NOT_FOUND unless `customerId` is a customer account of `storeId`. Same answer for "no such id", "staff id" and "other store". */
export async function assertStoreCustomer(storeId: string, customerId: string): Promise<void> {
  if (!storeId || !customerId) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
  const customer = await prisma.user.findFirst({
    where: storeCustomerWhere(storeId, customerId),
    select: { id: true },
  });
  if (!customer) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
}
