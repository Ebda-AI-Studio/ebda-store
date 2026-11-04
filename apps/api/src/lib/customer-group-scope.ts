import { prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';

/**
 * BE:S-25: a coupon / promotion may only target a customer group of THIS store. A foreign group id is otherwise an FK
 * existence oracle (and a dangling target). `null` / `undefined` (no targeting, or clear it) pass.
 */
export async function assertCustomerGroupInStore(
  storeId: string,
  customerGroupId: string | null | undefined
): Promise<void> {
  if (!customerGroupId) return;
  const group = await prisma.customerGroup.findFirst({
    where: { id: customerGroupId, storeId },
    select: { id: true },
  });
  if (!group) throw new AppError(404, 'CUSTOMER_GROUP_NOT_FOUND', 'Customer group not found');
}
