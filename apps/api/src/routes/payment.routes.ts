import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { PaymentProvider, Currency } from '../services/payment-providers/types';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { prisma } from '@force/database';
import { paymentLimiter, auditLog } from '../middleware/security';
import { config } from '../config';
import { getAuthUser } from '../utils/store-helpers';

const router = Router();

// ==========================================
// Validation Schemas
// ==========================================

// Validate that a URL is either a relative path or an absolute URL whose origin
// matches the platform's web URL or a verified store domain. This prevents
// open-redirect attacks where an attacker supplies an external domain as a callback URL.
function platformUrlOrRelative(url: string): boolean {
  // Allow relative paths (must start with /)
  if (url.startsWith('/')) return true;

  // For absolute URLs, only permit those pointing to our own web origin.
  // Store custom domain URLs are resolved server-side in the callback handler,
  // so client-supplied absolute URLs must match the platform origin.
  try {
    const parsed = new URL(url);
    const allowed = new URL(config.webUrl);
    return parsed.origin === allowed.origin;
  } catch {
    return false;
  }
}

const createPaymentSchema = z.object({
  orderId: z.string().uuid(),
  provider: z.enum(['tap', 'myfatoorah', 'hesabe', 'upayments', 'cod']).optional(),
  successUrl: z
    .string()
    .url()
    .optional()
    .refine(val => val === undefined || platformUrlOrRelative(val), {
      message: 'successUrl must be a relative path or a URL on the platform domain',
    }),
  errorUrl: z
    .string()
    .url()
    .optional()
    .refine(val => val === undefined || platformUrlOrRelative(val), {
      message: 'errorUrl must be a relative path or a URL on the platform domain',
    }),
});

