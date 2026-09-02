import crypto from 'crypto';
import { prisma, Prisma, ReturnStatus, ReturnType } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { EmailService } from './email.service';
import { socketService } from './socket.service';
import { OrderService } from './order.service';
import { PaymentService } from './payment-providers/payment.factory';
import logger from '../lib/logger';

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
   * `refundMethod` semantics:
   *   - `'gateway'` / `'original_payment'`: actually trigger the
   *     payment provider refund, pushing money back via the same
   *     channel the customer paid with. Provider failure aborts the
   *     return-completion (the merchant retries or switches method).
   *   - any other value (`'cash'`, `'store_credit'`, `'manual'`, …):
   *     the merchant handles the refund off-platform; we only record
   *     the bookkeeping side here.
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

    const isInventoryRestoring = returnRequest.type === 'return' || returnRequest.type === 'refund';

    // Full vs partial return: a return is FULL only when it covers EVERY
    // order line at its full quantity. Anything less is a partial return and
    // must apply ITEM-LEVEL effects — the whole-order `order/refunded` fanout
    // would restore inventory the customer still holds, reverse the coupon,
    // claw back the full affiliate commission and strip loyalty points earned
    // on the kept items (adversarial audit P1-2).
    let isFullReturn = false;
    if (returnRequest.orderId) {
      const orderItems = await prisma.orderItem.findMany({
        where: { orderId: returnRequest.orderId },
        select: { id: true, quantity: true },
      });
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
    const isGatewayRefund = refundMethod === 'gateway' || refundMethod === 'original_payment';
    // Set when PaymentService.refund itself fired the FULL whole-order
    // effects internally (it does so only for a FULL provider refund:
    // no amount, or amount >= payment.amount).
    let gatewayRanFullEffects = false;
    if (isGatewayRefund && returnRequest.orderId) {
      const payment = await prisma.payment.findFirst({
        where: { orderId: returnRequest.orderId, status: 'completed' },
        orderBy: { createdAt: 'desc' },
      });
      if (!payment) {
        throw new AppError(
          400,
          'NO_COMPLETED_PAYMENT',
          'Cannot trigger gateway refund: no completed payment on this order'
        );
      }
      try {
        await PaymentService.refund(
          {
            transactionId: payment.transactionId!,
            reason: 'Customer return',
            amount: returnRequest.refundAmount ?? undefined,
          },
          undefined,
          storeId
        );
      } catch (err) {
        logger.error(
          { err, storeId, returnId, paymentId: payment.id },
          '[ReturnService] Gateway refund failed — return NOT marked completed'
        );
        throw new AppError(
          502,
          'PROVIDER_REFUND_FAILED',
          'Payment provider refund failed. Please retry or switch refund method.'
        );
      }
      // Mirrors PaymentService.refund's own isFullRefund predicate
      // (`!request.amount || request.amount >= payment.amount`) — when true,
      // it already dispatched the FULL order/refunded fanout internally.
      gatewayRanFullEffects =
        !returnRequest.refundAmount || returnRequest.refundAmount >= payment.amount;
    }

    const updatedReturn = await prisma.return.update({
      where: { id: returnId, storeId },
      data: {
        status: 'completed',
        refundMethod,
        refundedAt: new Date(),
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
            refundAmount: returnRequest.refundAmount || undefined,
          },
        });
      }
    }

    return updatedReturn;
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
