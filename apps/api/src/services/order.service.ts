import crypto from 'crypto';
import { prisma, Prisma, OrderStatus } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { CartService } from './cart.service';
import { CouponService } from './coupon.service';
import { EmailService } from './email.service';
import { socketService } from './socket.service';
import { notificationDispatcher } from './notification-dispatcher.service';
import { featureService } from './feature.service';
import { inngest } from '../lib/inngest/client';
import { shippingCarrierService } from './shipping-carrier.service';
import { ShippingService } from './shipping.service';
import { LoyaltyService } from './loyalty.service';
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
  /** Buyer's UI locale at checkout time. Stored on the order so
   *  transactional emails are sent in the buyer's language. */
  locale?: 'en' | 'ar';
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

    // Defensive deletedAt filter. The schema marks Order as soft-deletable
    // but no code path currently sets `deletedAt`, so this is a no-op
    // today — kept here so a future "archive order" feature doesn't
    // accidentally surface archived rows in the admin list (which would
    // also pollute analytics aggregates that count off this query).
    const where: Prisma.OrderWhereInput = { storeId, deletedAt: null };
    if (status) where.status = status as OrderStatus;
    if (customerId) where.customerId = customerId;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          // `phone` is included so the admin customers page can surface
          // it without doing a second query. Stays nullable on the User
          // record itself.
          customer: {
            select: { id: true, email: true, firstName: true, lastName: true, phone: true },
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
      where: { id: orderId, storeId, deletedAt: null },
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
      where: { orderNumber, storeId, deletedAt: null },
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
    customerId: string | undefined,
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

    // Resolve shipping for the order's delivery area. Until now this was
    // hardcoded to 0 — the storefront cart/checkout calls
    // /stores/public/:id/shipping/calculate and DOES show a fee in the
    // breakdown, but the persisted Order had shipping=0, so the merchant
    // was silently losing the delivery fee on every order. Re-run the
    // same calculation server-side here (never trust a client-asserted
    // shipping cost) using the address's `area` field. When no zone
    // matches, the calculator returns 0 — same outcome as before for
    // stores with zero shipping zones configured.
    const shippingArea =
      typeof (data.shippingAddress as Record<string, unknown>).area === 'string'
        ? (data.shippingAddress as Record<string, string>).area
        : (data.shippingAddress.city ?? data.shippingAddress.state ?? '');
    let shipping = 0;
    try {
      const result = await ShippingService.calculateShipping(storeId, shippingArea, subtotal);
      shipping = result.freeShipping ? 0 : result.shippingCost;
    } catch (err) {
      // Defensive: if the shipping lookup throws, fall back to 0 rather
      // than fail the entire checkout. Worst case is a one-off undercharge
      // that surfaces in the merchant's order detail with shipping=0
      // (visible vs the cart UI shipping line — easy to spot).
      logger.error({ err, storeId, shippingArea }, 'Shipping calculation failed; defaulting to 0');
    }
    // Free-shipping coupon: zero out shipping after we resolved the
    // base fee, so a "Free shipping over X" coupon stacks correctly
    // with the store's free-shipping threshold (whichever zeros first).
    // The coupon resolution below also independently zeroes shipping.

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
      } else {
        // Free-shipping coupon — zero out the shipping line we just
        // resolved above. Stacks naturally with the store's own
        // free-shipping threshold (whichever zeros first wins; both
        // mean the customer pays no delivery fee).
        shipping = 0;
      }
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
          locale: data.locale ?? null,
          shippingAddress: data.shippingAddress,
          billingAddress: data.billingAddress || data.shippingAddress,
          notes: data.notes,
          items: {
            create: cart.items.map(item => ({
              productId: item.productId,
              // Persist the variant link onto OrderItem. Without this,
              // `updateStatus(cancel/refund)`, `rollbackForPaymentFailure`,
              // and `ReturnService.complete` all read OrderItem.variantId
              // to restore variant inventory — and always saw null.
              // Variant stock drifted every cancel/refund. CartItem
              // already carries variantId; we just have to copy it.
              variantId: (item as { variantId?: string | null }).variantId ?? null,
              productName: item.product.name,
              sku: item.product.sku,
              quantity: item.quantity,
              price: item.product.price,
              // Snapshot cost-of-goods at sale time so profit reports
              // stay correct even if the product's cost changes later.
              costPrice: item.product.costPrice ?? null,
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

    // Order is committed — fan out the email/push/dispatcher work onto
    // the Inngest queue so a slow SMTP host or OneSignal hiccup can't
    // block the checkout response (this previously caused 45s+
    // "Processing…" hangs on the storefront). The order/created
    // handler in lib/inngest/functions/order-created.ts re-fetches the
    // order from Postgres and runs each side effect as its own
    // retryable step.
    inngest
      .send({
        name: 'order/created',
        data: {
          orderId: order.id,
          storeId,
          paymentMethod: data.paymentMethod,
          locale: order.locale ?? undefined,
        },
      })
      .catch(err => logger.error({ err, orderId: order.id }, 'Failed to enqueue order/created'));

    // WebSocket emit stays in-process — it's a free local dispatch and
    // the admin page expects the toast within ~1s of order creation.
    try {
      socketService.newOrderNotification(storeId, {
        orderId: order.id,
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

    // Set deliveredAt when transitioning to delivered so the review-request
    // Inngest function has an accurate timestamp for the 90-day token expiry.
    const statusData: Record<string, unknown> = { status };
    if (status === 'delivered' && order.status !== 'delivered') {
      statusData.deliveredAt = new Date();
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId, storeId },
      data: statusData,
      include: {
        items: true,
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });
    const orderLocale = (updatedOrder.locale ?? undefined) as 'en' | 'ar' | undefined;

    // Refund / cancellation side-effects: inventory restore + coupon
    // decrement + affiliate-commission reversal. Centralised in
    // applyRefundEffects so gateway-driven refunds (which bypass this
    // method) get the exact same treatment.
    if (status === 'cancelled' || status === 'refunded') {
      await this.applyRefundEffects(storeId, orderId);
    }

    // Process affiliate commission on delivery (fire-and-forget)
    if (status === 'delivered') {
      // Queue review-request email (7-day delay handled inside the Inngest fn)
      inngest
        .send({ name: 'order/delivered', data: { orderId, storeId } })
        .catch(err => logger.error({ err, orderId }, 'Failed to enqueue review-request event'));

      affiliateService
        .processCommission(storeId, orderId)
        .catch(err => logger.error({ err }, 'Affiliate commission processing failed'));

      // Award loyalty points for the purchase. Defined in
      // loyalty.service for months but never invoked anywhere — every
      // delivered order silently failed to credit the customer's
      // points balance, while the admin loyalty UI cheerfully
      // advertised the program. Fire-and-forget: a missing customerId
      // (guest checkout) returns null and short-circuits inside the
      // service, and any exception is swallowed by the .catch so we
      // never fail the status update over a points-credit glitch.
      if (updatedOrder.customerId) {
        LoyaltyService.earnPointsFromPurchase(
          storeId,
          updatedOrder.customerId,
          orderId,
          updatedOrder.total
        ).catch(err =>
          logger.error(
            { err, storeId, orderId, customerId: updatedOrder.customerId },
            'Loyalty earn-from-purchase failed'
          )
        );
      }
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
      void EmailService.sendOrderShipped(
        storeId,
        {
          customerEmail,
          customerName,
          orderNumber: updatedOrder.orderNumber,
          // trackingNumber and trackingUrl can be passed when available
        },
        orderLocale
      ).catch(err => logger.error({ err }, 'Failed to send order shipped email'));
    } else if (status === 'confirmed' && shippingAddrFull) {
      // Payment success / order confirmed
      void EmailService.sendPaymentSuccess(
        storeId,
        {
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
        },
        orderLocale
      ).catch(err => logger.error({ err }, 'Failed to send payment success email'));
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

  /**
   * Side-effects of a refund that are NOT captured by `updateStatus()`:
   * inventory restore, coupon usage decrement, and affiliate-commission
   * reversal. Provider-driven refunds (payment.factory.refund) used to
   * update the order row directly and bypass `updateStatus()`, leaving
   * stock under-counted, coupon limits over-counted, and affiliates
   * with refunded earnings still on their balance. Centralised here so
   * every refund path (gateway-initiated, return-driven, manual admin)
   * applies the same effects.
   *
   * Idempotent: each step uses conditional updates / status filters so
   * calling twice (e.g. partial refund then full refund) doesn't double
   * the inventory restore or commission decrement.
   */
  static async applyRefundEffects(
    storeId: string,
    orderId: string,
    options: { restoreInventory?: boolean } = {}
  ): Promise<void> {
    const restoreInventory = options.restoreInventory ?? true;
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: { items: true },
    });
    if (!order) return;

    if (restoreInventory) {
      await prisma.$transaction(async tx => {
        for (const item of order.items) {
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
          if (item.variantId) {
            await tx.productVariant.update({
              where: { id: item.variantId },
              data: { inventory: { increment: item.quantity } },
            });
          }
          await tx.inventoryHistory.create({
            data: {
              productId: item.productId,
              storeId,
              type: 'return_stock',
              quantity: item.quantity,
              previousStock: prevStock,
              newStock: prevStock + item.quantity,
              reason: 'Order refunded',
              reference: orderId,
            },
          });
        }
      });
    }

    if (order.couponCode) {
      // Decrement back to zero floor — concurrent refunds shouldn't push
      // usageCount negative.
      await prisma.coupon.updateMany({
        where: { storeId, code: order.couponCode, usageCount: { gt: 0 } },
        data: { usageCount: { decrement: 1 } },
      });
    }

    // Reverse affiliate commission (no-op if none was paid for this order).
    await affiliateService
      .reverseCommission(storeId, orderId)
      .catch(err =>
        logger.error(
          { err, storeId, orderId },
          '[OrderService] Affiliate commission reversal failed during refund'
        )
      );
  }

  static async getCustomerOrders(
    storeId: string,
    customerId: string,
    options: { page?: number; limit?: number } = {}
  ) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(50, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.OrderWhereInput = { storeId, customerId, deletedAt: null };

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
