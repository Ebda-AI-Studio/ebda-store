import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess, checkStoreAccess } from '../middleware/store-access';
import { OrderService } from '../services/order.service';
import { InvoiceService } from '../services/invoice.service';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { prisma } from '@force/database';
import { inngest } from '../lib/inngest/client';
import logger from '../lib/logger';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { recordPaymentEvent } from '../services/payment-event.service';
import { confirmPaymentFromProviderStatus } from '../services/payment-confirm.service';
import { runInTenantContext } from '@force/database';
import { config } from '../config';
import type { Currency } from '../services/payment-providers/types';

const router = Router({ mergeParams: true });

// Validation schemas
//
// Kuwait-friendly address validation: state and postalCode are not universally
// applicable (Kuwait uses governorate names but no postal codes for delivery).
// City is also optional — Kuwait deliveries route on `area` (governorate /
// district name) which we already capture in `state`. The storefront no
// longer asks for a city; admin manual orders may still set one.
const addressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  company: z.string().max(150).optional(),
  address1: z.string().trim().min(1).max(500),
  address2: z.string().max(500).optional(),
  city: z.string().max(150).optional().default(''),
  state: z.string().max(150).optional().default(''),
  postalCode: z.string().max(30).optional().default(''),
  country: z.string().trim().min(2).max(60),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
});

const createOrderSchema = z.object({
  shippingAddress: addressSchema,
  billingAddress: addressSchema.optional(),
  paymentMethod: z.string(),
  notes: z.string().max(2000).optional(),
  couponCode: z.string().trim().min(1).max(50).optional(),
  // Loyalty points requested for redemption — re-resolved server-side
  // against the customer's balance + store caps (never a trusted discount).
  pointsToRedeem: z.number().int().min(0).max(100_000_000).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum([
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'refunded',
  ]),
});

// Helper to get session ID
const getSessionId = (req: Request): string => {
  const sessionId = req.headers['x-session-id'] as string;
  if (!sessionId) {
    throw Object.assign(new Error('Session ID required'), { statusCode: 400 });
  }
  return sessionId;
};

// GET /stores/:storeId/orders - List orders.
//
// Mixed-audience route: admins paginate every order in the store;
// customers see only their own. We can't blanket-apply
// `requireStoreAccess` because that rejects customers (they don't own
// the store). Instead, branch by role:
//   - admin → require ownership of this store via inline check
//   - customer → constrain the query to their own customerId
// Without this branch, ANY store_admin token used to be able to read
// any other tenant's orders by changing :storeId in the URL.
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { page, limit, status, from, to } = req.query;
    const role = req.user?.role;
    const isAdmin = role === 'store_admin' || role === 'super_admin';

    if (isAdmin) {
      const access = await checkStoreAccess(storeId, req.user!);
      if (!access.ok) {
        res
          .status(access.status)
          .json({ success: false, error: { code: access.code, message: access.message } });
        return;
      }
    }

    const result = await OrderService.list(storeId, {
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      status: status as string,
      customerId: isAdmin ? undefined : req.user?.userId,
      from: from ? new Date(String(from) + 'T00:00:00') : undefined,
      to: to ? new Date(String(to) + 'T23:59:59') : undefined,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// GET /stores/:storeId/orders/:id - Get order. Mixed-audience like the
// list above: admin needs store ownership; customer needs to own the
// order. Without the admin-side check, ANY store_admin token used to
// read any other tenant's individual orders.
router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId, id } = req.params;
    const role = req.user?.role;
    const isAdmin = role === 'store_admin' || role === 'super_admin';

    if (isAdmin) {
      const access = await checkStoreAccess(storeId, req.user!);
      if (!access.ok) {
        res
          .status(access.status)
          .json({ success: false, error: { code: access.code, message: access.message } });
        return;
      }
    }

    const order = await OrderService.getById(storeId, id);

    if (!isAdmin && order.customerId !== req.user?.userId) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized to view this order' },
      });
      return;
    }

    res.json({
      success: true,
      data: { order },
    });
  } catch (error) {
    next(error);
  }
});

