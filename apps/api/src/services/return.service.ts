import crypto from 'crypto';
import { prisma, Prisma, ReturnStatus, ReturnType } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { EmailService } from './email.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { socketService } from './socket.service';
import { OrderService } from './order.service';
import {
  PaymentService,
  findOutstandingRefundClaims,
  reconcileOutstandingRefundClaims,
} from './payment-providers/payment.factory';
import { refundMayHaveExecuted } from './payment-providers/refund-outcome';
import logger from '../lib/logger';
import {
  allocatePartialReturn,
  splitByPaymentMix,
} from './accounting/posting/partial-return-allocation';
import { GATEWAY_REFUND_METHODS, REFUND_METHODS } from '../lib/refund-methods';
import {
  loadBackorderCancelledQty,
  loadPriorReversedQty,
} from './accounting/posting/prior-reversed-qty';
import { featureService } from './feature.service';
import { WalletService } from './wallet.service';
import { evaluateReturnWindow } from '../lib/return-window';

import { minorToDecimalString } from '@force/shared';
interface CreateReturnItemInput {
  orderItemId: string;
  productId: string;
  productName: string;
  quantity: number;
  reason?: string;
  condition?: string;
}

interface CreateReturnData {
  orderId: string;
  customerId: string;
  type: 'return' | 'exchange' | 'refund';
  reason: string;
  reasonDetail?: string;
  customerNotes?: string;
  /**
   * Individual (non-bundle) order lines to return. An entry naming a line
   * that belongs to a bundle box (`OrderItem.bundleGroupId` set) is refused
   * with `bundle_returns_are_atomic` — `bundleGroupIds` below is the only
   * way to return a bundle's components.
   */
  items?: CreateReturnItemInput[];
  /**
   * Bundle boxes to return as complete, atomic units (product-bundles design
   * doc, "Returns — atomic"). Every component of the named group returns at
   * its FULL ordered quantity — restocking every component — and the refund
   * is the sum of the group's allocated line totals, which by Task 6's
   * invariant (`Σ(line.total) === bundlePrice` per group) is exactly the
   * bundle price the customer paid, never any component's shelf price. One
   * id per BOX (Task 6 writes one `bundleGroupId` per box, not per bundle),
   * so returning one box out of an order with several leaves the others
   * untouched. Itemized (partial-box) bundle returns are out of scope — the
   * allocated share is already stored per line so enabling them later is a
   * UI + validation change, not a migration.
   */
  bundleGroupIds?: string[];
}

interface ListReturnsOptions {
  page?: number;
  limit?: number;
  status?: string;
  type?: string;
}

// The refund-method sets live in lib/refund-methods.ts so the GL poster reads
// the same set this service branches on; re-exported for the route.
export { GATEWAY_REFUND_METHODS, REFUND_METHODS };

/** Gateway refusals meaning the customer already has the money on the original method. */
const ALREADY_PAID_TO_CUSTOMER = new Set(['REFUND_ALREADY_ISSUED', 'PAYMENT_FULLY_REFUNDED']);

/** This return's share of the order's money — see ReturnService.allocateThisReturn. */
interface PartialAllocation {
  /** Net amount owed for the lines this return actually takes back. */
  cashCredit: number;
  /** Lines this return takes back after clamping; 0 = all already returned. */
  returnedLineCount: number;
  /** After this return, has every unit of every line come back? */
  allLinesNowReturned: boolean;
  /**
   * `cashCredit` split by how the order was paid (#1956): the part that goes
   * back to the customer wallet because the order was partly paid from it,
   * and the part refunded at the gateway. `walletShare` is 0 for every order
   * that did not use the wallet, so `gatewayShare === cashCredit` there.
   */
  walletShare: number;
  gatewayShare: number;
}

/** Piastres as a 2-decimal EGP string, for merchant-facing error text. */
function formatMajor(piastres: number): string {
  return minorToDecimalString(piastres);
}

/**
 * Serialise the return writes that read an order's claimed or returned
 * quantities and then act on them — `create()`'s over-claim check and
 * `complete()`'s allocation (#1393). Two of them on the same order would
 * otherwise each read the other's work as not there yet.
 *
 * A transaction-scoped ADVISORY lock, not `SELECT … FOR UPDATE` on the order
 * row like the inventory fanout takes. `complete()` holds this for the whole
 * request, provider call included, and PaymentService.refund commits the
 * order's `refunded` flip on a transaction of its own — which would wait
 * forever on a row lock this request holds, while this request waits for it.
 * The advisory key locks no row, so nothing else that touches the order is
 * blocked by it. Released when the request transaction ends; outside one
 * (scripts, tests) it is released at once and is a no-op.
 */
async function lockOrderReturns(orderId: string): Promise<void> {
  await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`return-order:${orderId}`}, 0))`;
}

/**
 * The same lock, for the CUSTOMER-facing `create()` — bounded (issues 2004 /
 * 2030). `complete()` holds this key across the provider refund round-trip
 * (a gateway refund can take several seconds), and a storefront return submission
 * must not sit on a pooled connection behind a merchant's refund until its own
 * 30s transaction times out as a P2028 500. It polls the non-blocking
 * `pg_try_advisory_xact_lock` for a short window — long enough for a racing
 * create or a quick completion to finish — then answers a clean 409 the
 * shopper can retry. Same key, so the serialisation #1393 needs is unchanged.
 */
const CREATE_LOCK_WAIT_MS = 3_000;
const CREATE_LOCK_POLL_MS = 100;
async function lockOrderReturnsBounded(orderId: string): Promise<void> {
  const deadline = Date.now() + CREATE_LOCK_WAIT_MS;
  for (;;) {
    const rows = await prisma.$queryRaw<
      Array<{ locked: boolean }>
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`return-order:${orderId}`}, 0)) AS locked`;
    if (rows[0]?.locked) return;
    if (Date.now() >= deadline) {
      throw new AppError(
        409,
        'RETURN_ORDER_BUSY',
        'Another return on this order is being processed. Please try again in a moment.'
      );
    }
    await new Promise(resolve => setTimeout(resolve, CREATE_LOCK_POLL_MS));
  }
}

