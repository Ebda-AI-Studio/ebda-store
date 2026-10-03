import { withStore, type Prisma } from '@force/database';
import { getOrderStoreId } from '../../../lib/definer';

/**
 * Run a posting in the store that owns `args.orderId`, for callers that have no
 * transaction of their own (Inngest refund/return fan-out).
 *
 * The event's `storeId` is used when it has one; otherwise the order's store is
 * found by primary key through a definer. An order that does not exist (or is
 * not visible in the event's store) yields `missing` — a store the event named
 * incorrectly is refused, never re-scoped, exactly as when these ran under a
 * bypass and cross-checked the order's own store.
 */
export async function withScopedToOrderStore<T>(
  args: { orderId: string; storeId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  missing: T
): Promise<T> {
  const storeId = args.storeId ?? (await getOrderStoreId(args.orderId));
  if (!storeId) return missing;
  return withStore(storeId, tx => fn(tx as unknown as Prisma.TransactionClient));
}
