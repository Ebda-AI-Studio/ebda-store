import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { PaymentProvider, Currency } from '../services/payment-providers/types';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { prisma } from '@force/database';
import { paymentLimiter, auditLog } from '../middleware/security';
import { config } from '../config';

const router = Router();

// ==========================================
// Validation Schemas
// ==========================================

const createPaymentSchema = z.object({
  orderId: z.string().uuid(),
  provider: z.enum(['tap', 'myfatoorah', 'hesabe', 'upayments']).optional(),
  successUrl: z.string().url().optional(),
  errorUrl: z.string().url().optional(),
});

const refundSchema = z.object({
  transactionId: z.string(),
  amount: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

// ==========================================
// Helper Functions
// ==========================================

async function getDefaultStoreId(): Promise<string> {
  const store = await prisma.store.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!store) {
    throw new Error('No store configured');
  }
  return store.id;
}

function getUserFromRequest(req: Request): { userId: string; email: string; role: string } {
  if (!req.user) {
    throw new Error('User not authenticated');
  }
  return req.user;
}

// ==========================================
// Routes
// ==========================================

/**
 * GET /payments/config
 * Get payment configuration for Kuwait providers
 */
router.get('/config', (_req: Request, res: Response) => {
  const providers = PaymentService.getAvailableProviders();

  res.json({
    success: true,
    data: {
      providers,
      defaultProvider: config.defaultPaymentProvider,
      defaultCurrency: config.defaultCurrency,
      supportedCurrencies: ['KWD', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'BHD'],
      supportedMethods: ['knet', 'visa', 'mastercard', 'apple_pay', 'google_pay', 'samsung_pay'],
      testMode: config.paymentTestMode,
    },
  });
});

/**
 * GET /payments/methods
 * Get available payment methods for an amount
 */
router.get('/methods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const amount = parseInt(req.query.amount as string) || 1000;
    const currency = (req.query.currency as Currency) || 'KWD';
    const provider = req.query.provider as PaymentProvider | undefined;

    const methods = await PaymentService.getPaymentMethods(amount, currency, provider);

    res.json({
      success: true,
      data: { methods },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /payments/create
 * Create a payment for an order
 */
router.post('/create', authenticate, paymentLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createPaymentSchema.parse(req.body);
    const user = getUserFromRequest(req);

    // Verify the order belongs to the user
    const storeId = await getDefaultStoreId();
    const order = await prisma.order.findFirst({
      where: { id: data.orderId, storeId, customerId: user.userId },
      include: {
        items: { include: { product: true } },
        customer: true,
      },
    });

    if (!order) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Order not found' },
      });
      return;
    }

    // Create payment
    const result = await PaymentService.createPayment(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amount: order.total,
        currency: order.currency as Currency,
        customer: {
          id: user.userId,
          name: `${order.customer.firstName} ${order.customer.lastName}`,
          email: order.customer.email,
        },
        items: order.items.map(item => ({
          name: item.productName,
          quantity: item.quantity,
          unitPrice: item.price,
          sku: item.sku || undefined,
        })),
        callbackUrl: data.successUrl || `${config.webUrl}/checkout/success`,
        errorUrl: data.errorUrl || `${config.webUrl}/checkout/error`,
        webhookUrl: `${config.apiUrl}/webhooks/payment`,
      },
      data.provider
    );

    // Audit log
    await auditLog({
      action: 'payment.created',
      userId: user.userId,
      resourceType: 'payment',
      resourceId: result.transactionId,
      details: {
        orderId: order.id,
        amount: order.total,
        provider: result.provider,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      data: {
        transactionId: result.transactionId,
        paymentUrl: result.paymentUrl,
        provider: result.provider,
        paymentMethods: result.paymentMethods,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /payments/status/:transactionId
 * Get payment status
 */
router.get('/status/:transactionId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { transactionId } = req.params;
    const provider = req.query.provider as PaymentProvider | undefined;

    const status = await PaymentService.getPaymentStatus(transactionId, provider);

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /payments/refund
 * Refund a payment (admin only)
 */
router.post(
  '/refund',
  authenticate,
  requirePermission('orders:refund'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = refundSchema.parse(req.body);
      const user = getUserFromRequest(req);

      const refund = await PaymentService.refund({
        transactionId: data.transactionId,
        amount: data.amount,
        reason: data.reason,
      });

      // Audit log
      await auditLog({
        action: 'payment.refunded',
        userId: user.userId,
        resourceType: 'payment',
        resourceId: refund.transactionId,
        details: {
          refundId: refund.refundId,
          amount: refund.amount,
          reason: data.reason,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { refund },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /payments/retry/:paymentId
 * Retry a failed payment
 */
router.post('/retry/:paymentId', authenticate, paymentLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { paymentId } = req.params;
    const user = getUserFromRequest(req);
    const provider = req.body.provider as PaymentProvider | undefined;

    // Verify the payment belongs to user's order
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });

    if (!payment || payment.order.customerId !== user.userId) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Payment not found' },
      });
      return;
    }

    const result = await PaymentService.retryPayment(paymentId, provider);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /payments/order/:orderId
 * Get payment for an order
 */
router.get('/order/:orderId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderId } = req.params;
    const user = getUserFromRequest(req);

    // Verify the order belongs to the user (or user is admin)
    const storeId = await getDefaultStoreId();
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
    });

    if (!order) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Order not found' },
      });
      return;
    }

    if (order.customerId !== user.userId && user.role !== 'admin' && user.role !== 'super_admin') {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized' },
      });
      return;
    }

    const payment = await PaymentService.getPaymentByOrderId(orderId);

    res.json({
      success: true,
      data: { payment },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
