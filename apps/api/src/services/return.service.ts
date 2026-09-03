import crypto from 'crypto';
import { prisma, Prisma, ReturnStatus, ReturnType } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { EmailService } from './email.service';
import { socketService } from './socket.service';
import { OrderService } from './order.service';
import { PaymentService } from './payment-providers/payment.factory';
import logger from '../lib/logger';
import { allocatePartialReturn } from './accounting/posting/partial-return-allocation';

interface CreateReturnData {
  orderId: string;
  customerId: string;
  type: 'return' | 'exchange' | 'refund';
  reason: string;
  reasonDetail?: string;
  customerNotes?: string;
  items: {
    orderItemId: string;
    productId: string;
    productName: string;
    quantity: number;
    reason?: string;
    condition?: string;
  }[];
}

interface ListReturnsOptions {
  page?: number;
  limit?: number;
  status?: string;
  type?: string;
}

/**
 * Refund methods that mean "send the money back through the payment provider".
 *
 * Exported so the route can validate against the same set the service branches
 * on. They drifted apart once already: the service matched `'gateway'` and
 * `'original_payment'` while the admin has always sent `'original'`, so the
 * gateway branch was unreachable and the failure was silent — an unknown
 * method simply fell through to the manual path, which looks like a successful
 * completion.
 */
export const GATEWAY_REFUND_METHODS = ['original', 'gateway', 'original_payment'] as const;

