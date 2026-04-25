import crypto from 'crypto';
import { prisma, Prisma, OrderStatus } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { CartService } from './cart.service';
import { CouponService } from './coupon.service';
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
  couponCode?: string;
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
          payments: { select: { provider: true, status: true } },
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

    // Resolve coupon (if any) on the server -- we never trust a client-asserted
    // discount, since the cart could have changed between /coupons/validate
    // and order creation. CouponService.getByCode enforces active/starts/expires/
    // usage-limit at read time; the atomic usage-count increment inside the
    // transaction below closes the remaining concurrency gap.
    let appliedCoupon: Awaited<ReturnType<typeof CouponService.getByCode>> | null = null;
    let couponDiscount = 0;
    if (data.couponCode) {
      appliedCoupon = await CouponService.getByCode(storeId, data.couponCode);
      if (appliedCoupon.minOrderAmount && subtotal < appliedCoupon.minOrderAmount) {
        throw new AppError(
          400,
          'MIN_ORDER_NOT_MET',
          `Minimum order amount of ${(appliedCoupon.minOrderAmount / 1000).toFixed(3)} KWD required for this coupon`
        );
      }
      if (appliedCoupon.type !== 'free_shipping') {
        couponDiscount = CouponService.calculateDiscount(
          {
            type: appliedCoupon.type,
            value: appliedCoupon.value,
            maxDiscount: appliedCoupon.maxDiscount,
          },
          subtotal
        );
      }
      // free_shipping coupons zero the shipping line. Shipping is already 0
      // in the current "simplified" pricing above; this is a no-op today but
      // keeps the semantics correct for when shipping cost gets wired in.
    }

    const discount = couponDiscount;
    const total = Math.max(0, subtotal + tax + shipping - discount);

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

      // Atomically reserve a coupon redemption before creating the order so
      // that two concurrent checkouts can't both slip past a usage limit by
      // reading the same stale count. updateMany with a usageCount < limit
      // guard updates zero rows when the limit is reached, which we detect
      // via `count === 0` and roll back by throwing.
      if (appliedCoupon) {
        const reserve = await tx.coupon.updateMany({
          where: {
            id: appliedCoupon.id,
            isActive: true,
            ...(appliedCoupon.usageLimit ? { usageCount: { lt: appliedCoupon.usageLimit } } : {}),
          },
          data: { usageCount: { increment: 1 } },
        });
        if (reserve.count === 0) {
          throw new AppError(400, 'COUPON_LIMIT_REACHED', 'Coupon usage limit reached');
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
          discount,
          couponCode: appliedCoupon?.code ?? null,
          couponDiscount,
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

    // Order is committed — return to caller as fast as possible.
    // Emails + notifications fan out fire-and-forget so a slow / unreachable
    // SMTP host or notification provider can't block the checkout response
    // (this previously caused 45s+ "Processing…" hangs on the storefront).
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
      discount: order.discount,
      couponCode: order.couponCode ?? undefined,
      total: order.total,
      shippingAddress: data.shippingAddress,
    };

    void Promise.all([
      EmailService.sendOrderConfirmation(emailData).catch(err =>
        logger.error({ err }, 'Failed to send customer order confirmation email')
      ),
      EmailService.sendAdminNewOrder(emailData).catch(err =>
        logger.error({ err }, 'Failed to send admin new-order email')
      ),
    ]);

    // Dispatch to WhatsApp/SMS/Push channels (fire-and-forget)
    void prisma.store
      .findUnique({ where: { id: storeId }, select: { name: true } })
      .catch(() => null)
      .then(storeForNotification =>
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
          .catch(err => logger.error({ err }, 'Notification dispatch failed'))
      );

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

  /**
   * Compensating action when /payments/create fails AFTER an order has been
   * committed (cart cleared, inventory decremented, coupon usage incremented).
   *
   * Rebuilds the customer's cart from the order items, restores inventory,
   * rolls back any coupon redemption, and marks the order as cancelled. Idempotent
   * — safe to call twice; will return early if the order is already cancelled
   * or has any payment record.
   *
   * Without this, every failed payment attempt strands an unpaid pending order
   * with empty-cart-on-server, blocking the customer from retrying and slowly
   * draining inventory.
   */
  static async rollbackForPaymentFailure(
    storeId: string,
    orderId: string,
    sessionId: string
  ): Promise<void> {
    await prisma.$transaction(async tx => {
      const order = await tx.order.findFirst({
        where: { id: orderId, storeId },
        include: { items: true, payments: true },
      });

      // Idempotent guards
      if (!order) return;
      if (order.status === 'cancelled') return;
      if (order.payments.length > 0) return;
      if (order.status !== 'pending') return; // Don't roll back further-progressed orders

      // 1. Restore inventory (mirror what create() decremented)
      for (const item of order.items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { trackInventory: true, inventory: true },
        });
        if (!product?.trackInventory) continue;

        await tx.product.update({
          where: { id: item.productId },
          data: { inventory: { increment: item.quantity } },
        });

        await tx.inventoryHistory.create({
          data: {
            productId: item.productId,
            storeId,
            type: 'adjustment',
            quantity: item.quantity,
            previousStock: product.inventory,
            newStock: product.inventory + item.quantity,
            reason: 'Order rollback — payment step failed',
            reference: order.id,
          },
        });
      }

      // 2. Roll back coupon usage if one was reserved
      if (order.couponCode) {
        await tx.coupon.updateMany({
          where: { storeId, code: order.couponCode },
          data: { usageCount: { decrement: 1 } },
        });
      }

      // 3. Rebuild the cart from the order items so the customer can retry
      const cart = await tx.cart.findFirst({
        where: { storeId, sessionId },
      });
      const cartId =
        cart?.id ??
        (
          await tx.cart.create({
            data: { storeId, sessionId, customerId: order.customerId },
          })
        ).id;

      // Clear any current items first (defensive — usually empty post-create)
      await tx.cartItem.deleteMany({ where: { cartId } });
      // Re-create items from the order. CartItem has no price column —
      // price is read from the product at cart-render time.
      for (const item of order.items) {
        await tx.cartItem.create({
          data: {
            cartId,
            productId: item.productId,
            variantId: item.variantId ?? undefined,
            quantity: item.quantity,
          },
        });
      }

      // 4. Mark the order cancelled with a paper trail
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'cancelled',
          notes:
            (order.notes ? order.notes + '\n' : '') +
            '[auto-cancelled: payment step failed before completion]',
        },
      });
    });

    logger.info(
      { orderId, storeId },
      'Order rolled back after payment-create failure (inventory + cart restored)'
    );
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

    // Validate status transition. Admins can jump ahead (e.g. pending →
    // delivered for same-day COD with cash on hand) instead of stepping
    // through every intermediate state. Backwards moves remain blocked.
    // Mirror this list in apps/admin/.../orders/_components/types.ts.
    const validTransitions: Record<string, string[]> = {
      pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
      confirmed: ['processing', 'shipped', 'delivered', 'cancelled'],
      processing: ['shipped', 'delivered', 'cancelled'],
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

    // Status was committed — return to caller as fast as possible.
    // Emails + notifications fan out fire-and-forget so a slow / unreachable
    // SMTP host or notification provider can't block the admin status-change
    // response (mirrors the OrderService.create fix).
    const customerEmail = updatedOrder.customer?.email || '';
    const customerName =
      `${updatedOrder.customer?.firstName || ''} ${updatedOrder.customer?.lastName || ''}`.trim() ||
      customerEmail ||
      'Customer';
    const shippingAddrFull = updatedOrder.shippingAddress as {
      firstName: string;
      lastName: string;
      address1: string;
      address2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
      phone?: string;
    } | null;
    const customerPhone = shippingAddrFull?.phone ?? undefined;

    if (status === 'shipped') {
      void EmailService.sendOrderShipped({
        customerEmail,
        customerName,
        orderNumber: updatedOrder.orderNumber,
        // trackingNumber and trackingUrl can be passed when available
      }).catch(err => logger.error({ err }, 'Failed to send order shipped email'));
    } else if (status === 'confirmed' && shippingAddrFull) {
      // Payment success / order confirmed
      void EmailService.sendPaymentSuccess({
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
        shippingAddress: shippingAddrFull,
      }).catch(err => logger.error({ err }, 'Failed to send payment success email'));
    } else if (status === 'refunded') {
      void EmailService.sendAdminRefund({
        orderNumber: updatedOrder.orderNumber,
        amount: updatedOrder.total,
        reason: 'Order refunded',
      }).catch(err => logger.error({ err }, 'Failed to send admin refund email'));
    }

    // Dispatch to WhatsApp/SMS/Push channels (fire-and-forget, including the
    // store-name lookup so we never block the response on Prisma either).
    if (
      status === 'shipped' ||
      status === 'delivered' ||
      status === 'cancelled' ||
      status === 'refunded'
    ) {
      void prisma.store
        .findUnique({ where: { id: storeId }, select: { name: true } })
        .catch(() => null)
        .then(storeForNotification => {
          const storeName = storeForNotification?.name ?? storeId;
          if (status === 'shipped') {
            return notificationDispatcher
              .dispatch(storeId, 'order_shipped', {
                customerName,
                customerPhone,
                orderNumber: updatedOrder.orderNumber,
                total: updatedOrder.total,
                storeId,
                storeName,
              })
              .catch(err => logger.error({ err }, 'Notification dispatch failed (shipped)'));
          }
          if (status === 'delivered') {
            return notificationDispatcher
              .dispatch(storeId, 'order_delivered', {
                customerName,
                customerPhone,
                orderNumber: updatedOrder.orderNumber,
                total: updatedOrder.total,
                storeId,
                storeName,
              })
              .catch(err => logger.error({ err }, 'Notification dispatch failed (delivered)'));
          }
          if (status === 'cancelled') {
            return notificationDispatcher
              .dispatch(storeId, 'order_cancelled', {
                customerName,
                customerPhone,
                orderNumber: updatedOrder.orderNumber,
                total: updatedOrder.total,
                storeId,
                storeName,
              })
              .catch(err => logger.error({ err }, 'Notification dispatch failed (cancelled)'));
          }
          // status === 'refunded'
          return notificationDispatcher
            .dispatch(storeId, 'refund_processed', {
              customerName,
              customerPhone,
              orderNumber: updatedOrder.orderNumber,
              amount: updatedOrder.total,
              storeId,
              storeName,
            })
            .catch(err => logger.error({ err }, 'Notification dispatch failed (refunded)'));
        });
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
