import { prisma, Prisma, withMoneyTx, hasTenantContext, type DbClient } from '@ebda/database';
import logger from '../../lib/logger';
import { AppError } from '../../middleware/error-handler';
import { storeDb, storeMoney } from '../../lib/repo-factory';
import { invalidateStoreProductCaches } from '../../lib/public-cache';
import { OrderService } from '../order.service';
import { allocatePartialReturn } from './posting/partial-return-allocation';
import { healBackorderStockDebt } from './backorder-stock-heal';
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
  // The store's backend: a DO store's checkout writes its backorder lines in its StoreDO (do/checkout.ts).
  return (await storeDb(storeId)).backorderLine.findMany({
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
 * One transaction (the request's when there is one, else withMoneyTx — BS-8):
 *   1. CLAIM the line — a conditional update on `cancelledAt: null`, so two
 *      concurrent cancels cannot both proceed; the loser gets 404 like any
 *      already-cancelled line.
 *   2. Clear `costPriceDeferred` when no other open line remains on the item.
 *   3. Heal the stock debt the line left (owner decision 2026-10-01, #2277,
 *      ruling AP-5c): a NON-variant backordered sale force-decremented
 *      `products.inventory` past zero, so the cancelled units give back
 *      `min(units, −inventory)` — the negative part only, never above 0. A
 *      variant line heals nothing: checkout floors variant rows at 0, so a
 *      variant backorder never leaves a debt (`healBackorderStockDebt`).
 *   4. Write the `backorder_line_cancelled` orderEvent: the durable record of
 *      the units this cancel took back (`qty − qtyFulfilled`) and of the
 *      stock it healed (`stockRestored`). It is the backorder twin of a
 *      COMPLETED Return row — every later item-level allocation (GL, provider
 *      refund, store credit) counts it as prior, see `loadPriorReversedQty`,
 *      and a later whole-order restore subtracts `stockRestored` so the
 *      healed units are never given back twice.
 *
 * Then, after commit (`applyRefundEffects` → `deferAfterTenantCommit`), the
 * ITEM-LEVEL `order/refunded` event for just those units, keyed
 * `backorder:<lineId>` (owner decision 2026-09-30, ruling AP-5): the GL posts
 * a pro-rata adjustment for this line only (`postPartialReturnJournal` —
 * revenue net of its discount share, its VAT share, its COGS), and the fanout
 * skips every whole-order reversal (coupon, affiliate, loyalty, wallet) and
 * restores no stock itself (`restoreInventory: false`) — the only stock this
 * cancel moves is the debt heal in step 3, done once under the claim. The
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
  // A store on its Durable Object (Ruling NZ-FEAT-1): claim, flag, stock heal and marker are ONE section there.
  const money = await storeMoney(storeId);
  if (money) return cancelBackorderOnDo(storeId, backorderId, reason, userId, money);

  // Load the line + its orderItem to verify store ownership + get orderId
  const bo = await prisma.backorderLine.findFirst({
    where: { id: backorderId, storeId, cancelledAt: null, fulfilledAt: null },
    select: {
      orderItemId: true,
      productId: true,
      variantId: true,
      orderItem: { select: { id: true, orderId: true } },
    },
  });

  if (!bo) throw notFound();

  const orderId = bo.orderItem.orderId;
  const refundKey = backorderRefundKey(backorderId);
  const now = new Date();

  // ONE commit decision with the request (issue 2276). `withMoneyTx` is not
  // proxied onto the ambient tenant transaction, so inside a request it opened
  // a SEPARATE transaction that committed the claim + marker on its own —
  // while the `order/refunded` send below is queued by deferAfterTenantCommit
  // and DROPPED if the request then rolls back (or its COMMIT times out). The
  // line was durably cancelled, its units counted as reversed, and the GL
  // adjustment and customer notice never happened, with no retry path (the
  // claim makes a second cancel a 404). On the ambient transaction the marker
  // and the deferred event share one outcome. Outside a request it keeps its
  // own money transaction, as before.
  const inCancelTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    hasTenantContext()
      ? fn(prisma as unknown as Prisma.TransactionClient)
      : withMoneyTx(prisma, fn);

  const cancelled = await inCancelTx(async (tx: Prisma.TransactionClient) => {
    // 1. Claim — only a still-open line is cancelled, exactly once.
    const claim = await tx.backorderLine.updateMany({
      where: { id: backorderId, storeId, cancelledAt: null, fulfilledAt: null },
      data: { cancelledAt: now, cancelledReason: reason },
    });
    if (claim.count === 0) return null;

    // Re-read under the row lock the claim now holds: a PO receive may have
    // fulfilled part of the line since the read above.
    const line = await tx.backorderLine.findUniqueOrThrow({
      where: { id: backorderId, storeId },
      select: { qty: true, qtyFulfilled: true },
    });
    const quantity = Math.max(0, line.qty - line.qtyFulfilled);

    // 2. If no other open lines remain for this OrderItem, clear the deferred flag
    const remainingOpen = await tx.backorderLine.count({
      where: {
        orderItemId: bo.orderItemId,
        storeId,
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

    if (quantity === 0) return { quantity, refundAmount: 0, notify: false, stockRestored: 0 };

    // 3. Heal the negative stock this line left, up to 0 (see docblock). Runs
    //    under the claim above, so it happens exactly once per line.
    const stockRestored = await healBackorderStockDebt(tx, {
      storeId,
      productId: bo.productId,
      variantId: bo.variantId,
      quantity,
      reference: refundKey,
      reason: 'Backorder line cancelled — stock debt healed to 0',
      userId,
    });

    // 4. The durable record of what this cancel took back (see docblock).
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
          // Units put back into `products.inventory` by step 3. The
          // whole-order restore (order-refunded `restore-inventory`)
          // subtracts these, or a later full cancel would restore them again.
          stockRestored,
        },
      },
    });

    // What this line is worth net of its discount share, plus its tax share —
    // the same allocation the GL posts (so the customer's notification and
    // the journal state one number).
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId, storeId },
      select: {
        subtotal: true,
        discount: true,
        tax: true,
        taxIncludedInPrice: true,
        paymentStatus: true,
        items: { select: { id: true, quantity: true, price: true, priceSource: true } },
      },
    });
    // `prevAdjustment`: the B2B tier adjustments earlier returns retained. partial-return-posting passes it for this same
    // cancel, so leaving it out here let the amount owed and the GL cash credit differ by a piastre on a taxed order.
    const { prevQty, prevAdjustment } = await loadPriorReversedQty(tx, {
      storeId,
      orderId,
      excludeKey: refundKey,
    });
    const alloc = allocatePartialReturn({
      subtotal: order.subtotal,
      discount: order.discount,
      tax: order.tax,
      taxIncludedInPrice: order.taxIncludedInPrice,
      lines: order.items,
      prevQty,
      requested: [{ orderItemId: bo.orderItemId, quantity }],
      prevAdjustment,
    });
    return {
      quantity,
      refundAmount: alloc.cashCredit,
      // "Refund issued" only when money was actually taken for the order AND
      // this line gives some back (issue 2274): a zero allocation — its units
      // already reversed by a prior return, or a fully discounted order — is
      // still posted to the GL but must not tell the customer a refund was
      // issued. ReturnService refuses the same case (PARTIAL_REFUND_NOTHING_TO_REFUND).
      notify: order.paymentStatus === 'paid' && alloc.cashCredit > 0,
      stockRestored,
    };
  });

  if (!cancelled) throw notFound();

  // Stock moved → the storefront product caches carry the old number
  // (public-cache.ts: every stock writer busts them). Same post-write spot as
  // the stock-adjustment and inventory writers.
  if (cancelled.stockRestored > 0) await invalidateStoreProductCaches(storeId);

  if (cancelled.quantity > 0) {
    // Sent after the caller's transaction commits (deferAfterTenantCommit
    // inside a request; inline outside one). Not swallowed: inside a request
    // a failed enqueue is alerted by deferAfterTenantCommit; outside one the
    // caller sees it.
    await OrderService.applyRefundEffects(storeId, orderId, {
      // The fanout restores nothing: the only stock this cancel moves is the
      // debt heal above (step 3), already committed under the claim.
      restoreInventory: false,
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

  // `owedToCustomer`: cancelling reverses the sale in the books but sends NO
  // money (Ruling AP-5b(2)) — the merchant refunds this sum off-platform, so
  // the admin states it rather than a "Cancel & Refund" it never performs
  // (issue 2275). 0 when the order was never paid or nothing was left open.
  return {
    id: backorderId,
    cancelledAt: now,
    cancelledReason: reason,
    owedToCustomer: cancelled.notify ? cancelled.refundAmount : 0,
  };
}

/**
 * The DO twin of `cancelBackorder`. Steps 1-4 run in the `backorderCancel` money op (one section; a re-cancel of the same
 * line is a replay that writes and sends nothing and answers 200 with the first cancel's figures). The allocation is then computed from the
 * committed rows exactly as the Postgres path computes it inside its transaction (the marker it just wrote is excluded by key),
 * and the same item-level `order/refunded` event goes out.
 */
async function cancelBackorderOnDo(
  storeId: string,
  backorderId: string,
  reason: string,
  userId: string | undefined,
  money: NonNullable<Awaited<ReturnType<typeof storeMoney>>>
) {
  const r = await money.backorderCancel({
    backorderLineId: backorderId,
    reason,
    userId: userId ?? null,
  });
  if (!r.found) throw notFound();
  const now = new Date();
  if (!r.replayed && r.stockRestored > 0) await invalidateStoreProductCaches(storeId);
  if (r.quantity === 0) {
    logger.info(
      { storeId, backorderId, orderId: r.orderId, userId },
      'backorder.cancel: line already fully fulfilled — nothing to reverse'
    );
    return { id: backorderId, cancelledAt: now, cancelledReason: reason, owedToCustomer: 0 };
  }
  const refundKey = backorderRefundKey(backorderId);
  const db = (await storeDb(storeId)) as unknown as DbClient;
  const order = await db.order.findUniqueOrThrow({
    where: { id: r.orderId, storeId },
    select: {
      subtotal: true,
      discount: true,
      tax: true,
      taxIncludedInPrice: true,
      paymentStatus: true,
      items: { select: { id: true, quantity: true, price: true, priceSource: true } },
    },
  });
  const { prevQty, prevAdjustment } = await loadPriorReversedQty(db, {
    storeId,
    orderId: r.orderId,
    excludeKey: refundKey,
  });
  const alloc = allocatePartialReturn({
    subtotal: order.subtotal,
    discount: order.discount,
    tax: order.tax,
    taxIncludedInPrice: order.taxIncludedInPrice,
    lines: order.items,
    prevQty,
    requested: [{ orderItemId: r.orderItemId, quantity: r.quantity }],
    prevAdjustment,
  });
  const notify = order.paymentStatus === 'paid' && alloc.cashCredit > 0;
  // A replay (the line was already cancelled, by this or another admin) answers the same figures and sends nothing: the
  // item-level event went out with the cancel that wrote the marker (Ruling NZ-FEAT-1).
  if (r.replayed)
    return {
      id: backorderId,
      cancelledAt: now,
      cancelledReason: reason,
      owedToCustomer: notify ? alloc.cashCredit : 0,
      replayed: true,
    };
  await OrderService.applyRefundEffects(storeId, r.orderId, {
    restoreInventory: false,
    reverseWallet: false,
    fireRefundNotification: notify,
    partial: {
      items: [{ orderItemId: r.orderItemId, quantity: r.quantity }],
      refundKey,
      refundAmount: alloc.cashCredit,
      backorderLineId: backorderId,
    },
  });
  return {
    id: backorderId,
    cancelledAt: now,
    cancelledReason: reason,
    owedToCustomer: notify ? alloc.cashCredit : 0,
  };
}

// An AppError: the error handler reads `AppError.statusCode`; a plain Error carrying a `statusCode` property answered 500.
function notFound(): Error {
  return new AppError(404, 'BACKORDER_NOT_FOUND', 'backorder_not_found');
}
