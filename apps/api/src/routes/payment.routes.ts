import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { PaymentProvider, Currency } from '../services/payment-providers/types';
import { authenticate, optionalAuthenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { prisma, runInTenantContext } from '@force/database';
import { paymentLimiter, auditLog } from '../middleware/security';
import { config } from '../config';
import { getAuthUser } from '../utils/store-helpers';
import { OrderService } from '../services/order.service';
import { recordPaymentEvent } from '../services/payment-event.service';
import logger from '../lib/logger';

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
  // Accept relative paths (preferred — server absolutifies against the order's
  // store domain) OR absolute URLs on the platform origin. We do NOT chain
  // `.url()` because that rejects relative paths; the refinement handles both
  // shapes explicitly.
  successUrl: z
    .string()
    .min(1)
    .optional()
    .refine(val => val === undefined || platformUrlOrRelative(val), {
      message: 'successUrl must be a relative path or a URL on the platform domain',
    }),
  errorUrl: z
    .string()
    .min(1)
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
    const storeId = req.headers['x-store-id'] as string | undefined;
    const providers = await PaymentService.getAvailableProviders(storeId);

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

    // Compute a defaultProvider that's actually offerable. If the global env
    // default is in the returned providers list, use it. Otherwise fall back
    // to the first listed provider, or 'cod' if available, or null. Returning
    // a default the storefront can't actually submit (e.g. 'tap' when only
    // cod is offered) auto-selects the broken option and 500s on click.
    // providers is a PaymentProvider[] (string union), not objects.
    const offerable = new Set<string>(providers as unknown as string[]);
    if (codConfig) offerable.add('cod');
    const envDefault = config.defaultPaymentProvider;
    const defaultProvider =
      envDefault && offerable.has(envDefault)
        ? envDefault
        : (providers[0] ?? (codConfig ? 'cod' : null));

    res.json({
      success: true,
      data: {
        providers,
        cod: codConfig,
        defaultProvider,
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
    const storeId = req.headers['x-store-id'] as string | undefined;

    const methods = await PaymentService.getPaymentMethods(amount, currency, provider, storeId);

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
  optionalAuthenticate,
  paymentLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    let rollbackContext: { orderId: string; storeId: string; sessionId: string } | null = null;

    try {
      const data = createPaymentSchema.parse(req.body);

      // Order ownership check supporting both signed-in customers and
      // guest checkout:
      //
      //   - Signed-in customer (req.user.role === 'customer'): the
      //     order's customerId must match req.user.userId.
      //   - Guest (no auth, or admin token leaking through): the order
      //     has customerId=null. We require the orderId itself, which
      //     is a v4 UUID — practically unguessable, and the storefront
      //     just got it back from /public/orders so any legitimate
      //     payer has it.
      //
      // Admin/super_admin cookies that bleed through from the same
      // browser fall into the guest branch because the customer-leak
      // guard on /public/orders already wrote customerId=null on the
      // order they're now paying for.
      const isCustomer = req.user?.role === 'customer';
      const order = await prisma.order.findFirst({
        where: isCustomer
          ? { id: data.orderId, customerId: req.user!.userId }
          : { id: data.orderId, customerId: null },
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

      // Set rollback context for the catch block. We only roll back if there's
      // no payment yet — paid orders don't get auto-cancelled by retry attempts.
      const sessionIdHeader = (req.headers['x-session-id'] as string | undefined) ?? '';
      if (sessionIdHeader && order.status === 'pending') {
        rollbackContext = {
          orderId: order.id,
          storeId: order.storeId,
          sessionId: sessionIdHeader,
        };
      }

      // From here on every Prisma write touches tenant-scoped tables
      // (Order, Payment, AuditLog with storeId). Wrap in a single
      // runInTenantContext so RLS policies enforce isolation under the
      // force_app role — without this the SELECTs the provider call
      // makes (e.g. PaymentConfig lookup, store row) silently fall
      // through to the "current_store_id() IS NULL → see all rows"
      // branch of the policies, which works but defeats the purpose
      // of RLS. Bootstrap order lookup above stays OUTSIDE the wrap
      // because we don't yet know the storeId at that point.
      await runInTenantContext(order.storeId, async () => {
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
            if (rollbackContext) {
              await OrderService.rollbackForPaymentFailure(
                rollbackContext.storeId,
                rollbackContext.orderId,
                rollbackContext.sessionId
              ).catch(err =>
                logger.error(
                  { err, ...rollbackContext },
                  'Order rollback failed (cod-not-available)'
                )
              );
            }
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

          // Payment record created — clear rollback context so we never undo a
          // successfully-initiated payment, even if a downstream step throws.
          rollbackContext = null;

          await recordPaymentEvent({
            paymentId: payment.id,
            storeId: order.storeId,
            orderId: order.id,
            eventType: 'created',
            toStatus: 'cod_pending',
            provider: 'cod',
            triggeredByUserId: req.user?.userId ?? null,
            details: { amount: order.total + codFee, codFee, originalTotal: order.total },
          });

          await auditLog({
            action: 'payment.created',
            // Guest checkout: req.user is undefined, audit log accepts that.
            userId: req.user?.userId,
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

        // Create payment. PaymentService.createPayment throws on provider-not-
        // configured / provider-error / validation-failure — the catch block at
        // the end of this handler runs the rollback so the customer's cart is
        // restored and inventory isn't drained by a failed attempt.
        const result = await PaymentService.createPayment(
          {
            orderId: order.id,
            orderNumber: order.orderNumber,
            amount: order.total,
            currency: order.currency as Currency,
            customer: (() => {
              // Guest checkout has order.customer = null but the checkout
              // form's name/email/phone live on order.shippingAddress (JSON).
              // Providers like MyFatoorah reject empty emails (400 "must be a
              // valid email") so always fall through to the shippingAddress
              // values before defaulting to a blank — guests are the common
              // case on storefronts, not the exception.
              const shipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
              return {
                // Stable id so providers hashing the customer for 3D-Secure /
                // fraud scoring see a consistent value across retries.
                id: req.user?.userId ?? `guest-${order.id}`,
                name:
                  `${order.customer?.firstName ?? shipping.firstName ?? ''} ${order.customer?.lastName ?? shipping.lastName ?? ''}`.trim() ||
                  'Customer',
                email: order.customer?.email || shipping.email || '',
                phone: shipping.phone || undefined,
              };
            })(),
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
            webhookUrl: `${config.apiUrl}/api/v1/webhooks/payment/${data.provider}`,
          },
          data.provider,
          order.storeId
        );

        // Payment provider accepted the request — clear rollback context so we
        // never undo a successfully-initiated payment, even if audit-log writing
        // throws below.
        rollbackContext = null;

        // Audit log
        await auditLog({
          action: 'payment.created',
          userId: req.user?.userId,
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
      });
    } catch (error) {
      // Compensating rollback: if the order was committed (cart cleared,
      // inventory decremented) but the payment step failed, undo all of that
      // so the customer can retry without losing their cart or seeing stock
      // drain on every attempt.
      if (rollbackContext) {
        await OrderService.rollbackForPaymentFailure(
          rollbackContext.storeId,
          rollbackContext.orderId,
          rollbackContext.sessionId
        ).catch(rbErr =>
          logger.error({ err: rbErr, ...rollbackContext }, 'Order rollback failed in catch block')
        );
      }
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

      // Bootstrap lookup OUTSIDE runInTenantContext — we don't yet
      // know the storeId. Same query whether the caller is super_admin
      // or store_admin so we can derive storeId either way; ownership
      // check follows below.
      const paymentRow = await prisma.payment.findFirst({
        where: { transactionId: data.transactionId },
        include: { order: { include: { store: { select: { id: true, ownerId: true } } } } },
      });
      if (!paymentRow) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Payment not found' },
        });
        return;
      }
      if (user.role === 'store_admin' && paymentRow.order.store.ownerId !== user.userId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Payment not found' },
        });
        return;
      }

      const refundStoreId = paymentRow.order.store.id;

      const refund = await runInTenantContext(refundStoreId, async () => {
        const r = await PaymentService.refund({
          transactionId: data.transactionId,
          amount: data.amount,
          reason: data.reason,
        });

        await auditLog({
          action: 'payment.refunded',
          userId: user.userId,
          resourceType: 'payment',
          resourceId: r.transactionId,
          details: {
            refundId: r.refundId,
            amount: r.amount,
            reason: data.reason || null,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        // Append-only audit row.
        await recordPaymentEvent({
          paymentId: paymentRow.id,
          storeId: refundStoreId,
          orderId: paymentRow.orderId,
          eventType: 'refund',
          fromStatus: paymentRow.status,
          toStatus: r.amount >= paymentRow.amount ? 'refunded' : 'partially_refunded',
          provider: paymentRow.provider,
          triggeredByUserId: user.userId,
          details: {
            refundId: r.refundId,
            amount: r.amount,
            reason: data.reason ?? null,
            initiatedBy: user.role,
          },
        });

        return r;
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

      const result = await runInTenantContext(payment.order.storeId, () =>
        PaymentService.retryPayment(paymentId, provider)
      );

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

// ==========================================
// Payment Audit Log
// ==========================================

/**
 * GET /payments/:id/events
 * Returns the append-only `payment_events` rows for a payment, newest
 * first. Super-admin can read any store; store-admin can read only
 * payments scoped to a store they own.
 *
 * Access control: same precedent as POST /payments/refund — load the
 * payment with its store ownerId, then accept the request only when
 * the requester is super_admin or is the store owner.
 */
router.get('/:id/events', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = getAuthUser(req);
    const { id: paymentId } = req.params;

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        order: { select: { store: { select: { id: true, ownerId: true } } } },
      },
    });

    if (!payment) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Payment not found' },
      });
      return;
    }

    const isOwner = payment.order.store.ownerId === user.userId;
    if (user.role !== 'super_admin' && !isOwner) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Payment not found' },
      });
      return;
    }

    const events = await prisma.paymentEvent.findMany({
      where: { paymentId },
      orderBy: { occurredAt: 'desc' },
      select: {
        id: true,
        eventType: true,
        fromStatus: true,
        toStatus: true,
        provider: true,
        // providerPayload is intentionally omitted from the LIST shape —
        // payloads can be large + may contain PII. The single-event
        // endpoint below returns it gated to super_admin.
        details: true,
        triggeredByUserId: true,
        occurredAt: true,
        createdAt: true,
      },
      take: 200,
    });

    res.json({ success: true, data: { events } });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /payments/events/:eventId/payload
 * Returns the raw provider_payload for a single payment_events row.
 * Super-admin only because raw payloads may contain customer PII +
 * provider-internal references we don't want to leak to store_admin
 * dashboards by default.
 */
router.get(
  '/events/:eventId/payload',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthUser(req);
      if (user.role !== 'super_admin') {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Super-admin only' },
        });
        return;
      }
      const { eventId } = req.params;
      const event = await prisma.paymentEvent.findUnique({
        where: { id: eventId },
        select: {
          id: true,
          paymentId: true,
          eventType: true,
          provider: true,
          providerPayload: true,
          occurredAt: true,
        },
      });
      if (!event) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Payment event not found' },
        });
        return;
      }
      res.json({ success: true, data: event });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
