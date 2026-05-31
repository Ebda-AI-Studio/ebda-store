import { prisma, withMoneyTx } from '@force/database';
import logger from '../../lib/logger';
import { OrderService } from '../order.service';

/**
 * List all open backorder lines for a store.
 * "Open" = not yet fulfilled and not cancelled.
 */
export async function listOpenBackorders(storeId: string) {
  return prisma.backorderLine.findMany({
    where: {
      storeId,
      fulfilledAt: null,
      cancelledAt: null,
    },
    include: {
      product: {
        select: { id: true, name: true, nameAr: true, sku: true },
      },
      orderItem: {
        select: {
          id: true,
          quantity: true,
          price: true,
          costPriceDeferred: true,
          orderId: true,
          order: {
            select: {
              id: true,
              orderNumber: true,
              customerId: true,
              shippingAddress: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Cancel an open backorder line.
 *
 * Steps:
 * 1. Within a transaction: mark the line cancelled (cancelledAt + cancelledReason).
 *    If no other open lines remain for the same OrderItem, clear costPriceDeferred.
 * 2. Outside the transaction: fire OrderService.applyRefundEffects so the
 *    existing 7-edge refund pipeline runs. Failures are caught + logged but
 *    never surface to the caller (the DB update is already committed).
 */
export async function cancelBackorder(
  storeId: string,
  backorderId: string,
  reason: string,
  userId?: string
) {
  // Load the line + its orderItem to verify store ownership + get orderId
  const bo = await prisma.backorderLine.findFirst({
    where: { id: backorderId, storeId, cancelledAt: null, fulfilledAt: null },
    include: {
      orderItem: { select: { id: true, orderId: true } },
    },
  });

  if (!bo) {
    const err: any = new Error('backorder_not_found');
    err.statusCode = 404;
    throw err;
  }

  const now = new Date();

  await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
    // 1. Mark the backorder line cancelled
    await tx.backorderLine.update({
      where: { id: backorderId },
      data: {
        cancelledAt: now,
        cancelledReason: reason,
      },
    });

    // 2. If no other open lines remain for this OrderItem, clear the deferred flag
    const remainingOpen = await tx.backorderLine.count({
      where: {
        orderItemId: bo.orderItemId,
        id: { not: backorderId },
        fulfilledAt: null,
        cancelledAt: null,
      },
    });

    if (remainingOpen === 0) {
      await tx.orderItem.update({
        where: { id: bo.orderItemId },
        data: { costPriceDeferred: false },
      });
    }
  });

  // 3. Fire refund pipeline outside the transaction (best-effort)
  OrderService.applyRefundEffects(storeId, bo.orderItem.orderId, {
    restoreInventory: false, // Inventory was never reserved for a backordered item
  }).catch(err => {
    logger.error(
      { err, storeId, backorderId, orderId: bo.orderItem.orderId, userId },
      'backorder.cancel: applyRefundEffects failed'
    );
  });

  return { id: backorderId, cancelledAt: now, cancelledReason: reason };
}
