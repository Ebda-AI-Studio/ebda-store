import { prisma, Prisma, withMoneyTx } from '@force/database';
import logger from '../../lib/logger';
import { OrderService } from '../order.service';
import { allocatePartialReturn } from './posting/partial-return-allocation';
import {
  BACKORDER_CANCEL_MARKER,
  backorderRefundKey,
  loadPriorReversedQty,
} from './posting/prior-reversed-qty';

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
 * One transaction (withMoneyTx):
 *   1. CLAIM the line — a conditional update on `cancelledAt: null`, so two
 *      concurrent cancels cannot both proceed; the loser gets 404 like any
 *      already-cancelled line.
 *   2. Clear `costPriceDeferred` when no other open line remains on the item.
 *   3. Write the `backorder_line_cancelled` orderEvent: the durable record of
 *      the units this cancel took back (`qty − qtyFulfilled`). It is the
 *      backorder twin of a COMPLETED Return row — every later item-level
 *      allocation (GL, provider refund, store credit) counts it as prior, see
 *      `loadPriorReversedQty`.
 *
 * Then, after commit (`applyRefundEffects` → `deferAfterTenantCommit`), the
 * ITEM-LEVEL `order/refunded` event for just those units, keyed
 * `backorder:<lineId>` (owner decision 2026-09-30, ruling AP-5): the GL posts
 * a pro-rata adjustment for this line only (`postPartialReturnJournal` —
 * revenue net of its discount share, its VAT share, its COGS), and the fanout
 * skips every whole-order reversal (coupon, affiliate, loyalty, wallet) and
 * restores no stock (none was ever reserved for a backordered unit). The
 * refundKey makes a redelivered event a no-op on both sides. A whole-order
 * cancel/refund still reverses the whole sale — and backs these adjustments
 * out first, so it nets to zero.
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

  if (!bo) throw notFound();

  const orderId = bo.orderItem.orderId;
  const refundKey = backorderRefundKey(backorderId);
  const now = new Date();

  const cancelled = await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
    // 1. Claim — only a still-open line is cancelled, exactly once.
    const claim = await tx.backorderLine.updateMany({
      where: { id: backorderId, storeId, cancelledAt: null, fulfilledAt: null },
      data: { cancelledAt: now, cancelledReason: reason },
    });
    if (claim.count === 0) return null;

    // Re-read under the row lock the claim now holds: a PO receive may have
    // fulfilled part of the line since the read above.
    const line = await tx.backorderLine.findUniqueOrThrow({
      where: { id: backorderId },
      select: { qty: true, qtyFulfilled: true },
    });
    const quantity = Math.max(0, line.qty - line.qtyFulfilled);

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

    if (quantity === 0) return { quantity, refundAmount: 0, notify: false };

    // 3. The durable record of what this cancel took back (see docblock).
    await tx.orderEvent.create({
      data: {
        storeId,
        orderId,
        fromStatus: null,
        toStatus: BACKORDER_CANCEL_MARKER,
        actorId: userId ?? null,
        metadata: {
          refundKey,
          backorderLineId: backorderId,
          reason,
          items: [{ orderItemId: bo.orderItemId, quantity }],
        },
      },
    });

    // What this line is worth net of its discount share, plus its tax share —
    // the same allocation the GL posts (so the customer's notification and
    // the journal state one number).
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        subtotal: true,
        discount: true,
        tax: true,
        taxIncludedInPrice: true,
        paymentStatus: true,
        items: { select: { id: true, quantity: true, price: true } },
      },
    });
    const { prevQty } = await loadPriorReversedQty(tx, { storeId, orderId, excludeKey: refundKey });
    const alloc = allocatePartialReturn({
      subtotal: order.subtotal,
      discount: order.discount,
      tax: order.tax,
      taxIncludedInPrice: order.taxIncludedInPrice,
      lines: order.items,
      prevQty,
      requested: [{ orderItemId: bo.orderItemId, quantity }],
    });
    return {
      quantity,
      refundAmount: alloc.cashCredit,
      // "Refund issued" only when money was actually taken for the order.
      notify: order.paymentStatus === 'paid',
    };
  });

  if (!cancelled) throw notFound();

  if (cancelled.quantity > 0) {
    // Sent after the caller's transaction commits (deferAfterTenantCommit
    // inside a request; inline outside one). Not swallowed: inside a request
    // a failed enqueue is alerted by deferAfterTenantCommit; outside one the
    // caller sees it.
    await OrderService.applyRefundEffects(storeId, orderId, {
      restoreInventory: false, // Inventory was never reserved for a backordered item
      // One cancelled LINE never returns the order's wallet spend (D1). The
      // partial payload already skips it; stated for the reader.
      reverseWallet: false,
      fireRefundNotification: cancelled.notify,
      partial: {
        items: [{ orderItemId: bo.orderItemId, quantity: cancelled.quantity }],
        refundKey,
        refundAmount: cancelled.refundAmount,
        backorderLineId: backorderId,
      },
    });
  } else {
    logger.info(
      { storeId, backorderId, orderId, userId },
      'backorder.cancel: line already fully fulfilled — nothing to reverse'
    );
  }

  return { id: backorderId, cancelledAt: now, cancelledReason: reason };
}

function notFound(): Error {
  const err: Error & { statusCode?: number } = new Error('backorder_not_found');
  err.statusCode = 404;
  return err;
}
