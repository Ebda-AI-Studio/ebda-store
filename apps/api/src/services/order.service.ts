import crypto from 'crypto';
import { prisma, Prisma, OrderStatus } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { CartService } from './cart.service';
import { EmailService, type OrderEmailData } from './email.service';
import { socketService } from './socket.service';
import { notificationDispatcher } from './notification-dispatcher.service';
import { featureService } from './feature.service';
import { shippingCarrierService } from './shipping-carrier.service';
import { affiliateService } from './affiliate.service';
import logger from '../lib/logger';

interface CreateOrderData {
  shippingAddress: {
    firstName: string;
    lastName: string;
    company?: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string;
    [key: string]: string | undefined;
  };
  billingAddress?: {
    firstName: string;
    lastName: string;
    company?: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string;
    [key: string]: string | undefined;
  };
  paymentMethod: string;
  notes?: string;
}

export class OrderService {
  static async list(
    storeId: string,
    options: {
      page?: number;
      limit?: number;
      status?: string;
      customerId?: string;
    } = {}
  ) {
    const { status, customerId } = options;
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.OrderWhereInput = { storeId };
    if (status) where.status = status as OrderStatus;
    if (customerId) where.customerId = customerId;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          customer: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          items: true,
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.order.count({ where }),
    ]);

    return {
      orders,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getById(storeId: string, orderId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: {
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        items: {
          include: {
            product: {
              include: { images: { take: 1, orderBy: { position: 'asc' } } },
            },
          },
        },
        payments: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    return order;
  }

  static async getByOrderNumber(storeId: string, orderNumber: string) {
    const order = await prisma.order.findFirst({
      where: { orderNumber, storeId },
      include: {
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        items: {
          include: {
            product: {
              include: { images: { take: 1, orderBy: { position: 'asc' } } },
            },
          },
        },
        payments: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    return order;
  }

  static async create(
    storeId: string,
    customerId: string,
    sessionId: string,
    data: CreateOrderData,
    referralCode?: string
  ) {
    // Get cart
    const cart = await CartService.getOrCreate(storeId, sessionId, customerId);

    if (cart.items.length === 0) {
      throw new AppError(400, 'EMPTY_CART', 'Cart is empty');
    }

    // Calculate totals (done before the transaction — no locks needed here)
    const subtotal = cart.items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
    // Calculate tax using store's configured tax rates
    const taxRates = await prisma.taxRate.findMany({ where: { storeId, isActive: true } });
    const taxRate = taxRates.length > 0 ? Number(taxRates[0].rate) / 100 : 0;
    const tax = Math.round(subtotal * taxRate);
    const shipping = 0; // Free shipping (simplified)
    const total = subtotal + tax + shipping;

    // Generate order number
    const orderNumber = `ORD-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    // Create order in transaction.
    //
    // DB-006: Inventory is validated with a row-level lock (SELECT ... FOR UPDATE)
    // *inside* the transaction so that two concurrent checkouts cannot both read
    // the same stale inventory count and both succeed when only one unit remains.
    const order = await prisma.$transaction(async tx => {
      // Lock and re-validate inventory for each tracked item before decrementing.
      // FOR UPDATE prevents any concurrent transaction from reading or updating
      // the same Product row until this transaction commits or rolls back.
      for (const item of cart.items) {
        if (item.product.trackInventory) {
          if ((item as { variantId?: string }).variantId) {
            // Variant-level lock
            const [lockedVariant] = await tx.$queryRaw<Array<{ inventory: number }>>`
              SELECT inventory FROM "product_variants"
              WHERE id = ${(item as { variantId: string }).variantId}
              FOR UPDATE
            `;
            if (!lockedVariant || lockedVariant.inventory < item.quantity) {
              throw new AppError(
                400,
                'INSUFFICIENT_INVENTORY',
                `Not enough inventory for ${item.product.name} (variant)`
              );
            }
          } else {
            // Product-level lock
            const [lockedProduct] = await tx.$queryRaw<Array<{ inventory: number }>>`
              SELECT inventory FROM "products"
              WHERE id = ${item.productId}
              FOR UPDATE
            `;
            if (!lockedProduct || lockedProduct.inventory < item.quantity) {
              throw new AppError(
                400,
                'INSUFFICIENT_INVENTORY',
                `Not enough inventory for ${item.product.name}`
              );
            }
          }
        }
      }

      // Create order
      const newOrder = await tx.order.create({
        data: {
          storeId,
          customerId,
          orderNumber,
          status: 'pending',
          subtotal,
          tax,
          shipping,
          total,
          shippingAddress: data.shippingAddress,
          billingAddress: data.billingAddress || data.shippingAddress,
          notes: data.notes,
          items: {
            create: cart.items.map(item => ({
              productId: item.productId,
              productName: item.product.name,
              sku: item.product.sku,
              quantity: item.quantity,
              price: item.product.price,
              total: item.product.price * item.quantity,
            })),
          },
        },
        include: {
          items: true,
          customer: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      });

      // Decrement inventory and record history (rows already locked above)
      for (const item of cart.items) {
        if (item.product.trackInventory) {
          // The locked row gives us the accurate pre-decrement stock
          const previousStock = item.product.inventory;

          await tx.product.update({
            where: { id: item.productId },
            data: { inventory: { decrement: item.quantity } },
          });
          // Also decrement variant inventory if applicable
          if ((item as { variantId?: string }).variantId) {
            await tx.productVariant.update({
              where: { id: (item as { variantId: string }).variantId },
              data: { inventory: { decrement: item.quantity } },
            });
          }

          // DB-010: Record inventory history inside the transaction so the
          // previousStock value is accurate (from the locked row) and the
          // history record is atomic with the inventory decrement.
          await tx.inventoryHistory.create({
            data: {
              productId: item.productId,
              storeId,
              type: 'sale',
              quantity: -item.quantity,
              previousStock,
              newStock: Math.max(0, previousStock - item.quantity),
              reason: 'Sold via order',
              reference: newOrder.id,
            },
          });
        }
      }

      // Clear cart
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      // Check for abandoned cart recovery
      try {
        const abandonedCart = await tx.abandonedCart.findFirst({
          where: {
            storeId,
            OR: [
              { cartId: cart.id },
              { customerId: cart.customerId, status: { not: 'recovered' } },
            ],
            status: { in: ['pending', 'step1_sent', 'step2_sent', 'step3_sent'] },
          },
        });
        if (abandonedCart) {
          await tx.abandonedCart.update({
            where: { id: abandonedCart.id },
            data: {
              status: 'recovered',
              recoveredAt: new Date(),
              recoveredOrderId: newOrder.id,
            },
          });
          logger.info(`Abandoned cart ${abandonedCart.id} recovered by order ${newOrder.id}`);
        }
      } catch (err) {
        logger.error('Abandoned cart recovery detection failed:', err);
        // Never fail order creation
      }

      return newOrder;
    });

    // Link order to affiliate referral (fire-and-forget)
    if (referralCode) {
      affiliateService
        .linkOrderToReferral(storeId, order.id, referralCode)
        .catch(err => logger.error({ err }, 'Affiliate referral link failed'));
    }

    // Send order confirmation email
    try {
      const emailData: OrderEmailData = {
        orderNumber: order.orderNumber,
        customerName:
          `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
          order.customer?.email ||
          'Customer',
        customerEmail: order.customer?.email || '',
        items: order.items.map(item => ({
          name: item.productName,
          quantity: item.quantity,
          price: item.price,
        })),
        subtotal: order.subtotal,
        tax: order.tax,
        shipping: order.shipping,
        total: order.total,
        shippingAddress: data.shippingAddress,
      };

      await Promise.all([
        EmailService.sendOrderConfirmation(emailData),
        EmailService.sendAdminNewOrder(emailData),
      ]);
    } catch (emailError) {
      logger.error({ err: emailError }, 'Failed to send order confirmation email');
      // Don't throw - order was created successfully
    }

    // Dispatch to WhatsApp/SMS/Push channels (fire-and-forget)
    const storeForNotification = await prisma.store
      .findUnique({ where: { id: storeId }, select: { name: true } })
      .catch(() => null);
    notificationDispatcher
      .dispatch(storeId, 'order_confirmed', {
        customerName:
          `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
          order.customer?.email ||
          'Customer',
        customerPhone: data.shippingAddress.phone ?? undefined,
        orderNumber: order.orderNumber,
        total: order.total,
        storeId,
        storeName: storeForNotification?.name ?? storeId,
      })
      .catch(err => logger.error({ err }, 'Notification dispatch failed'));

    // Send real-time notification to store admins
    try {
      socketService.newOrderNotification(storeId, {
        orderNumber: order.orderNumber,
        total: order.total,
        customerName:
          `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
          order.customer?.email ||
          'Customer',
      });
    } catch (notifyError) {
      logger.error({ err: notifyError }, 'Failed to send order notification');
    }

    return order;
  }

  static async updateStatus(
    storeId: string,
    orderId: string,
    status:
      | 'pending'
      | 'confirmed'
      | 'processing'
      | 'shipped'
      | 'delivered'
      | 'cancelled'
      | 'refunded'
  ) {
    const order = await this.getById(storeId, orderId);

    // Validate status transition
    const validTransitions: Record<string, string[]> = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['processing', 'cancelled'],
      processing: ['shipped', 'cancelled'],
      shipped: ['delivered'],
      delivered: ['refunded'],
      cancelled: [],
      refunded: [],
    };

    if (!validTransitions[order.status]?.includes(status)) {
      throw new AppError(
        400,
        'INVALID_STATUS_TRANSITION',
        `Cannot transition from ${order.status} to ${status}`
      );
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId, storeId },
      data: { status },
      include: {
        items: true,
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    // DB-003: restore inventory atomically so that all stock increments and
    // history records either all succeed or all roll back together.
    if (status === 'cancelled' || status === 'refunded') {
      await prisma.$transaction(async tx => {
        for (const item of order.items) {
          // Lock the product row to get an accurate previous-stock value
          const [lockedProduct] = await tx.$queryRaw<
            Array<{ id: string; inventory: number; track_inventory: boolean }>
          >`
            SELECT id, inventory, track_inventory FROM "products"
            WHERE id = ${item.productId}
            FOR UPDATE
          `;

          if (!lockedProduct?.track_inventory) continue;

          const prevStock = lockedProduct.inventory;

          await tx.product.update({
            where: { id: item.productId },
            data: { inventory: { increment: item.quantity } },
          });

          // Restore variant stock if the order item was for a specific variant
          if ((item as { variantId?: string }).variantId) {
            await tx.productVariant.update({
              where: { id: (item as { variantId: string }).variantId },
              data: { inventory: { increment: item.quantity } },
            });
          }

          // Record inventory history inside the same transaction so the audit
          // record is guaranteed to exist if and only if the stock was restored
          await tx.inventoryHistory.create({
            data: {
              productId: item.productId,
              storeId,
              type: 'return_stock',
              quantity: item.quantity,
              previousStock: prevStock,
              newStock: prevStock + item.quantity,
              reason: `Order ${status}`,
              reference: orderId,
            },
          });
        }
      });
    }

    // Process affiliate commission on delivery (fire-and-forget)
    if (status === 'delivered') {
      affiliateService
        .processCommission(storeId, orderId)
        .catch(err => logger.error({ err }, 'Affiliate commission processing failed'));
    }

    // Auto-ship on confirmation (fire-and-forget)
    if (status === 'confirmed') {
      featureService
        .isFeatureEnabled(storeId, 'shipping_carriers')
        .then(shippingEnabled => {
          if (shippingEnabled) {
            shippingCarrierService
              .createShipmentForOrder(storeId, orderId)
              .catch(err => logger.error({ err, storeId, orderId }, 'Auto-ship failed'));
          }
        })
        .catch(err => logger.error({ err, storeId }, 'Auto-ship feature check failed'));
    }

    // Send status update emails
    try {
      const customerEmail = updatedOrder.customer?.email || '';
      const customerName =
        `${updatedOrder.customer?.firstName || ''} ${updatedOrder.customer?.lastName || ''}`.trim() ||
        customerEmail ||
        'Customer';

      if (status === 'shipped') {
        await EmailService.sendOrderShipped({
          customerEmail,
          customerName,
          orderNumber: updatedOrder.orderNumber,
          // trackingNumber and trackingUrl can be passed when available
        });
      } else if (status === 'confirmed') {
        // Payment success / order confirmed
        const shippingAddr = updatedOrder.shippingAddress as {
          firstName: string;
          lastName: string;
          address1: string;
          address2?: string;
          city: string;
          state: string;
          postalCode: string;
          country: string;
        };
        await EmailService.sendPaymentSuccess({
          orderNumber: updatedOrder.orderNumber,
          customerName,
          customerEmail,
          items: updatedOrder.items.map(item => ({
            name: item.productName,
            quantity: item.quantity,
            price: item.price,
          })),
          subtotal: updatedOrder.subtotal,
          tax: updatedOrder.tax,
          shipping: updatedOrder.shipping,
          total: updatedOrder.total,
          shippingAddress: shippingAddr,
        });
      } else if (status === 'refunded') {
        await EmailService.sendAdminRefund({
          orderNumber: updatedOrder.orderNumber,
          amount: updatedOrder.total,
          reason: 'Order refunded',
        });
      }
    } catch (emailError) {
      logger.error({ err: emailError }, 'Failed to send order status email');
      // Don't throw - status was updated successfully
    }

    // Dispatch to WhatsApp/SMS/Push channels (fire-and-forget)
    {
      const customerName =
        `${updatedOrder.customer?.firstName || ''} ${updatedOrder.customer?.lastName || ''}`.trim() ||
        updatedOrder.customer?.email ||
        'Customer';
      const shippingAddr = updatedOrder.shippingAddress as { phone?: string } | null;
      const customerPhone = shippingAddr?.phone ?? undefined;

      const storeForNotification = await prisma.store
        .findUnique({ where: { id: storeId }, select: { name: true } })
        .catch(() => null);
      const storeName = storeForNotification?.name ?? storeId;

      if (status === 'shipped') {
        notificationDispatcher
          .dispatch(storeId, 'order_shipped', {
            customerName,
            customerPhone,
            orderNumber: updatedOrder.orderNumber,
            total: updatedOrder.total,
            storeId,
            storeName,
          })
          .catch(err => logger.error({ err }, 'Notification dispatch failed (shipped)'));
      } else if (status === 'delivered') {
        notificationDispatcher
          .dispatch(storeId, 'order_delivered', {
            customerName,
            customerPhone,
            orderNumber: updatedOrder.orderNumber,
            total: updatedOrder.total,
            storeId,
            storeName,
          })
          .catch(err => logger.error({ err }, 'Notification dispatch failed (delivered)'));
      } else if (status === 'cancelled') {
        notificationDispatcher
          .dispatch(storeId, 'order_cancelled', {
            customerName,
            customerPhone,
            orderNumber: updatedOrder.orderNumber,
            total: updatedOrder.total,
            storeId,
            storeName,
          })
          .catch(err => logger.error({ err }, 'Notification dispatch failed (cancelled)'));
      } else if (status === 'refunded') {
        notificationDispatcher
          .dispatch(storeId, 'refund_processed', {
            customerName,
            customerPhone,
            orderNumber: updatedOrder.orderNumber,
            amount: updatedOrder.total,
            storeId,
            storeName,
          })
          .catch(err => logger.error({ err }, 'Notification dispatch failed (refunded)'));
      }
    }

    // Send real-time notification to customer
    try {
      socketService.orderStatusNotification(updatedOrder.customerId!, {
        orderNumber: updatedOrder.orderNumber,
        status,
      });
    } catch (notifyError) {
      logger.error({ err: notifyError }, 'Failed to send order status notification');
    }

    return updatedOrder;
  }

  static async getCustomerOrders(
    storeId: string,
    customerId: string,
    options: { page?: number; limit?: number } = {}
  ) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(50, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.OrderWhereInput = { storeId, customerId };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          items: {
            include: {
              product: {
                include: { images: { take: 1, orderBy: { position: 'asc' } } },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.order.count({ where }),
    ]);

    return {
      orders,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