export class ReturnService {
  /**
   * Generate unique return number
   */
  private static async generateReturnNumber(_storeId: string): Promise<string> {
    const prefix = 'RET';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * List returns for a store
   */
  static async list(storeId: string, options: ListReturnsOptions = {}) {
    const { page = 1, limit = 20, status, type } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ReturnWhereInput = { storeId };

    if (status) {
      where.status = status as ReturnStatus;
    }

    if (type) {
      where.type = type as ReturnType;
    }

    const [returns, total] = await Promise.all([
      prisma.return.findMany({
        where,
        skip,
        take: limit,
        include: {
          order: {
            select: { orderNumber: true, total: true },
          },
          customer: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          // `orderItem` select pulls the bundle-tagging snapshot
          // (bundleGroupId/bundleName/bundleNameAr — see OrderItem in
          // schema.prisma) so the admin returns list/drawer can group a
          // bundle box's ReturnItem rows back under the box's name instead
          // of listing its components as unrelated products. `ReturnItem`
          // itself carries no bundle columns — every component of a
          // returned box is a separate row (see ReturnService.create's
          // bundleGroupIds expansion), tied together only via this join.
          items: {
            include: {
              orderItem: {
                select: { bundleGroupId: true, bundleName: true, bundleNameAr: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.return.count({ where }),
    ]);

    return {
      returns,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get return by ID
   */
  static async getById(storeId: string, returnId: string) {
    const returnRequest = await prisma.return.findFirst({
      where: { id: returnId, storeId },
      include: {
        order: {
          select: {
            orderNumber: true,
            total: true,
            createdAt: true,
            shippingAddress: true,
          },
        },
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true, phone: true },
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                images: { take: 1, orderBy: { position: 'asc' } },
              },
            },
            // Same bundle-grouping join as `list()` above — kept in sync so
            // whichever surface reads a single return by id can group its
            // component rows under the bundle's name too.
            orderItem: {
              select: { bundleGroupId: true, bundleName: true, bundleNameAr: true },
            },
          },
        },
      },
    });

    if (!returnRequest) {
      throw new AppError(404, 'NOT_FOUND', 'Return request not found');
    }

    return returnRequest;
  }

  /**
   * Create a return request
   */
  static async create(storeId: string, data: CreateReturnData) {
    // Verify order belongs to store and customer
    const order = await prisma.order.findFirst({
      where: {
        id: data.orderId,
        storeId,
        customerId: data.customerId,
        status: 'delivered',
      },
      include: {
        items: true,
        customer: {
          select: { email: true, firstName: true, lastName: true },
        },
        store: {
          select: { name: true, returnWindowDays: true },
        },
      },
    });
    const orderLocale = (order?.locale ?? undefined) as 'en' | 'ar' | undefined;

    if (!order) {
      throw new AppError(400, 'INVALID_ORDER', 'Order not found or not eligible for return');
    }

    // The merchant's published return window binds the seller (Law 181/2018);
    // refuse a request outside it instead of letting support absorb it.
    const windowVerdict = evaluateReturnWindow({
      returnWindowDays: order.store?.returnWindowDays,
      deliveredAt: order.deliveredAt,
      updatedAt: order.updatedAt,
    });
    if (!windowVerdict.open) {
      throw new AppError(
        422,
        'RETURN_WINDOW_CLOSED',
        windowVerdict.reason === 'NOT_ACCEPTED'
          ? 'This store does not accept returns'
          : 'The return window for this order has closed',
        {
          reason: windowVerdict.reason,
          returnWindowDays: order.store?.returnWindowDays,
          closesAt: windowVerdict.closesAt?.toISOString() ?? null,
        }
      );
    }

    // Bundle groups requested as atomic units (see `bundleGroupIds` on
    // CreateReturnData) expand here into one synthesized item per component,
    // at that component's FULL ordered quantity — restocking every component
    // and refunding Σ(line.total) for the group, which by Task 6's invariant
    // is exactly the bundle price. Deduped: naming the same box twice must
    // not double the refund or the claimed quantity.
    const requestedGroupIds = Array.from(new Set(data.bundleGroupIds ?? []));
    const bundleGroupItems: CreateReturnItemInput[] = [];
    for (const groupId of requestedGroupIds) {
      const groupLines = order.items.filter(oi => oi.bundleGroupId === groupId);
      if (groupLines.length === 0) {
        throw new AppError(
          400,
          'INVALID_BUNDLE_GROUP',
          `Bundle group ${groupId} was not found on this order`
        );
      }
      for (const line of groupLines) {
        bundleGroupItems.push({
          orderItemId: line.id,
          productId: line.productId,
          productName: line.productName,
          quantity: line.quantity,
        });
      }
    }

    // A component line inside a bundle box is NOT independently selectable —
    // only the whole box, via `bundleGroupIds` above, can be returned.
    // Letting a single component through here would let the customer keep
    // the rest of the box while it refunds/restocks as if the whole box came
    // back, AND would refund the wrong figure: a component's allocated price
    // is only correct as part of the group's Σ, not standing alone (see the
    // shelf-price note on refundAmount below).
    for (const item of data.items ?? []) {
      const orderItem = order.items.find(oi => oi.id === item.orderItemId);
      if (orderItem?.bundleGroupId) {
        throw new AppError(
          422,
          'bundle_returns_are_atomic',
          `"${orderItem.bundleName ?? 'This bundle'}" can only be returned as a complete box. Select the bundle group instead of an individual component.`
        );
      }
    }

    const items: CreateReturnItemInput[] = [...(data.items ?? []), ...bundleGroupItems];
    if (items.length === 0) {
      throw new AppError(
        400,
        'NO_ITEMS',
        'At least one item or bundle group must be selected for return'
      );
    }

    // Cumulative quantities already claimed by this order's OTHER return
    // requests (anything not rejected/cancelled still holds its claim —
    // pending/approved requests reserve the quantity, completed ones consumed
    // it). Without this, the same item could be returned twice across two
    // requests and double-book the manual/store-credit refund side
    // (adversarial audit P1-2 blast radius).
    //
    // Read under the order's returns lock: two requests submitted together
    // (a double-tapped submit, two tabs) would otherwise both read the claims
    // as they were before either, and both reserve the same units. Bounded:
    // a merchant's in-flight gateway refund on this order holds the same key.
    await lockOrderReturnsBounded(data.orderId);
    const priorReturns = await prisma.return.findMany({
      where: {
        storeId,
        orderId: data.orderId,
        status: { notIn: ['rejected', 'cancelled'] },
      },
      select: { items: { select: { orderItemId: true, quantity: true } } },
    });
    // Units a single-line backorder cancel already took back never shipped —
    // they are not returnable either.
    const claimedQty = (await loadBackorderCancelledQty(prisma, { storeId, orderId: data.orderId }))
      .qty;
    for (const prior of priorReturns) {
      for (const it of prior.items) {
        claimedQty.set(it.orderItemId, (claimedQty.get(it.orderItemId) ?? 0) + it.quantity);
      }
    }

    // Validate items — per-line AND cumulative across prior return requests
    // (and across duplicate lines within THIS request, hence the running map).
    // `items` here is the COMBINED list: explicit non-bundle lines plus every
    // bundle group's synthesized component lines from above.
    for (const item of items) {
      const orderItem = order.items.find(oi => oi.id === item.orderItemId);
      if (!orderItem) {
        throw new AppError(400, 'INVALID_ITEM', `Order item ${item.orderItemId} not found`);
      }
      if (item.quantity < 1) {
        throw new AppError(400, 'INVALID_QUANTITY', `Quantity must be at least 1`);
      }
      const alreadyClaimed = claimedQty.get(item.orderItemId) ?? 0;
      if (alreadyClaimed + item.quantity > orderItem.quantity) {
        throw new AppError(
          400,
          'INVALID_QUANTITY',
          `Quantity exceeds remaining returnable quantity for this item`
        );
      }
      claimedQty.set(item.orderItemId, alreadyClaimed + item.quantity);
    }

    const returnNumber = await this.generateReturnNumber(storeId);

    // Calculate refund amount — from `orderItem.price`, the ALLOCATED
    // per-unit price Task 6 snapshotted onto the OrderItem row at checkout,
    // never a live Product/shelf price lookup. For a bundle group this
    // matters: a component's shelf price is its ordinary catalog price, but
    // the customer paid the box's discounted allocation, and
    // `price × quantity === total` (Task 6's invariant) at the FULL quantity
    // requested per bundle group above means this sum equals exactly
    // Σ(line.total) for the group — i.e. the bundle price — never the higher
    // shelf-price total.
    const refundAmount = items.reduce((total, item) => {
      const orderItem = order.items.find(oi => oi.id === item.orderItemId);
      if (orderItem) {
        return total + orderItem.price * item.quantity;
      }
      return total;
    }, 0);

    const returnRequest = await prisma.return.create({
      data: {
        storeId,
        orderId: data.orderId,
        customerId: data.customerId,
        returnNumber,
        type: data.type,
        status: 'pending',
        reason: data.reason,
        reasonDetail: data.reasonDetail,
        customerNotes: data.customerNotes,
        refundAmount,
        items: {
          create: items.map(item => ({
            orderItemId: item.orderItemId,
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            reason: item.reason,
            condition: item.condition,
          })),
        },
      },
      include: {
        items: true,
      },
    });

    // Return is committed — hand the confirmation email to the post-commit
    // queue so SMTP latency can't stall the API response.
    //
    // This used to be a bare `void EmailService.sendReturnConfirmation(...)`.
    // `/stores/:storeId/returns` runs under `tenantContext`, so the detached
    // promise inherited the request's tenant transaction and made its Prisma
    // reads (three of them, ending at `resend.service.ts`'s
    // `prisma.store.findUnique`) AFTER that transaction committed — P2028,
    // swallowed by the `.catch` below. Every return confirmation email
    // silently failed to send. `deferAfterTenantCommit` reruns the same call
    // in a fresh tenant transaction once the request's has committed; the
    // send itself is now durable (`{ queue: true }` in email.service.ts).
    void deferAfterTenantCommit('email.returnConfirmation', () =>
      EmailService.sendReturnConfirmation(
        storeId,
        {
          email: order.customer?.email || '',
          customerName:
            `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
            'Customer',
          storeName: order.store.name,
          returnNumber,
          orderNumber: order.orderNumber,
          type: data.type,
        },
        orderLocale
      )
    ).catch(err => logger.error({ err }, 'Failed to send return confirmation email'));

    // Send real-time notification to store admins
    try {
      socketService.newReturnNotification(storeId, {
        returnId: returnRequest.id,
        returnNumber,
        orderNumber: order.orderNumber,
        customerName:
          `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
          'Customer',
      });
    } catch (notifyError) {
      logger.error({ err: notifyError }, 'Failed to send return notification');
    }

    return returnRequest;
  }

  /**
   * Update return status
   */
  static async updateStatus(
    storeId: string,
    returnId: string,
    status: ReturnStatus,
    userId: string,
    notes?: string
  ) {
    // Validate the return exists (will throw if not found)
    await this.getById(storeId, returnId);

    const updateData: Prisma.ReturnUpdateInput = {
      status,
      adminNotes: notes,
    };

    // Set additional fields based on status
    switch (status) {
      case 'approved':
        updateData.approvedBy = userId;
        updateData.approvedAt = new Date();
        break;
      case 'rejected':
        updateData.rejectedBy = userId;
        updateData.rejectedAt = new Date();
        updateData.rejectionReason = notes;
        break;
      case 'shipped':
        updateData.shippedAt = new Date();
        break;
      case 'received':
        updateData.receivedAt = new Date();
        break;
      case 'completed':
        updateData.refundedAt = new Date();
        break;
    }

    const updatedReturn = await prisma.return.update({
      where: { id: returnId, storeId },
      data: updateData,
      include: {
        customer: {
          select: { email: true, firstName: true, lastName: true },
        },
        order: {
          select: { orderNumber: true, locale: true },
        },
        store: {
          select: { name: true },
        },
      },
    });

    const returnOrderLocale = (updatedReturn.order?.locale ?? undefined) as 'en' | 'ar' | undefined;

    // Status was updated — same post-commit deferral as sendReturnConfirmation
    // above; this path was broken in exactly the same way.
    void deferAfterTenantCommit('email.returnStatusUpdate', () =>
      EmailService.sendReturnStatusUpdate(
        storeId,
        {
          email: updatedReturn.customer.email,
          customerName: `${updatedReturn.customer.firstName} ${updatedReturn.customer.lastName}`,
          storeName: updatedReturn.store.name,
          returnNumber: updatedReturn.returnNumber,
          status,
          notes,
        },
        returnOrderLocale
      )
    ).catch(err => logger.error({ err }, 'Failed to send return status email'));

    // Send real-time notification to customer
    try {
      socketService.returnStatusNotification(updatedReturn.customerId, {
        returnNumber: updatedReturn.returnNumber,
        status,
      });
    } catch (notifyError) {
      logger.error({ err: notifyError }, 'Failed to send return status notification');
    }

    return updatedReturn;
  }

  /**
   * Approve a return request
   */
  static async approve(storeId: string, returnId: string, userId: string, notes?: string) {
    return this.updateStatus(storeId, returnId, 'approved', userId, notes);
  }

  /**
   * Reject a return request
   */
  static async reject(storeId: string, returnId: string, userId: string, reason: string) {
    return this.updateStatus(storeId, returnId, 'rejected', userId, reason);
  }

  /**
   * Mark return as received
   */
  static async markReceived(storeId: string, returnId: string, userId: string) {
    return this.updateStatus(storeId, returnId, 'received', userId);
  }

  /**
   * Complete return and process refund.
   *
   * `refundMethod` semantics — see GATEWAY_REFUND_METHODS:
   *   - a gateway method actually triggers the payment provider refund,
   *     pushing money back via the same channel the customer paid with.
   *     Provider failure aborts the return-completion (the merchant retries
   *     or switches method).
   *   - any other value (`'store_credit'`, `'bank_transfer'`, …): the
   *     merchant handles the refund off-platform; we only record the
   *     bookkeeping side here.
   *
   * The admin's own value is `'original'` ("Original payment method"). It was
   * missing from the gateway set, which matched only `'gateway'` and
   * `'original_payment'` — strings nothing in apps/ ever produces. Every
   * completion from the returns page therefore took the manual branch: no
   * provider refund was issued, the customer's card was never credited, and
   * because no gateway amount existed the Return row kept its creation-time
   * GROSS estimate and the refund email quoted it, while the journal booked
   * the NET allocation. Three different numbers, one of them zero.
   *
   * In ALL cases the refund effects are dispatched through
   * `OrderService.applyRefundEffects` — whole-order for a FULL return,
   * item-level (`partial` payload) for a partial one — so inventory
   * restoration and the whole-order reversals (coupon, affiliate, loyalty)
   * happen consistently and only when the entire order actually came back.
   */
  static async complete(storeId: string, returnId: string, _userId: string, refundMethod: string) {
    const returnRequest = await this.getById(storeId, returnId);

    if (returnRequest.status !== 'received' && returnRequest.status !== 'inspecting') {
      throw new AppError(400, 'INVALID_STATUS', 'Return must be received before completing');
    }

    // One completion per ORDER at a time (#1393). The claim below is per
    // Return row, so two DIFFERENT returns on the same order could both pass
    // it, both read prior returns without the other (neither is completed
    // yet), and both refund the same line. Held until the request commits, so
    // the second one reads the first as completed.
    if (returnRequest.orderId) await lockOrderReturns(returnRequest.orderId);

    // ATOMIC CLAIM. The check above is a read, and the flip to 'completed'
    // happens hundreds of lines later, AFTER the provider round-trip — so two
    // concurrent calls (a merchant double-clicking "Complete") both passed the
    // read and both refunded. The widened payment lookup used to mask this by
    // accident: once the first refund flipped the Payment to
    // 'partially_refunded' the second call found no payment and died on a 400.
    // That accident is gone now that a partially-refunded payment is a valid
    // refund source, so the mutex has to be real.
    //
    // `refundedAt` is the claim marker: nullable, only ever set at completion,
    // and updateMany's WHERE is evaluated atomically, so exactly one caller can
    // transition null -> now. Losing the race is a 409, not a second refund —
    // gateway refunds are terminal at the gateway with no undo API.
    //
    // The claim lives in the request transaction, so a crash or any 5xx rolls
    // it back with everything else: it cannot strand a return (#1349, #1361).
    // What stops a retry from refunding twice after money left is the refund
    // key PaymentService commits on its own (`return:<id>`), not this marker.
    const claim = await prisma.return.updateMany({
      where: {
        id: returnId,
        storeId,
        status: { in: ['received', 'inspecting'] },
        refundedAt: null,
      },
      data: { refundedAt: new Date() },
    });
    if (claim.count !== 1) {
      throw new AppError(
        409,
        'RETURN_ALREADY_COMPLETING',
        'This return is already being completed. Refresh before retrying.'
      );
    }
    // Everything from here to the completion write is inside the claim. A throw
    // must RELEASE it, or a failure that still commits (any 4xx) leaves the
    // return unfinishable (see the catch at the end of this method) — but ONLY
    // while no money can have moved. This flag is the "money may have moved"
    // latch.
    let providerRefundExecuted = false;
    try {
      const isInventoryRestoring =
        returnRequest.type === 'return' || returnRequest.type === 'refund';

      // Full vs partial return: a return is FULL only when it covers EVERY
      // order line at its full quantity. Anything less is a partial return and
      // must apply ITEM-LEVEL effects — the whole-order `order/refunded` fanout
      // would restore inventory the customer still holds, reverse the coupon,
      // claw back the full affiliate commission and strip loyalty points earned
      // on the kept items (adversarial audit P1-2).
      let isFullReturn = false;
      let orderLines: Array<{ id: string; quantity: number; price: number }> = [];
      if (returnRequest.orderId) {
        const orderItems = await prisma.orderItem.findMany({
          where: { orderId: returnRequest.orderId },
          // `price` is for the partial allocation below, not just the
          // full/partial decision.
          select: { id: true, quantity: true, price: true },
        });
        orderLines = orderItems;
        const returnedQty = new Map<string, number>();
        for (const it of returnRequest.items) {
          returnedQty.set(it.orderItemId, (returnedQty.get(it.orderItemId) ?? 0) + it.quantity);
        }
        isFullReturn =
          orderItems.length > 0 &&
          orderItems.every(oi => (returnedQty.get(oi.id) ?? 0) >= oi.quantity);
      }

      // Trigger the provider refund FIRST when the merchant chose
      // gateway-based refunds. If the provider fails we want to bail
      // out before flipping the return to 'completed' — otherwise the
      // customer sees a "refund processed" status with no money back.
      const isGatewayRefund = (GATEWAY_REFUND_METHODS as readonly string[]).includes(refundMethod);
      // Set when PaymentService.refund itself fired the FULL whole-order
      // effects internally — its own answer, never re-derived here.
      let gatewayRanFullEffects = false;
      // What the customer is owed for this return, when it is known. Hoisted so
      // the completion write below can replace the creation-time GROSS estimate
      // with it.
      let refundAmount: number | undefined;
      // An EXCHANGE must never move money. It swaps goods; the customer is not
      // refunded, which is why `isInventoryRestoring` excludes it and why none
      // of the downstream effects fire for it.
      //
      // The gateway branch below was gated only on the refund METHOD, never on
      // the return type. That was harmless while the branch was unreachable —
      // it matched only 'gateway'/'original_payment', which nothing in apps/
      // produces — but adding the admin's own 'original' made it live. A
      // merchant completing a partial exchange with "Original payment method"
      // would then execute a real, irreversible refund at the provider while
      // the side-effect dispatch stayed silent: no order/refunded event, so no
      // pro-rata GL adjustment, no restock of the returned unit, no refund
      // email. Revenue, tax and COGS stay fully booked against cash that has
      // left the gateway; the cash account is overstated, VAT is over-declared
      // for the period, and the trial balance still balances so nothing
      // surfaces it. A FULL exchange is worse still: it passes an absent
      // amount, so PaymentService runs the WHOLE-order effects internally and
      // reverses an exchange the type says must not be reversed.
      //
      // Refuse the combination rather than inventing accounting for it. If
      // exchanges ever need to settle a price difference, that needs its own
      // money path, not this one.
      if (isGatewayRefund && returnRequest.type === 'exchange') {
        throw new AppError(
          400,
          'EXCHANGE_CANNOT_REFUND_TO_GATEWAY',
          'An exchange swaps goods and does not refund the customer. Choose store credit or another method, or complete it as a return.'
        );
      }

      // The NET amount a PARTIAL return is worth, whatever the method (#1340).
      // `Return.refundAmount` is the creation-time GROSS estimate (no discount
      // share, no tax), and the journal books this allocation, so a manual or
      // store-credit completion that kept the estimate showed the merchant —
      // and emailed the customer — a figure the ledger never matched. The
      // method decides the channel the money moves through, not how much.
      let partial: PartialAllocation | null = null;
      if (isInventoryRestoring && returnRequest.orderId && !isFullReturn) {
        partial = await this.allocateThisReturn(
          storeId,
          returnId,
          returnRequest.orderId,
          orderLines,
          returnRequest.items
        );
        if (partial.returnedLineCount === 0) {
          throw new AppError(
            400,
            'PARTIAL_REFUND_NOTHING_TO_REFUND',
            'This partial return resolves to a zero refund — every claimed line is already covered by an earlier completed return.'
          );
        }
        refundAmount = partial.cashCredit;
      }

      // A partial return on an order paid partly from the customer wallet
      // refunds the wallet's pro-rata share to the wallet and only the rest at
      // the gateway (#1956). When the whole allocation is the wallet's (an
      // order paid entirely from it, or a rounding piastres), nothing is sent.
      const walletShare = isGatewayRefund && partial ? partial.walletShare : 0;
      const skipProvider = isGatewayRefund && partial !== null && partial.gatewayShare === 0;

      if (isGatewayRefund && returnRequest.orderId && !skipProvider) {
        const plan = await this.planGatewayRefund(
          storeId,
          returnId,
          returnRequest.orderId,
          isFullReturn,
          partial
        );
        // What the customer is owed: for a partial return the whole
        // allocation (gateway + wallet share), for a full one what the gateway
        // sends.
        refundAmount = partial ? partial.cashCredit : plan.amount;

        try {
          const result = await PaymentService.refund(
            {
              transactionId: plan.transactionId,
              reason: 'Customer return',
              amount: plan.amount,
              // Committed with the claim, so a retry of THIS return after the
              // request rolled back is refused instead of paying again.
              refundKey: `return:${returnId}`,
              // A partial return that leaves lines with the customer never
              // reverses the whole order, even when its amount happens to use
              // up what is left on the payment (#1402).
              itemLevel: partial !== null && !partial.allLinesNowReturned,
            },
            undefined,
            storeId
          );
          // Money is out. Nothing below may release the completion claim.
          providerRefundExecuted = true;
          // PaymentService's OWN decision (#1473). Re-deriving it here from the
          // payment row read before the call disagreed with it whenever a
          // webhook or another refund moved the balance in between — either
          // suppressing the only dispatch, or firing a second one that
          // restored the same units twice.
          gatewayRanFullEffects = result.wholeOrderEffectsApplied === true;
        } catch (err) {
          // PaymentService says whether the request reached the provider, from
          // where it actually knows (#1359, #1431). Re-reading the balance could
          // not tell our refund from a concurrent one, and PaymentService used
          // to reset that balance on a timeout anyway.
          providerRefundExecuted = refundMayHaveExecuted(err);
          logger.error(
            { err, storeId, returnId, providerRefundExecuted },
            providerRefundExecuted
              ? '[ReturnService] Gateway refund FAILED AFTER the money may have moved — return NOT marked completed, reconcile manually'
              : '[ReturnService] Gateway refund failed — return NOT marked completed'
          );
          if (providerRefundExecuted) {
            throw new AppError(
              502,
              'PROVIDER_REFUND_INDETERMINATE',
              'The refund reached the payment provider but this return could not be completed. Do NOT refund it again: check the provider dashboard, then complete this return with "Already refunded — record only" so it is recorded without a second refund.'
            );
          }
          // Refused before anything was sent (a refund already issued for this
          // return, a payment that changed under us): the reason is the message.
          if (err instanceof AppError && err.statusCode < 500) throw err;
          throw new AppError(
            502,
            'PROVIDER_REFUND_FAILED',
            'Payment provider refund failed. Please retry or switch refund method.'
          );
        }
      }

      // A NON-gateway completion of a return whose earlier gateway refund may
      // have gone out (PROVIDER_REFUND_INDETERMINATE / REFUND_ALREADY_ISSUED
      // both tell the merchant to "complete with Already refunded — record
      // only") is the merchant settling that claim. Record it, so the claim
      // has a terminal state and the stuck-claim sweep stops alerting on it
      // (issue 2002). Same transaction as the completion below.
      if (!isGatewayRefund && returnRequest.orderId) {
        const settled = await reconcileOutstandingRefundClaims({
          storeId,
          orderId: returnRequest.orderId,
          refundKey: `return:${returnId}`,
          refundMethod,
          userId: _userId,
        });
        if (settled.length > 0) {
          logger.info(
            { storeId, returnId, claims: settled, refundMethod },
            '[ReturnService] merchant settled outstanding refund claim(s) on completion'
          );
        }
      }

      // STORE CREDIT → CUSTOMER WALLET (D1). Only when the store has the
      // `customer_wallet` feature: with it OFF, `store_credit` keeps its old
      // meaning (the merchant settles it off-platform) and nothing below runs.
      // Only a return/refund moves money — an exchange never does, the same
      // rule the gateway branch enforces above. The credit is written after
      // the completion row, on the same (request) transaction, so the two
      // commit or roll back together; the idempotency key (the return id)
      // makes a replayed completion a no-op rather than a second credit.
      let walletCreditAmount: number | undefined;
      if (
        refundMethod === 'store_credit' &&
        isInventoryRestoring &&
        returnRequest.orderId &&
        (await featureService.isFeatureEnabled(storeId, 'customer_wallet'))
      ) {
        walletCreditAmount = await this.computeStoreCreditAmount(
          storeId,
          returnId,
          returnRequest.orderId,
          orderLines,
          returnRequest.items,
          isFullReturn
        );
        if (!isFullReturn && walletCreditAmount <= 0) {
          throw new AppError(
            400,
            'PARTIAL_REFUND_NOTHING_TO_REFUND',
            'This partial return resolves to a zero refund — every claimed line is already covered by an earlier completed return.'
          );
        }
      }

      const updatedReturn = await prisma.return.update({
        where: { id: returnId, storeId },
        data: {
          status: 'completed',
          refundMethod,
          refundedAt: new Date(),
          // Replace the creation-time GROSS estimate with what the customer is
          // actually owed: what left the gateway, or — for any other method —
          // the same net allocation the journal books. A FULL return on a
          // manual method keeps the estimate; nothing in this system decides
          // what the merchant hands back for a whole order off-platform.
          ...(refundAmount != null ? { refundAmount } : {}),
          // Same, for store credit that actually landed in the wallet.
          ...(walletCreditAmount != null ? { refundAmount: walletCreditAmount } : {}),
        },
      });

      if (walletCreditAmount != null && walletCreditAmount > 0 && returnRequest.orderId) {
        await WalletService.creditForReturn({
          storeId,
          customerId: returnRequest.customerId,
          returnId,
          orderId: returnRequest.orderId,
          amount: walletCreditAmount,
        });
      }

      // The wallet's share of a gateway refund (#1956), on the same request
      // transaction as the completion row. Keyed on the return, so a replayed
      // completion credits nothing more. The GL reads this ledger row to book
      // the share against the wallet liability (resolveReturnRefundLegs).
      if (walletShare > 0 && returnRequest.orderId) {
        await WalletService.creditReturnWalletShare({
          storeId,
          customerId: returnRequest.customerId,
          returnId,
          orderId: returnRequest.orderId,
          amount: walletShare,
        });
      }

      // Side-effects (inventory + coupon + commission + loyalty) routing:
      //
      //   - FULL return, gateway FULL refund: PaymentService.refund already
      //     dispatched the whole-order fanout internally — don't double-fire.
      //   - FULL return, manual method (or a gateway refund the provider
      //     treated as partial): fire the whole-order fanout here.
      //   - PARTIAL return, ANY method: fire the ITEM-LEVEL event. The old
      //     code's premise ("gateway refunds already ran applyRefundEffects,
      //     calling it here would double up") only held for FULL refunds —
      //     PaymentService.refund applies NO effects for a partial provider
      //     refund, so partial gateway returns never restocked the returned
      //     goods at all, and partial manual returns reversed the WHOLE order.
      //
      // Edge: the FINAL piece of a piecewise return (every line now returned)
      // whose amount uses up the payment makes the gateway run FULL effects
      // internally; skipping the local partial event then avoids restoring the
      // returned lines twice. The full run subtracts quantities already
      // restored by completed partial returns, so it restores exactly this
      // piece's lines.
      if (isInventoryRestoring && returnRequest.orderId && !gatewayRanFullEffects) {
        if (isFullReturn) {
          await OrderService.applyRefundEffects(storeId, returnRequest.orderId);
        } else {
          await OrderService.applyRefundEffects(storeId, returnRequest.orderId, {
            partial: {
              items: returnRequest.items.map(i => ({
                orderItemId: i.orderItemId,
                quantity: i.quantity,
              })),
              refundKey: returnRequest.id,
              // The NET amount (what left the gateway, or the allocation for any
              // other method). This figure reaches the customer's refund
              // notification, so it must never be absent: the consumer falls
              // back to `order.total` when a partial payload carries no amount,
              // which emails a full-order "Refund issued" figure for a single
              // returned item — the exact bug that fallback's comment records.
              // Store credit that landed in the customer wallet is the figure
              // for that method (the same allocation — see
              // computeStoreCreditAmount).
              refundAmount:
                refundAmount ?? walletCreditAmount ?? returnRequest.refundAmount ?? undefined,
            },
          });
        }
      }

      return updatedReturn;
    } catch (err) {
      // RELEASE the claim so a failure does not strand the return — but ONLY
      // when no money can have moved. Once the provider refund has (or may
      // have) executed, keep it: a caller outside a request transaction must
      // not be handed a retryable return. (Inside one, the 5xx this becomes
      // rolls the claim back regardless, and PaymentService's committed refund
      // key is what refuses the retry.)
      if (providerRefundExecuted) {
        logger.error(
          { storeId, returnId },
          '[ReturnService] completion failed AFTER the provider refund executed — claim not released so a retry cannot refund twice; reconcile manually'
        );
        throw err;
      }
      // Scoped to the un-completed statuses, so it is also a no-op once the
      // completion write above has flipped the row to 'completed' — a throw
      // from the side-effects AFTER that point must not un-claim a return
      // whose money already moved. Swallowing the release error is deliberate:
      // the original failure is the one worth surfacing.
      await prisma.return
        .updateMany({
          where: { id: returnId, storeId, status: { in: ['received', 'inspecting'] } },
          data: { refundedAt: null },
        })
        .catch(releaseErr =>
          logger.error(
            { releaseErr, storeId, returnId },
            '[ReturnService] failed to release the completion claim — return may be stuck'
          )
        );
      throw err;
    }
  }

  /**
   * What completing this return would refund, per method — for the admin's
   * confirmation step (#1485, #1474), so the merchant sees the amount and
   * whether the original payment method can take it BEFORE anything moves.
   *
   * Read-only, and computed by the same helpers `complete()` uses, so the
   * figure shown is the figure sent. It can still change if another return or
   * refund on the order lands before the merchant confirms; `complete()`
   * recomputes under the order lock and refuses rather than overshooting.
   */
  static async refundPreview(storeId: string, returnId: string) {
    const returnRequest = await this.getById(storeId, returnId);
    const isInventoryRestoring = returnRequest.type === 'return' || returnRequest.type === 'refund';

    let isFullReturn = false;
    let orderLines: Array<{ id: string; quantity: number; price: number }> = [];
    if (returnRequest.orderId) {
      orderLines = await prisma.orderItem.findMany({
        where: { orderId: returnRequest.orderId },
        select: { id: true, quantity: true, price: true },
      });
      const returnedQty = new Map<string, number>();
      for (const it of returnRequest.items) {
        returnedQty.set(it.orderItemId, (returnedQty.get(it.orderItemId) ?? 0) + it.quantity);
      }
      isFullReturn =
        orderLines.length > 0 &&
        orderLines.every(oi => (returnedQty.get(oi.id) ?? 0) >= oi.quantity);
    }

    let partial: PartialAllocation | null = null;
    if (isInventoryRestoring && returnRequest.orderId && !isFullReturn) {
      partial = await this.allocateThisReturn(
        storeId,
        returnId,
        returnRequest.orderId,
        orderLines,
        returnRequest.items
      );
    }

    // What a non-gateway completion records: the net allocation for a partial
    // return, the existing figure for a full one (see complete()).
    const recordedAmount = partial ? partial.cashCredit : returnRequest.refundAmount;

    // With the customer wallet on, `store_credit` is real money into the
    // customer's wallet, and for a FULL return it is NOT `recordedAmount`
    // (shipping is added, the wallet-paid part is left to the order/refunded
    // fanout). Computed by the same helper complete() credits with, so the
    // merchant confirms the figure the wallet actually receives. Null = the
    // wallet is off (or the return cannot credit it) and store credit keeps
    // its off-platform meaning.
    const storeCreditToWallet =
      isInventoryRestoring &&
      returnRequest.orderId &&
      (await featureService.isFeatureEnabled(storeId, 'customer_wallet'))
        ? await this.computeStoreCreditAmount(
            storeId,
            returnId,
            returnRequest.orderId,
            orderLines,
            returnRequest.items,
            isFullReturn
          )
        : null;

    let gateway: {
      available: boolean;
      amount: number | null;
      /**
       * Part of the refund that goes back to the customer wallet instead of
       * the gateway, because the order was partly paid from it (#1956).
       * `amount` is then only the gateway's part. 0 for every other order.
       */
      walletShare: number;
      refundableRemaining: number | null;
      unavailableReason: string | null;
      /**
       * The customer already has money back on the original method — so
       * "Already refunded — record only" is an honest completion. Decided here,
       * not by string-matching reason codes in the client (issue 2003).
       */
      alreadyPaidToCustomer: boolean;
    } = {
      available: false,
      amount: null,
      walletShare: 0,
      refundableRemaining: null,
      unavailableReason: null,
      alreadyPaidToCustomer: false,
    };
    if (!isInventoryRestoring) {
      gateway.unavailableReason = 'EXCHANGE_CANNOT_REFUND_TO_GATEWAY';
    } else if (!returnRequest.orderId) {
      gateway.unavailableReason = 'NO_COMPLETED_PAYMENT';
    } else if (partial && partial.returnedLineCount === 0) {
      gateway.unavailableReason = 'PARTIAL_REFUND_NOTHING_TO_REFUND';
    } else if (partial && partial.gatewayShare === 0) {
      // All of it is the wallet's share — complete() sends nothing to the
      // provider and puts the whole allocation back in the wallet.
      gateway = {
        available: true,
        amount: 0,
        walletShare: partial.walletShare,
        refundableRemaining: null,
        unavailableReason: null,
        alreadyPaidToCustomer: false,
      };
    } else {
      try {
        const plan = await this.planGatewayRefund(
          storeId,
          returnId,
          returnRequest.orderId,
          isFullReturn,
          partial
        );
        gateway = {
          available: true,
          // Absent means "the whole remaining payment" to PaymentService.
          amount: plan.amount ?? plan.refundableRemaining,
          walletShare: partial?.walletShare ?? 0,
          refundableRemaining: plan.refundableRemaining,
          unavailableReason: null,
          alreadyPaidToCustomer: false,
        };
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        gateway.unavailableReason = err.code;
        // REFUND_ALREADY_ISSUED: this return's refund went out. PAYMENT_FULLY_
        // REFUNDED: the whole payment went back by a path with no refundKey (the
        // order page's refund-via-provider, or the provider's own dashboard).
        // PARTIAL_REFUND_EXCEEDS_PAYMENT stays out: part of the money is still
        // owed, and its copy directs the merchant to store credit.
        gateway.alreadyPaidToCustomer = ALREADY_PAID_TO_CUSTOMER.has(err.code);
      }
    }

    return {
      returnId,
      status: returnRequest.status,
      type: returnRequest.type,
      isFullReturn,
      recordedAmount,
      storeCreditToWallet,
      gateway,
    };
  }

  /**
   * This return's share of the order's money, net of prior completed returns —
   * the same allocation partial-return-posting books (see
   * partial-return-allocation.ts for why the two must be one function).
   */
  private static async allocateThisReturn(
    storeId: string,
    returnId: string,
    orderId: string,
    orderLines: Array<{ id: string; quantity: number; price: number }>,
    items: Array<{ orderItemId: string; quantity: number }>
  ): Promise<PartialAllocation> {
    // Prior completed returns AND single-line backorder cancellations — the
    // same reader the GL posting uses, so the two cannot disagree.
    const { prevQty } = await loadPriorReversedQty(prisma, {
      storeId,
      orderId,
      excludeKey: returnId,
    });
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      select: {
        subtotal: true,
        discount: true,
        tax: true,
        taxIncludedInPrice: true,
        total: true,
        walletAmount: true,
      },
    });
    const alloc = allocatePartialReturn({
      subtotal: order?.subtotal ?? 0,
      discount: order?.discount ?? 0,
      tax: order?.tax ?? 0,
      taxIncludedInPrice: order?.taxIncludedInPrice ?? false,
      lines: orderLines,
      prevQty,
      requested: items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
    });
    const thisQty = new Map<string, number>();
    for (const { line, qty } of alloc.returnedLines) {
      thisQty.set(line.id, (thisQty.get(line.id) ?? 0) + qty);
    }
    // Split by the order's payment mix (#1956), cumulatively over the order's
    // earlier item-level reversals — their cash value is the same allocation
    // taken over the prior quantities as one block (the allocator telescopes).
    let split = { walletShare: 0, gatewayShare: alloc.cashCredit };
    if ((order?.walletAmount ?? 0) > 0) {
      const prior = allocatePartialReturn({
        subtotal: order?.subtotal ?? 0,
        discount: order?.discount ?? 0,
        tax: order?.tax ?? 0,
        taxIncludedInPrice: order?.taxIncludedInPrice ?? false,
        lines: orderLines,
        prevQty: new Map(),
        requested: [...prevQty].map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
      });
      split = splitByPaymentMix({
        cashCredit: alloc.cashCredit,
        prevCash: prior.cashCredit,
        total: order?.total ?? 0,
        walletAmount: order?.walletAmount ?? 0,
      });
    }
    return {
      ...split,
      cashCredit: alloc.cashCredit,
      returnedLineCount: alloc.returnedLines.length,
      // After this return, is nothing left with the customer? Counted in LINES,
      // never inferred from money: the payment's balance also moves for refunds
      // that have no Return row (#1402).
      allLinesNowReturned: orderLines.every(
        l => (prevQty.get(l.id) ?? 0) + (thisQty.get(l.id) ?? 0) >= l.quantity
      ),
    };
  }

  /**
   * A refund for this return already went to the provider — its completion
   * then failed and rolled back, leaving the return 'received' while the money
   * stands. Sending it again pays the customer twice; recording it is what is
   * left to do. PaymentService refuses the same key again under the payment
   * lock; this names it before any other check can give a misleading reason.
   */
  private static async refuseIfRefundAlreadyIssued(
    storeId: string,
    paymentId: string,
    returnId: string
  ) {
    const outstanding = await findOutstandingRefundClaims(paymentId, `return:${returnId}`, storeId);
    if (outstanding.length > 0) {
      throw new AppError(
        409,
        'REFUND_ALREADY_ISSUED',
        'A refund for this return was already sent to the payment provider. Check the provider dashboard, then complete this return with "Already refunded — record only" so it is recorded without refunding again.'
      );
    }
  }

  /**
   * Which payment a gateway refund for this return goes against, and how much
   * to send. Throws the merchant-facing reason when the gateway cannot take it.
   */
  private static async planGatewayRefund(
    storeId: string,
    returnId: string,
    orderId: string,
    isFullReturn: boolean,
    partial: PartialAllocation | null
  ): Promise<{
    paymentId: string;
    transactionId: string;
    /** Undefined = the whole payment (a full return on a never-refunded payment). */
    amount: number | undefined;
    refundableRemaining: number;
  }> {
    // NOT `status: 'completed'` alone. PaymentService.refund atomically
    // claims the payment as 'partially_refunded' on the FIRST partial refund
    // and commits that before returning — the same transition
    // partial-return-posting documents. A 'completed'-only filter therefore
    // matches nothing on the SECOND partial return of an order (the exact
    // sequence the telescoping allocator exists for) and on any full return
    // following a partial, so both died on a 400 and could never be
    // completed through the gateway. A fully 'refunded' payment stays
    // excluded — there is nothing left on it to send back.
    const payment = await prisma.payment.findFirst({
      where: {
        orderId,
        status: { in: ['completed', 'partially_refunded'] },
        // A gateway refund needs a provider transaction to refund AGAINST.
        // COD payments reach 'completed' with a NULL transactionId — they
        // are created without one and the mark-COD-paid route never sets
        // one — and passing that through made PaymentService's lookup an
        // empty WHERE, which selects an arbitrary payment and refunds a
        // completely unrelated order. Filter them out here so the error
        // below names the real problem instead.
        transactionId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      // Say which: an online payment with nothing left on it is not a COD
      // order, and telling the merchant it is sends them looking for the
      // wrong problem.
      const spent = await prisma.payment.findFirst({
        where: { orderId, status: 'refunded', transactionId: { not: null } },
        select: { id: true },
      });
      if (spent) {
        await this.refuseIfRefundAlreadyIssued(storeId, spent.id, returnId);
        throw new AppError(
          409,
          'PAYMENT_FULLY_REFUNDED',
          'Cannot trigger gateway refund: this payment has already been refunded in full.'
        );
      }
      throw new AppError(
        400,
        'NO_COMPLETED_PAYMENT',
        'Cannot trigger gateway refund: no refundable payment on this order. A cash-on-delivery order has no provider transaction — use a manual refund method.'
      );
    }
    // Unreachable given the filter above, and deliberately an explicit
    // check rather than a non-null assertion. The `!` that used to stand
    // here asserted something the schema does not guarantee
    // (transactionId is String?), which is exactly how a null reached
    // PaymentService and turned its lookup into an empty WHERE.
    if (!payment.transactionId) {
      throw new AppError(
        400,
        'PAYMENT_NOT_REFUNDABLE',
        'This payment has no provider transaction and cannot be refunded at the gateway.'
      );
    }
    // Before any amount check: if THIS return already sent a refund, every
    // other reason to refuse is a distraction — the balance is short because
    // of that very refund.
    await this.refuseIfRefundAlreadyIssued(storeId, payment.id, returnId);
    // Everything below budgets against what is LEFT on the payment, not its
    // original amount — a prior partial refund already sent part of it back.
    const alreadyRefunded = payment.refundedAmount ?? 0;
    const refundableRemaining = payment.amount - alreadyRefunded;
    if (refundableRemaining <= 0) {
      throw new AppError(
        409,
        'PAYMENT_FULLY_REFUNDED',
        'Cannot trigger gateway refund: this payment has already been refunded in full.'
      );
    }
    // `Return.refundAmount` is NOT a money instruction. It is auto-computed
    // at creation as the gross line value — sum(price x qty), with no
    // order-level discount or tax applied (see create(), above). Refunding it
    // hands the customer the pre-discount price while the journal credits the
    // discounted one: on the integration fixture (subtotal 9000, discount
    // 1000, tax 900, returning one 2000-piastre line) that is 2000 out the door
    // against 1978 booked, and the gap widens with the discount.
    //
    // So the amount is DERIVED for a partial return, from the same allocator
    // partial-return-posting books, and left ABSENT for a full one on a
    // never-refunded payment. Absent is what PaymentService reads as "the
    // whole payment", which also avoids the gross-vs-total mismatch on that
    // branch: refundAmount excludes tax and shipping, so a genuinely full
    // return could otherwise fail the `>= payment.amount` test and be
    // mistaken for a partial one.
    //
    // A full return AFTER a prior partial refund must NOT be absent, though:
    // absent means the WHOLE original payment.amount at the provider, so the
    // already-refunded portion would go out a second time. Send the remaining
    // balance explicitly instead — PaymentService still reads that as a full
    // refund (it compares against the remaining, not the original, amount),
    // so the whole-order fanout it owns still fires exactly once.
    if (!isFullReturn && partial) {
      // Only the gateway's share goes to the provider; on an order paid partly
      // from the customer wallet the rest goes back to the wallet (#1956).
      const toGateway = partial.gatewayShare;
      if (partial.cashCredit <= 0) {
        throw new AppError(
          400,
          'PARTIAL_REFUND_NOTHING_TO_REFUND',
          'This partial return resolves to a zero refund — every claimed line is already covered by an earlier completed return.'
        );
      }
      if (toGateway > refundableRemaining) {
        // STRICTLY greater. Equality is not a contradiction, it is the normal
        // final piece: the allocator telescopes, so every return's cashCredit
        // over an order sums to exactly the goods the customer paid for
        // (subtotal - discount + tax, or just subtotal - discount when the tax
        // was already inside the listed prices), while payment.amount is that
        // plus shipping — the relation holds under either tax convention
        // (ruling M3-7). Before the last piece,
        // refundableRemaining is therefore shipping + cashCredit_final, and
        // `>=` reduces to rejecting whenever shipping <= 0. Order.shipping
        // defaults to 0 and free delivery / store pickup is the norm for
        // Egypt merchants, so `>=` hard-blocked the second half of every
        // two-line piecewise return. Only refunding MORE than is left is the
        // real error.
        //
        // It happens when something else already took money off this payment —
        // a refund from the order page or the provider's dashboard has no
        // Return row, so the allocator cannot see it. Say so, and name the way
        // out (#1403): the merchant cannot edit the amount, and a one-line
        // return can never be completed as a full one.
        throw new AppError(
          409,
          'PARTIAL_REFUND_EXCEEDS_PAYMENT',
          `This return is worth ${formatMajor(toGateway)} EGP at the gateway but only ${formatMajor(refundableRemaining)} EGP is left on the payment, because part of it was already refunded outside this return. Complete it with store credit or bank transfer instead, and settle the difference with the customer directly.`,
          { refundAmount: toGateway, refundableRemaining }
        );
      }
      return {
        paymentId: payment.id,
        transactionId: payment.transactionId,
        amount: toGateway,
        refundableRemaining,
      };
    }
    // Full return, but an earlier partial already sent money back: refund the
    // balance explicitly rather than leaving the amount absent (see above).
    return {
      paymentId: payment.id,
      transactionId: payment.transactionId,
      amount: alreadyRefunded > 0 ? refundableRemaining : undefined,
      refundableRemaining,
    };
  }

  /**
   * How much store credit a completed return puts in the customer's wallet.
   *
   * The SAME allocation the gateway branch refunds and the GL books
   * (`allocatePartialReturn`, prior completed returns subtracted), so the
   * wallet, the card and the journal can never quote three different numbers
   * for one return:
   *
   *   - partial return → `cashCredit` (goods net of the discount share, plus
   *     the tax share). Shipping is not refunded on a partial, as on the
   *     gateway path.
   *   - full return → `cashCredit + shipping − order.walletAmount`, floored at
   *     0. The whole-order `order/refunded` fanout separately puts the part of
   *     the order that was PAID from the wallet back (`reverse-wallet-payment`),
   *     so subtracting it here is what makes the customer end up with exactly
   *     what the order cost, once.
   */
  private static async computeStoreCreditAmount(
    storeId: string,
    returnId: string,
    orderId: string,
    orderLines: Array<{ id: string; quantity: number; price: number }>,
    items: Array<{ orderItemId: string; quantity: number }>,
    isFullReturn: boolean
  ): Promise<number> {
    const [{ prevQty }, order] = await Promise.all([
      loadPriorReversedQty(prisma, { storeId, orderId, excludeKey: returnId }),
      prisma.order.findFirst({
        where: { id: orderId, storeId },
        select: {
          subtotal: true,
          discount: true,
          tax: true,
          taxIncludedInPrice: true,
          shipping: true,
          walletAmount: true,
        },
      }),
    ]);
    const alloc = allocatePartialReturn({
      subtotal: order?.subtotal ?? 0,
      discount: order?.discount ?? 0,
      tax: order?.tax ?? 0,
      taxIncludedInPrice: order?.taxIncludedInPrice ?? false,
      lines: orderLines,
      prevQty,
      requested: items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
    });
    if (!isFullReturn) return alloc.cashCredit;
    return Math.max(0, alloc.cashCredit + (order?.shipping ?? 0) - (order?.walletAmount ?? 0));
  }

  /**
   * Update tracking number
   */
  static async updateTracking(storeId: string, returnId: string, trackingNumber: string) {
    await this.getById(storeId, returnId);

    return prisma.return.update({
      where: { id: returnId, storeId },
      data: { trackingNumber },
    });
  }

  /**
   * Get customer returns
   */
  static async getCustomerReturns(
    storeId: string,
    customerId: string,
    options: ListReturnsOptions = {}
  ) {
    const { page = 1, limit = 20, status } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ReturnWhereInput = { storeId, customerId };

    if (status) {
      where.status = status as ReturnStatus;
    }

    const [returns, total] = await Promise.all([
      prisma.return.findMany({
        where,
        skip,
        take: limit,
        include: {
          order: {
            select: { orderNumber: true },
          },
          items: {
            include: {
              product: {
                select: {
                  name: true,
                  images: { take: 1, orderBy: { position: 'asc' } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.return.count({ where }),
    ]);

    return {
      returns,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get return statistics for a store
   */
  static async getStats(storeId: string) {
    const [total, pending, approved, completed, byReason] = await Promise.all([
      prisma.return.count({ where: { storeId } }),
      prisma.return.count({ where: { storeId, status: 'pending' } }),
      prisma.return.count({ where: { storeId, status: 'approved' } }),
      prisma.return.count({ where: { storeId, status: 'completed' } }),
      prisma.return.groupBy({
        by: ['reason'],
        where: { storeId },
        _count: true,
      }),
    ]);

    return {
      total,
      pending,
      approved,
      completed,
      byReason: byReason.map(r => ({
        reason: r.reason,
        count: r._count,
      })),
    };
  }
}