// POST /stores/:storeId/orders - Create order (checkout)
router.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const sessionId = getSessionId(req);
    const data = createOrderSchema.parse(req.body);

    // Affiliate referral code from body or header
    const referralCode: string | undefined =
      (req.body.affiliateRef as string | undefined) ||
      (req.headers['x-affiliate-ref'] as string | undefined) ||
      undefined;

    const order = await OrderService.create(
      storeId,
      getAuthUser(req).userId,
      sessionId,
      data,
      referralCode
    );

    res.status(201).json({
      success: true,
      data: { order },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /stores/:storeId/orders/:id/status - Update order status
router.put(
  '/:id/status',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requirePermission('orders:manage'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { status } = updateStatusSchema.parse(req.body);

      const previousOrder = await OrderService.getById(storeId, id);
      const order = await OrderService.updateStatus(storeId, id, status);

      // Audit log
      await auditLog({
        action: 'order.status.updated',
        userId: getAuthUser(req).userId,
        resourceType: 'order',
        resourceId: id,
        details: { previousStatus: previousOrder.status, newStatus: status },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { order },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/orders/:orderId/invoice - Generate order invoice (admin only)
// Customers access their own invoices via the public routes which enforce ownership checks.
// This route is restricted to store admins to prevent IDOR — any authenticated user
// should not be able to retrieve another customer's invoice by guessing an orderId.
router.get(
  '/:orderId/invoice',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      // ?locale=ar renders an Arabic RTL invoice; ?locale=en forces English.
      // Falls back to order.locale (captured at checkout) when omitted.
      const locale = typeof req.query.locale === 'string' ? req.query.locale : undefined;
      const html = await InvoiceService.generateInvoice(storeId, orderId, locale);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/invoice/email
 * Queue an invoice email send. Returns 202 immediately — the actual
 * SMTP send happens on the Inngest queue with retries.
 */
router.post(
  '/:orderId/invoice/email',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const order = await OrderService.getById(storeId, orderId);
      const customerEmail =
        order.customer?.email ?? (order.shippingAddress as Record<string, string> | null)?.email;
      if (!customerEmail) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_EMAIL', message: 'Order has no customer email on file' },
        });
        return;
      }

      await inngest.send({
        name: 'order/invoice.email-requested',
        data: { orderId, storeId, to: customerEmail },
      });

      await auditLog({
        action: 'order.invoice.email-queued',
        userId: getAuthUser(req).userId,
        resourceType: 'order',
        resourceId: orderId,
        details: { to: customerEmail },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(202).json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/orders/my - Get customer's own orders
router.get('/my/list', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;

    const { page, limit } = req.query;
    const result = await OrderService.getCustomerOrders(storeId, getAuthUser(req).userId, {
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// COD Mark as Paid
// ==========================================

/**
 * POST /stores/:storeId/orders/:orderId/mark-paid
 * Mark a COD order as paid (admin only)
 */
router.post(
  '/:orderId/mark-paid',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);

      const order = await prisma.order.findFirst({
        where: { id: orderId, storeId },
        include: { payments: true },
      });

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      // Verify this is a COD order
      const codPayment = order.payments.find(p => p.provider === 'cod');
      if (!codPayment) {
        res.status(400).json({
          success: false,
          error: { code: 'NOT_COD', message: 'This order is not a Cash on Delivery order' },
        });
        return;
      }

      if (order.paymentStatus === 'paid') {
        res.status(400).json({
          success: false,
          error: { code: 'ALREADY_PAID', message: 'Order is already marked as paid' },
        });
        return;
      }

      // Update payment and order status atomically
      await prisma.$transaction([
        prisma.payment.update({
          where: { id: codPayment.id },
          data: { status: 'completed', paidAt: new Date() },
        }),
        prisma.order.update({
          where: { id: orderId },
          data: { paymentStatus: 'paid', status: 'confirmed' },
        }),
      ]);

      // Append-only audit row for the COD completion.
      await recordPaymentEvent({
        paymentId: codPayment.id,
        storeId: order.storeId,
        orderId,
        eventType: 'status_change',
        fromStatus: codPayment.status,
        toStatus: 'completed',
        provider: 'cod',
        triggeredByUserId: user.userId,
        details: { reason: 'cod_marked_paid', orderNumber: order.orderNumber },
      });

      // Fire the same post-payment fanout the webhook handler does —
      // accounting journal + WhatsApp WBS notification both rely on this event.
      inngest
        .send({
          name: 'order/created',
          data: {
            orderId,
            storeId: order.storeId,
            paymentMethod: codPayment.provider,
            locale: undefined,
          },
        })
        .catch((err: unknown) =>
          logger.error({ err, orderId }, '[COD] Failed to enqueue order/created')
        );

      await auditLog({
        action: 'order.cod_marked_paid',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: { orderNumber: order.orderNumber, amount: codPayment.amount },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info({ orderId, orderNumber: order.orderNumber }, '[COD] Order marked as paid');

      res.json({
        success: true,
        data: { message: 'Order marked as paid', orderNumber: order.orderNumber },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/bulk-mark-paid
 * Mark multiple COD orders as paid (admin only)
 */
router.post(
  '/bulk-mark-paid',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const user = getAuthUser(req);
      const { orderIds } = z
        .object({ orderIds: z.array(z.string().uuid()).min(1).max(50) })
        .parse(req.body);

      // Fetch all orders with their COD payments
      const orders = await prisma.order.findMany({
        where: {
          id: { in: orderIds },
          storeId,
          paymentStatus: { not: 'paid' },
        },
        include: { payments: { where: { provider: 'cod' } } },
      });

      // Filter to only COD orders with pending payments
      const codOrders = orders.filter(o => o.payments.length > 0);

      if (codOrders.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_COD_ORDERS', message: 'No eligible COD orders found' },
        });
        return;
      }

      // Build update operations
      const updates = codOrders.flatMap(order => [
        prisma.payment.update({
          where: { id: order.payments[0].id },
          data: { status: 'completed', paidAt: new Date() },
        }),
        prisma.order.update({
          where: { id: order.id },
          data: { paymentStatus: 'paid', status: 'confirmed' },
        }),
      ]);

      await prisma.$transaction(updates);

      // Append-only audit rows — one per payment flipped. Fire-and-forget
      // (Promise.allSettled) so a transient log-write failure on one row
      // doesn't break the bulk action for the others.
      await Promise.allSettled(
        codOrders.map(o =>
          recordPaymentEvent({
            paymentId: o.payments[0].id,
            storeId: o.storeId,
            orderId: o.id,
            eventType: 'status_change',
            fromStatus: o.payments[0].status,
            toStatus: 'completed',
            provider: 'cod',
            triggeredByUserId: user.userId,
            details: { reason: 'cod_bulk_marked_paid', orderNumber: o.orderNumber },
          })
        )
      );

      // Fire one order/created event per updated order so accounting journal +
      // WBS WhatsApp both receive the paid notification. Promise.allSettled so
      // one failed enqueue doesn't block the response or the others.
      await Promise.allSettled(
        codOrders.map(o =>
          inngest
            .send({
              name: 'order/created',
              data: {
                orderId: o.id,
                storeId: o.storeId,
                paymentMethod: o.payments[0].provider,
                locale: undefined,
              },
            })
            .catch((err: unknown) =>
              logger.error({ err, orderId: o.id }, '[COD bulk] Failed to enqueue order/created')
            )
        )
      );

      await auditLog({
        action: 'order.cod_bulk_marked_paid',
        userId: user.userId,
        resourceType: 'order',
        details: {
          count: codOrders.length,
          orderNumbers: codOrders.map(o => o.orderNumber).join(', '),
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info({ count: codOrders.length, storeId }, '[COD] Bulk orders marked as paid');

      res.json({
        success: true,
        data: {
          message: `${codOrders.length} order(s) marked as paid`,
          updated: codOrders.length,
          skipped: orderIds.length - codOrders.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/refresh-payment-status
 *
 * Manual sync — admin clicks "refresh" on the order detail page to
 * re-check payment status with the provider (MyFatoorah / Tap /
 * etc.) and update our DB accordingly. Use when a webhook didn't
 * fire (provider portal misconfigured, signature mismatch, etc.)
 * but the customer says they paid.
 *
 * Mirrors the webhook handler's state-transition logic so manual
 * refresh produces the same Order + Payment + downstream side
 * effects (Inngest fanout, socket emit) as a regular webhook.
 */
router.post(
  '/:orderId/refresh-payment-status',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);

      const order = await prisma.order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      const payment = order.payments[0];
      if (!payment || !payment.transactionId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_PAYMENT_RECORD',
            message:
              'No payment record found for this order. Issue a payment link first, then retry.',
          },
        });
        return;
      }

      // Hit the provider directly (PaymentService picks the right provider
      // from the stored payment row).
      const status = await PaymentService.getPaymentStatus(
        payment.transactionId,
        payment.provider as 'tap' | 'myfatoorah' | 'hesabe' | 'upayments',
        storeId
      );

      // Reconcile via the shared idempotent helper — the SAME routine the
      // guest verify-on-return endpoint uses, so manual refresh + webhook +
      // verify-on-return all transition state identically and only fan out
      // once. (single source of truth — `payment-confirm.service.ts`)
      const { statusChanged } = await confirmPaymentFromProviderStatus({
        payment: {
          id: payment.id,
          status: payment.status,
          provider: payment.provider,
          metadata: payment.metadata,
        },
        order: {
          id: order.id,
          storeId: order.storeId,
          paymentStatus: order.paymentStatus,
          locale: order.locale,
        },
        providerStatus: status,
        source: 'admin_refresh',
        triggeredByUserId: user.userId,
      });

      await auditLog({
        action: 'order.payment_refreshed',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: {
          orderNumber: order.orderNumber,
          providerStatus: status.status,
          statusChanged,
          previousPaymentStatus: order.paymentStatus,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        {
          orderId,
          orderNumber: order.orderNumber,
          providerStatus: status.status,
          statusChanged,
        },
        '[Refresh] manual payment-status sync'
      );

      res.json({
        success: true,
        data: {
          providerStatus: status.status,
          paymentStatus: status.status === 'completed' ? 'paid' : status.status,
          statusChanged,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/refresh-refund-status
 *
 * Manual sync — admin clicks "Refresh refund status" on the order detail
 * page to ask the payment provider whether a previously-submitted refund
 * has been executed yet. Safety net for when the refund webhook didn't
 * arrive (provider portal misconfigured, signature mismatch, the merchant
 * issued the refund out-of-band in the provider portal).
 *
 * MyFatoorah refunds start as Pending → finance team executes →
 * "Refunded" (or rejects → "Canceled"). The provider notifies us via
 * webhook, but this endpoint is the pull-side equivalent.
 */
router.post(
  '/:orderId/refresh-refund-status',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);

      // Find the most-recent payment row that has a refundId (i.e. has
      // been refunded via the provider). Skips COD / status-button-only
      // refunds which have no provider refund record to ask about.
      const payment = await prisma.payment.findFirst({
        where: {
          orderId,
          order: { storeId },
          refundId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!payment || !payment.refundId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_REFUND_RECORD',
            message:
              'No refund record found for this order. Issue a refund via provider first, then refresh.',
          },
        });
        return;
      }

      // Call the provider's GetRefundStatus. Optional on IPaymentProvider —
      // PaymentService.getRefundStatus refuses gracefully when the chosen
      // provider doesn't implement it.
      const status = await runInTenantContext(storeId, () =>
        PaymentService.getRefundStatus(
          payment.refundId!,
          payment.provider as 'tap' | 'myfatoorah' | 'hesabe' | 'upayments',
          storeId
        )
      );

      const prevMeta = (payment.metadata as Record<string, unknown>) || {};
      const prevStatus = (prevMeta.refundStatus as string | undefined) || 'pending';
      const statusChanged = prevStatus !== status.status;

      // Update Payment.metadata with the fresh status. If the provider
      // says the refund completed and our Payment row isn't marked
      // refunded yet (out-of-band path), promote it now.
      const updateData: Record<string, unknown> = {
        metadata: {
          ...prevMeta,
          refundStatus: status.status,
          refundReference: status.refundReference ?? prevMeta.refundReference,
          refundStatusCheckedAt: new Date().toISOString(),
        },
      };
      if (
        status.status === 'completed' &&
        payment.status !== 'refunded' &&
        payment.status !== 'partially_refunded'
      ) {
        updateData.status = 'refunded';
        updateData.refundedAmount = status.refundedAmount ?? status.amount ?? 0;
      }
      await prisma.payment.update({
        where: { id: payment.id },
        data: updateData,
      });

      // Append-only audit row. Records the refund-status refresh — fromStatus
      // is the pre-update payment status; toStatus is what we just wrote (or
      // null when only metadata changed without a status flip).
      await recordPaymentEvent({
        paymentId: payment.id,
        storeId,
        orderId,
        eventType: 'reconciliation',
        fromStatus: payment.status,
        toStatus: (updateData.status as typeof payment.status | undefined) ?? null,
        provider: payment.provider,
        triggeredByUserId: user.userId,
        details: {
          reason: 'manual_refund_status_refresh',
          providerStatus: status.status,
          refundId: payment.refundId,
          refundedAmount: updateData.refundedAmount ?? null,
        },
      });

      // If this is the first time we see the refund as executed AND no
      // applyRefundEffects ever ran (Payment.status was still completed),
      // fire it now — inventory restore + customer email + admin push.
      const needsSideEffects =
        status.status === 'completed' && statusChanged && payment.status === 'completed';
      if (needsSideEffects) {
        await OrderService.applyRefundEffects(storeId, orderId).catch((err: unknown) =>
          logger.error(
            { err, orderId, storeId },
            '[refresh-refund-status] applyRefundEffects failed'
          )
        );
        await prisma.order
          .update({
            where: { id: orderId },
            data: { status: 'refunded', paymentStatus: 'refunded' },
          })
          .catch((err: unknown) =>
            logger.error({ err, orderId }, '[refresh-refund-status] order status update failed')
          );
      }

      await auditLog({
        action: 'order.refund_status_refreshed',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: {
          refundId: payment.refundId,
          providerStatus: status.status,
          statusChanged,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        {
          orderId,
          refundId: payment.refundId,
          providerStatus: status.status,
          statusChanged,
        },
        '[Refund] manual refund-status sync'
      );

      res.json({
        success: true,
        data: {
          providerStatus: status.status,
          refundStatus: status.status,
          refundedAmount: status.refundedAmount,
          refundReference: status.refundReference,
          statusChanged,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/refund-via-provider
 *
 * Admin-initiated refund. Calls the payment provider's refund API
 * (MyFatoorah / Tap / etc.), then PaymentService.refund handles the
 * DB transaction (Payment.status -> refunded, Order.status -> refunded)
 * and OrderService.applyRefundEffects fans out side effects:
 *   - inventory restore (track_inventory products)
 *   - coupon usage decrement
 *   - affiliate commission reversal
 *   - loyalty points reversal (NEW — was missing before)
 *   - order/refunded Inngest event → customer refund email + admin push
 *
 * Defaults to full refund. Partial refunds: pass `amount` (in fils).
 */
const refundViaProviderSchema = z.object({
  amount: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
});

router.post(
  '/:orderId/refund-via-provider',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);
      const data = refundViaProviderSchema.parse(req.body ?? {});

      const order = await prisma.order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        include: {
          payments: {
            where: { status: 'completed' },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });
      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      const payment = order.payments[0];
      if (!payment || !payment.transactionId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_COMPLETED_PAYMENT',
            message:
              'No completed online payment found for this order. COD orders cannot be refunded via the provider — use the manual "Refunded" status instead.',
          },
        });
        return;
      }

      if (order.paymentStatus === 'refunded') {
        res.status(400).json({
          success: false,
          error: {
            code: 'ALREADY_REFUNDED',
            message: 'This order has already been fully refunded.',
          },
        });
        return;
      }

      // Capture provider errors specifically so the admin sees what the
      // gateway actually said instead of a generic 500. MyFatoorah refunds
      // need explicit "Refund" permission enabled on the merchant account
      // in the provider portal — first attempt commonly fails with that.
      let result;
      try {
        result = await runInTenantContext(storeId, async () =>
          PaymentService.refund({
            transactionId: payment.transactionId!,
            amount: data.amount,
            reason: data.reason,
          })
        );
      } catch (providerError) {
        const providerMessage =
          providerError instanceof Error ? providerError.message : 'Unknown provider error';
        logger.error(
          {
            err: providerError,
            orderId,
            orderNumber: order.orderNumber,
            transactionId: payment.transactionId,
            provider: payment.provider,
            amount: data.amount,
          },
          '[Refund] provider refund call failed'
        );
        // Surface the provider's own message in the customer-visible
        // error string so the admin doesn't have to dig through Railway
        // logs to know what went wrong. Append a hint for the common
        // "permission not enabled" case which is the #1 first-time
        // failure mode on MyFatoorah accounts.
        const hint =
          payment.provider === 'myfatoorah'
            ? ' (verify Refund permission is enabled on this account in the MyFatoorah portal: Settings → API Permissions → MakeRefund)'
            : '';
        res.status(502).json({
          success: false,
          error: {
            code: 'REFUND_PROVIDER_ERROR',
            message: `${providerMessage}${hint}`,
          },
        });
        return;
      }

      await auditLog({
        action: 'order.refund_via_provider',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: {
          orderNumber: order.orderNumber,
          refundId: result.refundId,
          refundAmount: result.amount,
          provider: payment.provider,
          reason: data.reason ?? null,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        {
          orderId,
          orderNumber: order.orderNumber,
          refundId: result.refundId,
          refundAmount: result.amount,
          provider: payment.provider,
        },
        '[Refund] admin-initiated provider refund'
      );

      res.json({
        success: true,
        data: {
          refundId: result.refundId,
          refundAmount: result.amount,
          provider: result.provider,
          status: result.status,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/admin
 *
 * Admin-initiated order creation. Used for phone orders / merchant-
 * placed orders where the customer isn't checking out themselves.
 * Skips the cart entirely; admin submits line items directly.
 * After save, the merchant can issue a payment link via the
 * existing /payment-link endpoint.
 */
const adminOrderItemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(999),
});
const adminOrderSchema = z.object({
  customerId: z.string().uuid().optional(),
  shippingAddress: z.record(z.unknown()),
  billingAddress: z.record(z.unknown()).optional(),
  items: z.array(adminOrderItemSchema).min(1),
  paymentMethod: z.enum(['online', 'cod']).optional(),
  paymentProvider: z.enum(['tap', 'myfatoorah', 'hesabe', 'upayments', 'cod']).optional(),
  notes: z.string().optional(),
  couponCode: z.string().optional(),
  currency: z.string().optional(),
});

router.post(
  '/admin',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const user = getAuthUser(req);
      const data = adminOrderSchema.parse(req.body ?? {});

      const order = await OrderService.createAdminOrder(storeId, user.userId, data);

      res.json({
        success: true,
        data: { order },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/payment-link
 *
 * Issue a MyFatoorah payment link for an existing order. Used by the
 * merchant when a customer couldn't complete checkout on the original
 * payment flow (e.g. KNET timeout, gateway blocked, customer abandoned
 * and asked for the link via WhatsApp).
 *
 * Body:
 *   - notifyVia: 'link' | 'email' | 'all'  (default 'link')
 *     'link'  → return URL only, merchant copies + sends manually
 *     'email' → MyFatoorah sends email to the customer
 *     'all'   → MyFatoorah sends SMS + email (NB: SMS not surfaced in
 *               UI yet, but the provider supports it natively)
 *
 * The endpoint reuses the same `PaymentService.createPayment` path as
 * the public checkout — same per-store credentials, same callback +
 * webhook URLs — so a paid link still triggers the existing webhook +
 * order-status pipeline.
 */
const issuePaymentLinkSchema = z.object({
  notifyVia: z.enum(['link', 'email', 'all']).optional().default('link'),
});

router.post(
  '/:orderId/payment-link',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);
      const { notifyVia } = issuePaymentLinkSchema.parse(req.body ?? {});

      const order = await prisma.order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        include: {
          items: true,
          customer: {
            select: { id: true, email: true, firstName: true, lastName: true, phone: true },
          },
          store: {
            select: { id: true, slug: true, domain: true, name: true, nameAr: true },
          },
        },
      });

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      if (order.paymentStatus === 'paid') {
        res.status(400).json({
          success: false,
          error: {
            code: 'ALREADY_PAID',
            message: 'Order is already paid — no need to issue a new link',
          },
        });
        return;
      }

      // Same storefront URL resolution the public checkout uses, so the
      // payment-success / payment-error callbacks land on the correct
      // tenant domain whether they have a custom domain or platform slug.
      const storefrontBaseUrl = order.store?.domain
        ? `https://${order.store.domain}`
        : order.store?.slug
          ? `${config.webUrl}/${order.store.slug}`
          : config.webUrl;

      const shipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
      const customerName =
        `${order.customer?.firstName ?? shipping.firstName ?? ''} ${order.customer?.lastName ?? shipping.lastName ?? ''}`.trim() ||
        'Customer';
      const customerEmail = order.customer?.email || shipping.email || '';
      const customerPhone = order.customer?.phone || shipping.phone || undefined;

      // MyFatoorah rejects empty email with 400 — bail early with a
      // friendly error so the merchant knows they need an email on the
      // order before they can issue a link.
      if (notifyVia !== 'link' && !customerEmail) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_CUSTOMER_EMAIL',
            message:
              'Cannot send the link via email — this order has no customer email on file. Pick "Copy link" and share it manually.',
          },
        });
        return;
      }

      const result = await PaymentService.createPayment(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          amount: order.total,
          currency: order.currency as Currency,
          customer: {
            id: order.customer?.id ?? `guest-${order.id}`,
            name: customerName,
            email: customerEmail,
            phone: customerPhone,
          },
          items: order.items.map(item => ({
            name: item.productName,
            quantity: item.quantity,
            unitPrice: item.price,
            sku: item.sku || undefined,
          })),
          callbackUrl: `${storefrontBaseUrl}/checkout/success`,
          errorUrl: `${storefrontBaseUrl}/checkout/error`,
          webhookUrl: `${config.apiUrl}/api/v1/webhooks/payment/myfatoorah`,
          notifyVia,
        },
        'myfatoorah',
        storeId
      );

      await auditLog({
        action: 'order.payment_link_issued',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: {
          orderNumber: order.orderNumber,
          notifyVia,
          invoiceId: result.invoiceId ?? null,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        { orderId, orderNumber: order.orderNumber, notifyVia, invoiceId: result.invoiceId },
        '[Payment-Link] issued by merchant'
      );

      res.json({
        success: true,
        data: {
          paymentUrl: result.paymentUrl,
          invoiceId: result.invoiceId,
          notifyVia,
          customerEmail: notifyVia !== 'link' ? customerEmail : undefined,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /stores/:storeId/orders/:orderId/timeline
// ==========================================

interface TimelineRow {
  at: string;
  source: 'audit' | 'shipment' | 'order';
  kind: string;
  fromStatus?: string;
  toStatus?: string;
  details?: string;
  actorName?: string;
  location?: string;
}

interface ShipmentHistoryEntry {
  status: string;
  timestamp: string;
  location?: string;
  description?: string;
}

/**
 * GET /stores/:storeId/orders/:orderId/timeline
 *
 * Mixed-audience: admins authenticated via checkStoreAccess; customers
 * verified by matching their own customerId on the order. actorName is
 * redacted for non-admin callers.
 */
router.get(
  '/:storeId/orders/:orderId/timeline',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = (req as any).user;

      // Resolve caller role — try admin middleware first, then customer check.
      let isAdmin = false;
      if (user) {
        if (user.role === 'super_admin' || user.role === 'store_admin') {
          // Verify the admin actually owns this store (reuse prisma check)
          const store = await prisma.store.findFirst({
            where: { id: storeId, ...(user.role !== 'super_admin' ? { userId: user.userId } : {}) },
            select: { id: true },
          });
          if (store) isAdmin = true;
        }
      }

      // Fetch the order to get customerId + synthetic event dates
      const order = await prisma.order.findFirst({
        where: { id: orderId, storeId },
        select: {
          id: true,
          customerId: true,
          shippedAt: true,
          deliveredAt: true,
          createdAt: true,
          // Order has a single optional Shipment relation (not an array).
          shipment: {
            select: { statusHistory: true },
          },
        },
      });

      if (!order) {
        res.status(404).json({ success: false, error: { message: 'Order not found' } });
        return;
      }

      // For non-admin callers verify ownership
      if (!isAdmin) {
        if (!user || order.customerId !== user.userId) {
          res.status(403).json({ success: false, error: { message: 'Forbidden' } });
          return;
        }
      }

      const rows: TimelineRow[] = [];

      // 1. Audit log entries for this order
      const audits = await prisma.auditLog.findMany({
        where: { storeId, resourceType: 'order', resourceId: orderId },
        include: { user: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      const auditKinds = new Set<string>();
      for (const a of audits) {
        auditKinds.add(a.action);
        const d = a.details as Record<string, any>;
        rows.push({
          at: a.createdAt.toISOString(),
          source: 'audit',
          kind: a.action,
          fromStatus: d?.fromStatus ?? d?.from,
          toStatus: d?.toStatus ?? d?.to,
          details: d?.notes ?? d?.description,
          actorName:
            isAdmin && a.user
              ? `${a.user.firstName ?? ''} ${a.user.lastName ?? ''}`.trim()
              : undefined,
        });
      }

      // 2. Shipment status history entries
      const shipment = order.shipment;
      if (shipment) {
        const history = (shipment.statusHistory as unknown as ShipmentHistoryEntry[]) ?? [];
        for (const entry of history) {
          rows.push({
            at: entry.timestamp,
            source: 'shipment',
            kind: `shipment.${entry.status}`,
            details: entry.description,
            location: entry.location,
          });
        }
      }

      // 3. Synthetic order-level events for shippedAt/deliveredAt when no
      //    matching audit log entry exists (avoids duplication)
      if (order.shippedAt && !auditKinds.has('order.shipped')) {
        rows.push({ at: order.shippedAt.toISOString(), source: 'order', kind: 'order.shipped' });
      }
      if (order.deliveredAt && !auditKinds.has('order.delivered')) {
        rows.push({
          at: order.deliveredAt.toISOString(),
          source: 'order',
          kind: 'order.delivered',
        });
      }
      // Order creation event
      if (!auditKinds.has('order.created')) {
        rows.push({ at: order.createdAt.toISOString(), source: 'order', kind: 'order.created' });
      }

      // Sort newest first
      rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

      res.json({ success: true, data: { timeline: rows.slice(0, 200) } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
