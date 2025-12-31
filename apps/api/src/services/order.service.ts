import { prisma, Prisma, OrderStatus } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { CartService } from './cart.service';
import { EmailService, type OrderEmailData } from './email.service';
import { socketService } from './socket.service';

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
    const { page = 1, limit = 20, status, customerId } = options;
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
    data: CreateOrderData
  ) {
    // Get cart
    const cart = await CartService.getOrCreate(storeId, sessionId, customerId);

    if (cart.items.length === 0) {
      throw new AppError(400, 'EMPTY_CART', 'Cart is empty');
    }

    // Validate inventory
    for (const item of cart.items) {
      if (item.product.trackInventory && item.product.inventory < item.quantity) {
        throw new AppError(
          400,
          'INSUFFICIENT_INVENTORY',
          `Not enough inventory for ${item.product.name}`
        );
      }
    }

    // Calculate totals
    const subtotal = cart.items.reduce(
      (sum, item) => sum + item.product.price * item.quantity,
      0
    );
    const tax = Math.round(subtotal * 0.1); // 10% tax (simplified)
    const shipping = 0; // Free shipping (simplified)
    const total = subtotal + tax + shipping;

    // Generate order number
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Create order in transaction
    const order = await prisma.$transaction(async tx => {
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

      // Update inventory
      for (const item of cart.items) {
        if (item.product.trackInventory) {
          await tx.product.update({
            where: { id: item.productId },
            data: { inventory: { decrement: item.quantity } },
          });
        }
      }

      // Clear cart
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      return newOrder;
    });

    // Send order confirmation email
    try {
      const emailData: OrderEmailData = {
        orderNumber: order.orderNumber,
        customerName: `${order.customer.firstName} ${order.customer.lastName}`.trim() || order.customer.email,
        customerEmail: order.customer.email,
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
      console.error('Failed to send order confirmation email:', emailError);
      // Don't throw - order was created successfully
    }

    // Send real-time notification to store admins
    try {
      socketService.newOrderNotification(storeId, {
        orderNumber: order.orderNumber,
        total: order.total,
        customerName: `${order.customer.firstName} ${order.customer.lastName}`.trim() || order.customer.email,
      });
    } catch (notifyError) {
      console.error('Failed to send order notification:', notifyError);
    }

    return order;
  }

  static async updateStatus(
    storeId: string,
    orderId: string,
    status: 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded'
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
      where: { id: orderId },
      data: { status },
      include: {
        items: true,
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    // If cancelled or refunded, restore inventory
    if (status === 'cancelled' || status === 'refunded') {
      for (const item of order.items) {
        await prisma.product.update({
          where: { id: item.productId },
          data: { inventory: { increment: item.quantity } },
        });
      }
    }

    // Send status update emails
    try {
      const customerEmail = updatedOrder.customer.email;
      const customerName = `${updatedOrder.customer.firstName} ${updatedOrder.customer.lastName}`.trim() || customerEmail;

      if (status === 'shipped') {
        await EmailService.sendOrderShipped({
          customerEmail,
          customerName,
          orderNumber: updatedOrder.orderNumber,
          // trackingNumber and trackingUrl can be passed when available
        });
      } else if (status === 'confirmed') {
        // Payment success / order confirmed
        const shippingAddr = updatedOrder.shippingAddress as { firstName: string; lastName: string; address1: string; address2?: string; city: string; state: string; postalCode: string; country: string };
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
      console.error('Failed to send order status email:', emailError);
      // Don't throw - status was updated successfully
    }

    // Send real-time notification to customer
    try {
      socketService.orderStatusNotification(updatedOrder.customerId, {
        orderNumber: updatedOrder.orderNumber,
        status,
      });
    } catch (notifyError) {
      console.error('Failed to send order status notification:', notifyError);
    }

    return updatedOrder;
  }

  static async getCustomerOrders(storeId: string, customerId: string) {
    return prisma.order.findMany({
      where: { storeId, customerId },
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
    });
  }
}
