import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { OrderService } from '../services/order.service';
import { InvoiceService } from '../services/invoice.service';
import { requirePermission, requireRole } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { prisma } from '@force/database';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

// Validation schemas
const addressSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  company: z.string().optional(),
  address1: z.string().min(1),
  address2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().optional().default(''),
  country: z.string().min(2).max(2),
  phone: z.string().optional(),
});

const createOrderSchema = z.object({
  shippingAddress: addressSchema,
  billingAddress: addressSchema.optional(),
  paymentMethod: z.string(),
  notes: z.string().optional(),
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

// GET /stores/:storeId/orders - List orders
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { page, limit, status } = req.query;

    // Check if admin or getting own orders
    const isAdmin = ['store_admin', 'super_admin'].includes(req.user?.role || '');

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

// GET /stores/:storeId/orders/:id - Get order
router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId, id } = req.params;

    const order = await OrderService.getById(storeId, id);

    // Check authorization
    const isAdmin = ['store_admin', 'super_admin'].includes(req.user?.role || '');
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
  requireRole(['store_admin', 'super_admin']),
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

export default router;
