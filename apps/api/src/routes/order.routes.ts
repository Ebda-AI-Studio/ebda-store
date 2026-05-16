import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess, checkStoreAccess } from '../middleware/store-access';
import { OrderService } from '../services/order.service';
import { InvoiceService } from '../services/invoice.service';
import { requirePermission, requireRole } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { prisma } from '@force/database';
import { inngest } from '../lib/inngest/client';
import logger from '../lib/logger';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { config } from '../config';
import type { Currency } from '../services/payment-providers/types';

const router = Router({ mergeParams: true });

// Validation schemas
//
// Kuwait-friendly address validation: state and postalCode are not universally
// applicable (Kuwait uses governorate names but no postal codes for delivery).
// We accept loose strings, allow Arabic + Latin characters via the generous
// `min(1)` only on the truly-required fields (firstName, lastName, address1,
// city, country), and make state/postalCode optional with empty defaults so a
// missing value does not block checkout. Country accepts ISO-2 (e.g. "KW") or
// a longer name; the web sends "KW" but addresses created via the API for
// older accounts may use full country names.
const addressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  company: z.string().max(150).optional(),
  address1: z.string().trim().min(1).max(500),
  address2: z.string().max(500).optional(),
  city: z.string().trim().min(1).max(150),
  state: z.string().max(150).optional().default(''),
  postalCode: z.string().max(30).optional().default(''),
  country: z.string().trim().min(2).max(60),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
});

const createOrderSchema = z.object({
  shippingAddress: addressSchema,
  billingAddress: addressSchema.optional(),
  paymentMethod: z.string(),
  notes: z.string().max(2000).optional(),
  couponCode: z.string().trim().min(1).max(50).optional(),
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
    const { page, limit, status } = req.query;
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
  authorize('store_admin', 'super_admin'),
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const html = await InvoiceService.generateInvoice(storeId, orderId);
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
  authorize('store_admin', 'super_admin'),
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
  authorize('store_admin', 'super_admin'),
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
  authorize('store_admin', 'super_admin'),
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
  authorize('store_admin', 'super_admin'),
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
          webhookUrl: `${config.apiUrl}/webhooks/payment`,
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

export default router;