const refundSchema = z.object({
  transactionId: z.string(),
  amount: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

// ==========================================
// Helper Functions
// ==========================================

// getUserFromRequest replaced by shared getAuthUser from ../utils/store-helpers

// ==========================================
// Routes
// ==========================================

/**
 * GET /payments/config
 * Get payment configuration for Kuwait providers
 */
router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const providers = await PaymentService.getAvailableProviders();
    const storeId = req.headers['x-store-id'] as string | undefined;

    // Check if COD is enabled for this store (or globally)
    let codConfig: { fixedFee: number; displayName: string; displayNameAr: string | null } | null =
      null;
    const codRecord = await prisma.paymentConfig.findFirst({
      where: {
        OR: [
          ...(storeId ? [{ storeId, provider: 'cod' as const, isEnabled: true }] : []),
          { storeId: null, provider: 'cod' as const, isEnabled: true },
        ],
      },
      orderBy: { storeId: 'desc' },
    });
    if (codRecord) {
      codConfig = {
        fixedFee: codRecord.fixedFee ? Number(codRecord.fixedFee) : 0,
        displayName: codRecord.displayName || 'Cash on Delivery',
        displayNameAr: codRecord.displayNameAr,
      };
    }

    res.json({
      success: true,
      data: {
        providers,
        cod: codConfig,
        defaultProvider: config.defaultPaymentProvider,
        defaultCurrency: config.defaultCurrency,
        supportedCurrencies: ['KWD', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'BHD'],
        supportedMethods: ['knet', 'visa', 'mastercard', 'apple_pay', 'google_pay', 'samsung_pay'],
        testMode: config.paymentTestMode,
      },
    });
  } catch (error) {
    next(error);
  }
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
router.post(
  '/create',
  authenticate,
  paymentLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createPaymentSchema.parse(req.body);
      const user = getAuthUser(req);

      // Derive storeId from the order itself — never rely on header fallback
      // for payment operations. The order already has the correct storeId.
      const order = await prisma.order.findFirst({
        where: { id: data.orderId, customerId: user.userId },
        include: {
          items: { include: { product: true } },
          customer: true,
          store: { select: { domain: true, slug: true } },
        },
      });

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      // ==========================================
      // COD (Cash on Delivery) — skip payment gateway
      // ==========================================
      if (data.provider === 'cod') {
        // Look up COD config for fee
        const codConfig = await prisma.paymentConfig.findFirst({
          where: {
            OR: [
              { storeId: order.storeId, provider: 'cod', isEnabled: true },
              { storeId: null, provider: 'cod', isEnabled: true },
            ],
          },
          orderBy: { storeId: 'desc' }, // Store-specific first, then global
        });

        if (!codConfig) {
          res.status(400).json({
            success: false,
            error: {
              code: 'COD_NOT_AVAILABLE',
              message: 'Cash on Delivery is not available for this store',
            },
          });
          return;
        }

        const codFee = codConfig.fixedFee ? Number(codConfig.fixedFee) : 0;

        // Add COD fee to order total if configured
        if (codFee > 0) {
          await prisma.order.update({
            where: { id: order.id },
            data: { total: order.total + codFee },
          });
        }

        // Create payment record with cod_pending status
        const payment = await prisma.payment.create({
          data: {
            orderId: order.id,
            provider: 'cod',
            method: 'cod',
            status: 'cod_pending',
            amount: order.total + codFee,
            currency: order.currency,
            metadata: { codFee, originalTotal: order.total },
          },
        });

        await auditLog({
          action: 'payment.created',
          userId: user.userId,
          resourceType: 'payment',
          resourceId: payment.id,
          details: {
            orderId: order.id,
            amount: order.total + codFee,
            codFee,
            provider: 'cod',
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        res.json({
          success: true,
          data: {
            transactionId: payment.id,
            provider: 'cod',
            cod: true,
            codFee,
          },
        });
        return;
      }

      // ==========================================
      // Online payment providers (Tap, MyFatoorah, etc.)
      // ==========================================

      // Resolve the correct storefront URL for payment callbacks
      const storefrontBaseUrl = order.store?.domain
        ? `https://${order.store.domain}`
        : order.store?.slug
          ? `${config.webUrl}/${order.store.slug}`
          : config.webUrl;

      // Create payment
      const result = await PaymentService.createPayment(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          amount: order.total,
          currency: order.currency as Currency,
          customer: {
            id: user.userId,
            name:
              `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
              'Customer',
            email: order.customer?.email || '',
          },
          items: order.items.map(item => ({
            name: item.productName,
            quantity: item.quantity,
            unitPrice: item.price,
            sku: item.sku || undefined,
          })),
          // Resolve relative paths against the order's storefront base URL so
          // payment providers always receive an absolute URL that points back
          // at the correct tenant domain (custom domain or platform slug).
          callbackUrl: data.successUrl
            ? data.successUrl.startsWith('/')
              ? `${storefrontBaseUrl}${data.successUrl}`
              : data.successUrl
            : `${storefrontBaseUrl}/checkout/success`,
          errorUrl: data.errorUrl
            ? data.errorUrl.startsWith('/')
              ? `${storefrontBaseUrl}${data.errorUrl}`
              : data.errorUrl
            : `${storefrontBaseUrl}/checkout/error`,
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
  }
);

/**
 * GET /payments/status/:transactionId
 * Get payment status
 */
router.get(
  '/status/:transactionId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { transactionId } = req.params;
      const user = getAuthUser(req);
      const provider = req.query.provider as PaymentProvider | undefined;

      // Verify authorization: customers can only see their own payments,
      // store_admins can only see payments from their stores.
      if (user.role === 'super_admin') {
        // Super admin can view any payment
      } else if (user.role === 'store_admin') {
        // Store admin must own the store the order belongs to
        const order = await prisma.order.findFirst({
          where: {
            payments: { some: { transactionId } },
            store: { ownerId: user.userId },
          },
        });
        if (!order) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Payment not found' },
          });
          return;
        }
      } else {
        // Customer — must own the order
        const order = await prisma.order.findFirst({
          where: {
            customerId: user.userId,
            payments: { some: { transactionId } },
          },
        });
        if (!order) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Payment not found' },
          });
          return;
        }
      }

      const status = await PaymentService.getPaymentStatus(transactionId, provider);

      res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      next(error);
    }
  }
);

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
      const user = getAuthUser(req);

      // Verify store ownership for store_admin — prevent refunding other stores' payments
      if (user.role === 'store_admin') {
        const payment = await prisma.payment.findFirst({
          where: { transactionId: data.transactionId },
          include: { order: { include: { store: { select: { ownerId: true } } } } },
        });
        if (!payment || payment.order.store.ownerId !== user.userId) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Payment not found' },
          });
          return;
        }
      }

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
          reason: data.reason || null,
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
router.post(
  '/retry/:paymentId',
  authenticate,
  paymentLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { paymentId } = req.params;
      const user = getAuthUser(req);
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
  }
);

/**
 * GET /payments/order/:orderId
 * Get payment for an order
 */
router.get(
  '/order/:orderId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const user = getAuthUser(req);

      // Verify authorization based on role — derive access from the order itself.
      let order;
      if (user.role === 'super_admin') {
        order = await prisma.order.findUnique({ where: { id: orderId } });
      } else if (user.role === 'store_admin') {
        // Store admin can only see orders from stores they own
        order = await prisma.order.findFirst({
          where: { id: orderId, store: { ownerId: user.userId } },
        });
      } else {
        // Customer — can only see their own orders
        order = await prisma.order.findFirst({
          where: { id: orderId, customerId: user.userId },
        });
      }

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
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
  }
);

export default router;
