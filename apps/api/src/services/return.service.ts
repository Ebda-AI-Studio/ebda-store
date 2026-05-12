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

    // Validate items
    for (const item of data.items) {
      const orderItem = order.items.find(oi => oi.id === item.orderItemId);
      if (!orderItem) {
        throw new AppError(400, 'INVALID_ITEM', `Order item ${item.orderItemId} not found`);
      }
      if (item.quantity > orderItem.quantity) {
        throw new AppError(400, 'INVALID_QUANTITY', `Quantity exceeds order item quantity`);
      }
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
   * In ALL cases we run `OrderService.applyRefundEffects` so inventory
   * restoration, coupon-usage decrement, and affiliate-commission
   * reversal happen consistently — the previous implementation only
   * restored inventory and let coupons / commissions drift.
   */
  static async complete(storeId: string, returnId: string, _userId: string, refundMethod: string) {
    const returnRequest = await this.getById(storeId, returnId);

    if (returnRequest.status !== 'received' && returnRequest.status !== 'inspecting') {
      throw new AppError(400, 'INVALID_STATUS', 'Return must be received before completing');
    }

    const isInventoryRestoring = returnRequest.type === 'return' || returnRequest.type === 'refund';

    // Trigger the provider refund FIRST when the merchant chose
    // gateway-based refunds. If the provider fails we want to bail
    // out before flipping the return to 'completed' — otherwise the
    // customer sees a "refund processed" status with no money back.
    const isGatewayRefund = refundMethod === 'gateway' || refundMethod === 'original_payment';
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
    }

    const updatedReturn = await prisma.return.update({
      where: { id: returnId, storeId },
      data: {
        status: 'completed',
        refundMethod,
        refundedAt: new Date(),
      },
    });

    // Side-effects (inventory + coupon + commission). PaymentService.refund
    // also runs applyRefundEffects internally for full refunds, so for
    // gateway refunds we'd be calling it twice — applyRefundEffects is
    // idempotent (conditional updates + status filters) so doubling up
    // is safe but wasteful. Only run it here when we DIDN'T just go
    // through the gateway path.
    if (isInventoryRestoring && !isGatewayRefund && returnRequest.orderId) {
      await OrderService.applyRefundEffects(storeId, returnRequest.orderId);
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