/** Every method the completion endpoint accepts. Anything else is rejected. */
export const REFUND_METHODS = [
  ...GATEWAY_REFUND_METHODS,
  'store_credit',
  'bank_transfer',
  'cash',
  'manual',
] as const;

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
          items: true,
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
          select: { name: true },
        },
      },
    });
    const orderLocale = (order?.locale ?? undefined) as 'en' | 'ar' | undefined;

    if (!order) {
      throw new AppError(400, 'INVALID_ORDER', 'Order not found or not eligible for return');
    }

    // Cumulative quantities already claimed by this order's OTHER return
    // requests (anything not rejected/cancelled still holds its claim —
    // pending/approved requests reserve the quantity, completed ones consumed
    // it). Without this, the same item could be returned twice across two
    // requests and double-book the manual/store-credit refund side
    // (adversarial audit P1-2 blast radius).
    const priorReturns = await prisma.return.findMany({
      where: {
        storeId,
        orderId: data.orderId,
        status: { notIn: ['rejected', 'cancelled'] },
      },
      select: { items: { select: { orderItemId: true, quantity: true } } },
    });
    const claimedQty = new Map<string, number>();
    for (const prior of priorReturns) {
      for (const it of prior.items) {
        claimedQty.set(it.orderItemId, (claimedQty.get(it.orderItemId) ?? 0) + it.quantity);
      }
    }

    // Validate items — per-line AND cumulative across prior return requests
    // (and across duplicate lines within THIS request, hence the running map).
    for (const item of data.items) {
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

    // Calculate refund amount
    const refundAmount = data.items.reduce((total, item) => {
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
          create: data.items.map(item => ({
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

    // Return is committed — fire-and-forget the confirmation email so SMTP
    // latency can't stall the API response.
    void EmailService.sendReturnConfirmation(
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

    // Status was updated — fire-and-forget the email so SMTP latency can't
    // stall the API response.
    void EmailService.sendReturnStatusUpdate(
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
    // gateway refunds are terminal at Tap/MyFatoorah/KNET with no undo API.
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
    // must RELEASE it, or a transient provider error leaves the return
    // permanently unfinishable (see the catch at the end of this method) — but
    // ONLY while no money can have moved. Once the provider refund has (or may
    // have) executed, releasing is the dangerous option: the retry recomputes
    // the same allocation, because this return is still not 'completed' and so
    // stays out of the allocator's prevQty, and the payment still has room, so
    // the customer is paid twice for the same lines with no undo API at
    // Tap/MyFatoorah/KNET. This flag is the "money may have moved" latch.
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
          // `price` is for the partial gateway-refund allocation below, not just
          // the full/partial decision.
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
      // effects internally (it does so only for a FULL provider refund:
      // no amount, or amount >= payment.amount).
      let gatewayRanFullEffects = false;
      // What actually left the gateway, if anything. Hoisted so the completion
      // write below can replace the creation-time GROSS estimate with it.
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

      if (isGatewayRefund && returnRequest.orderId) {
        // NOT `status: 'completed'` alone. PaymentService.refund atomically
        // claims the payment as 'partially_refunded' on the FIRST partial refund
        // and commits that before returning — the same transition
        // partial-return-posting documents. A 'completed'-only filter therefore
        // matches nothing on the SECOND partial return of an order (the exact
        // sequence the telescoping allocator below exists for) and on any full
        // return following a partial, so both died on a 400 and could never be
        // completed through the gateway. A fully 'refunded' payment stays
        // excluded — there is nothing left on it to send back.
        const payment = await prisma.payment.findFirst({
          where: {
            orderId: returnRequest.orderId,
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
        // order-level discount or tax applied (see create(), above) — and nothing
        // ever overwrites it: return.routes.ts exposes only a tracking PUT, and
        // the admin renders it read-only. So it is always truthy and always
        // GROSS. Refunding it hands the customer the pre-discount price while the
        // journal credits the discounted one: on the integration fixture
        // (subtotal 9000, discount 1000, tax 900, returning one 2000-fil line)
        // that is 2000 out the door against 1978 booked, and the gap widens with
        // the discount.
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
        if (!isFullReturn) {
          const priorReturns = await prisma.return.findMany({
            where: {
              storeId,
              orderId: returnRequest.orderId,
              status: 'completed',
              type: { in: ['return', 'refund'] },
              id: { not: returnId },
            },
            select: { items: { select: { orderItemId: true, quantity: true } } },
          });
          const prevQty = new Map<string, number>();
          for (const ret of priorReturns) {
            for (const it of ret.items) {
              prevQty.set(it.orderItemId, (prevQty.get(it.orderItemId) ?? 0) + it.quantity);
            }
          }
          const order = await prisma.order.findFirst({
            where: { id: returnRequest.orderId, storeId },
            select: { subtotal: true, discount: true, tax: true },
          });
          const alloc = allocatePartialReturn({
            subtotal: order?.subtotal ?? 0,
            discount: order?.discount ?? 0,
            tax: order?.tax ?? 0,
            lines: orderLines,
            prevQty,
            requested: returnRequest.items.map(i => ({
              orderItemId: i.orderItemId,
              quantity: i.quantity,
            })),
          });
          refundAmount = alloc.cashCredit;
          if (refundAmount <= 0) {
            throw new AppError(
              400,
              'PARTIAL_REFUND_NOTHING_TO_REFUND',
              'This partial return resolves to a zero refund — every claimed line is already covered by an earlier completed return.'
            );
          }
          if (refundAmount > refundableRemaining) {
            // STRICTLY greater. Equality is not a contradiction, it is the normal
            // final piece: the allocator telescopes, so every return's cashCredit
            // over an order sums to exactly subtotal - discount + tax, while
            // payment.amount is that plus shipping. Before the last piece,
            // refundableRemaining is therefore shipping + cashCredit_final, and
            // `>=` reduces to rejecting whenever shipping <= 0. Order.shipping
            // defaults to 0 and free delivery / store pickup is the norm for
            // Kuwait merchants, so `>=` hard-blocked the second half of every
            // two-line piecewise return — and its own error text told the
            // merchant to complete it as a full return, which isFullReturn makes
            // impossible for a Return row covering only one line. Only refunding
            // MORE than is left is the real error.
            throw new AppError(
              409,
              'PARTIAL_REFUND_EXCEEDS_PAYMENT',
              'This partial return computes to more than the payment has left to refund.'
            );
          }
        } else if (alreadyRefunded > 0) {
          // Full return, but an earlier partial already sent money back: refund
          // the balance explicitly rather than leaving the amount absent (see the
          // note above — absent would re-refund the earlier portion).
          refundAmount = refundableRemaining;
        }

        try {
          await PaymentService.refund(
            {
              // Non-null by the `transactionId: { not: null }` filter above,
              // and re-checked inside PaymentService.refund.
              transactionId: payment.transactionId,
              reason: 'Customer return',
              amount: refundAmount,
            },
            undefined,
            storeId
          );
          // Money is out. Nothing below may release the completion claim.
          providerRefundExecuted = true;
        } catch (err) {
          // A throw here does NOT mean "no money moved". PaymentService commits
          // its own claim (status + refundedAmount) BEFORE the provider
          // round-trip, and releases it again ONLY when the provider call
          // itself threw; if its post-provider transaction fails it rethrows
          // with the claim — and the real refund — standing. So ask the Payment
          // row whether that claim survived: if the balance moved, treat the
          // refund as executed and keep this return claimed rather than
          // offering the merchant a retry that pays the customer twice.
          try {
            const after = await prisma.payment.findFirst({
              where: { id: payment.id },
              select: { refundedAmount: true },
            });
            providerRefundExecuted = (after?.refundedAmount ?? 0) > alreadyRefunded;
          } catch {
            // Can't read the row: assume the worst. Stranding a return is
            // recoverable by hand; a duplicate gateway refund is not.
            providerRefundExecuted = true;
          }
          logger.error(
            { err, storeId, returnId, paymentId: payment.id, providerRefundExecuted },
            providerRefundExecuted
              ? '[ReturnService] Gateway refund FAILED AFTER the money moved — return NOT marked completed, claim retained, manual reconciliation required'
              : '[ReturnService] Gateway refund failed — return NOT marked completed'
          );
          throw new AppError(
            502,
            providerRefundExecuted ? 'PROVIDER_REFUND_INDETERMINATE' : 'PROVIDER_REFUND_FAILED',
            providerRefundExecuted
              ? 'The refund reached the payment provider but this return could not be completed. Do NOT retry — reconcile the refund with the provider before touching this return.'
              : 'Payment provider refund failed. Please retry or switch refund method.'
          );
        }
        // MIRROR PaymentService's predicate, do not re-derive it from the shape
        // of the Return. It computes `isFullRefund = amountToRefund >=
        // refundableRemaining`, so the FINAL piece of a piecewise return —
        // which the guard above deliberately allows to EQUAL the remainder on a
        // zero-shipping order — makes it take the FULL branch: it flips the
        // order to 'refunded' and awaits the whole-order applyRefundEffects
        // itself. Deriving this from isFullReturn said "false" for that same
        // call, because the Return row covers only some lines, so a SECOND
        // order/refunded went out carrying a partial payload. The two runs
        // guard on different idempotency markers — the full path on the
        // order-level inventory reference, the partial on its own refundKey —
        // so whichever reached restore-inventory first, the other restored the
        // same units again: phantom stock and oversell, plus two "Refund
        // issued" emails to the customer and two merchant pushes.
        //
        // Firing only the full run there is correct, not merely safe: it
        // subtracts quantities already restored by completed partial returns,
        // so on the final piece it restores exactly the lines that piece
        // covers, and by then the order genuinely is fully returned.
        gatewayRanFullEffects = refundAmount == null || refundAmount >= refundableRemaining;
      }

      const updatedReturn = await prisma.return.update({
        where: { id: returnId, storeId },
        data: {
          status: 'completed',
          refundMethod,
          refundedAt: new Date(),
          // Replace the creation-time GROSS estimate with what actually left the
          // gateway, so the admin's "Refund Amount" stops showing a number the
          // customer never receives. Gateway path only — a manual or store-credit
          // refund moves whatever the merchant chose outside this system, and
          // inventing a figure for it would be worse than the estimate.
          ...(refundAmount != null ? { refundAmount } : {}),
        },
      });

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
      // Edge: a partial return whose refundAmount somehow covers the full
      // payment makes the gateway run FULL effects internally; skipping the
      // local partial event then avoids restoring the returned lines twice.
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
              // The DERIVED amount when a gateway refund ran, else the
              // merchant-entered one. This figure reaches the customer's refund
              // notification, so it must never be absent: the consumer falls
              // back to `order.total` when a partial payload carries no amount,
              // which emails a full-order "Refund issued" figure for a single
              // returned item — the exact bug that fallback's comment records.
              // Manual and store-credit methods move money outside this system,
              // so the merchant's own figure is the only honest one there.
              refundAmount: refundAmount ?? returnRequest.refundAmount ?? undefined,
            },
          });
        }
      }

      return updatedReturn;
    } catch (err) {
      // RELEASE the claim so a transient failure does not strand the return —
      // but ONLY when no money can have moved. Once the provider refund has (or
      // may have) executed, a retryable return is a DOUBLE refund: the
      // completion write is what closes the allocator's books, so until it
      // lands every guard on the retry path still passes. Keep the claim held
      // instead; the return then 409s ('already being completed') until a human
      // reconciles it, which is the recoverable failure mode.
      if (providerRefundExecuted) {
        logger.error(
          { storeId, returnId },
          '[ReturnService] completion failed AFTER the provider refund executed — claim deliberately RETAINED so a retry cannot refund twice; reconcile manually'
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
