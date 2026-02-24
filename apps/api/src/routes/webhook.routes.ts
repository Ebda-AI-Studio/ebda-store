import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '@force/database';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { PaymentProvider } from '../services/payment-providers/types';
import { config } from '../config';
import { auditLog } from '../middleware/security';

const router = Router();

/**
 * Webhook signature verification middleware
 * Ensures webhook requests are authentic from payment providers
 */
function verifyWebhookSignature(req: Request, res: Response, next: NextFunction): void {
  const provider = req.params.provider as PaymentProvider;
  const signature =
    (req.headers['x-signature'] as string) ||
    (req.headers['x-tap-signature'] as string) ||
    (req.headers['x-myfatoorah-signature'] as string) ||
    (req.headers['x-hesabe-signature'] as string) ||
    (req.headers['x-upayments-signature'] as string) ||
    (req.headers['tap-signature'] as string) ||
    '';

  // Require signature for all webhooks
  if (!signature) {
    console.warn(`[WEBHOOK] Missing signature for ${provider} webhook`);

    auditLog({
      action: 'WEBHOOK_NO_SIGNATURE',
      resourceType: 'payment',
      details: {
        provider,
        headers: Object.keys(req.headers).join(', '),
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(401).json({
      success: false,
      error: { code: 'MISSING_SIGNATURE', message: 'Webhook signature is required' },
    });
    return;
  }

  // Store signature for later use
  (req as any).webhookSignature = signature;
  next();
}

/**
 * Check if a webhook has already been processed (idempotency check)
 */
async function checkIdempotency(idempotencyKey: string): Promise<{
  alreadyProcessed: boolean;
  order?: {
    id: string;
    orderNumber: string;
    webhookProcessedAt: Date | null;
    paymentStatus: string;
  } | null;
}> {
  const order = await prisma.order.findUnique({
    where: { idempotencyKey },
    select: { id: true, orderNumber: true, webhookProcessedAt: true, paymentStatus: true },
  });

  if (order && order.webhookProcessedAt) {
    return { alreadyProcessed: true, order };
  }

  return { alreadyProcessed: false, order };
}

/**
 * Mark a webhook as processed
 */
async function markWebhookProcessed(orderId: string, idempotencyKey: string): Promise<void> {
  await prisma.order.update({
    where: { id: orderId },
    data: {
      idempotencyKey,
      webhookProcessedAt: new Date(),
    },
  });
}

/**
 * Generate idempotency key from webhook payload
 */
function generateIdempotencyKey(
  provider: PaymentProvider,
  payload: Record<string, unknown>
): string {
  // Use provider-specific transaction ID for idempotency
  const charge = payload.charge as Record<string, unknown> | undefined;
  const reference = payload.reference as Record<string, unknown> | undefined;
  const data = payload.Data as Record<string, unknown> | undefined;

  switch (provider) {
    case 'tap':
      return `tap_${payload.id || charge?.id || reference?.id}`;
    case 'myfatoorah':
      return `mf_${payload.InvoiceId || data?.InvoiceId}`;
    case 'hesabe':
      return `hesabe_${payload.paymentId || payload.transaction_id}`;
    case 'upayments':
      return `up_${payload.invoice_id || payload.transaction_id}`;
    default: {
      const crypto = require('crypto') as typeof import('crypto');
      return `unknown_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    }
  }
}

// ==========================================
// Kuwait Payment Provider Webhooks
// Supports: Tap, MyFatoorah, Hesabe, UPayments
// ==========================================

/**
 * POST /webhooks/payment/:provider
 * Handle payment provider webhooks with idempotency
 */
router.post(
  '/payment/:provider',
  verifyWebhookSignature,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = req.params.provider as PaymentProvider;
      const signature = (req as any).webhookSignature || '';

      // Validate provider
      const validProviders: PaymentProvider[] = ['tap', 'myfatoorah', 'hesabe', 'upayments'];
      if (!validProviders.includes(provider)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PROVIDER', message: 'Invalid payment provider' },
        });
        return;
      }

      // Generate idempotency key from payload
      const idempotencyKey = generateIdempotencyKey(provider, req.body);

      // Check for duplicate webhook
      const { alreadyProcessed, order } = await checkIdempotency(idempotencyKey);

      if (alreadyProcessed) {
        console.log(`[WEBHOOK] Duplicate webhook detected: ${idempotencyKey}`);

        await auditLog({
          action: 'WEBHOOK_DUPLICATE',
          resourceType: 'payment',
          resourceId: order?.id,
          details: {
            provider,
            idempotencyKey,
            orderNumber: order?.orderNumber ?? null,
            previousStatus: order?.paymentStatus ?? null,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        // Return success to prevent provider retries
        res.json({
          success: true,
          data: {
            message: 'Webhook already processed',
            orderId: order?.id,
            orderNumber: order?.orderNumber,
          },
        });
        return;
      }

      // Handle webhook
      const result = await PaymentService.handleWebhook(provider, req.body, signature);

      // Mark as processed if we have an order
      if (result.orderId) {
        await markWebhookProcessed(result.orderId, idempotencyKey);
      }

      console.log(`[WEBHOOK] ${provider}: ${JSON.stringify(result)}`);

      await auditLog({
        action: 'WEBHOOK_PROCESSED',
        resourceType: 'payment',
        resourceId: result.orderId,
        details: {
          provider,
          idempotencyKey,
          status: result.status || 'unknown',
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[WEBHOOK ERROR]', error);
      next(error);
    }
  }
);

/**
 * POST /webhooks/payment
 * Generic payment webhook (auto-detect provider)
 */
router.post('/payment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Try to detect provider from payload
    let provider: PaymentProvider = 'tap';

    if (req.body.InvoiceId !== undefined) {
      provider = 'myfatoorah';
    } else if (req.body.paymentId && req.body.resultCode) {
      provider = 'hesabe';
    } else if (req.body.invoice_id) {
      provider = 'upayments';
    } else if (req.body.id && req.body.object === 'charge') {
      provider = 'tap';
    }

    const signature =
      (req.headers['x-signature'] as string) ||
      (req.headers['x-tap-signature'] as string) ||
      (req.headers['x-myfatoorah-signature'] as string) ||
      (req.headers['x-hesabe-signature'] as string) ||
      (req.headers['x-upayments-signature'] as string) ||
      (req.headers['tap-signature'] as string) ||
      '';

    if (!signature) {
      console.warn(`[WEBHOOK] Missing signature for auto-detected ${provider} webhook`);
      res.status(401).json({
        success: false,
        error: { code: 'MISSING_SIGNATURE', message: 'Webhook signature is required' },
      });
      return;
    }

    const result = await PaymentService.handleWebhook(provider, req.body, signature);

    console.log(`[WEBHOOK] Auto-detected ${provider}: ${JSON.stringify(result)}`);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('[WEBHOOK ERROR]', error);
    next(error);
  }
});

/**
 * GET /webhooks/payment/callback
 * Payment callback handler (redirect after payment)
 */
router.get('/payment/callback', async (req: Request, res: Response) => {
  const { tap_id, paymentId, Id, invoice_id } = req.query;
  const transactionId = (tap_id || paymentId || Id || invoice_id) as string;

  if (!transactionId) {
    res.redirect(`${config.webUrl}/checkout/error?reason=missing_transaction`);
    return;
  }

  try {
    // Get payment status
    const status = await PaymentService.getPaymentStatus(transactionId);

    if (status.status === 'completed') {
      res.redirect(
        `${config.webUrl}/checkout/success?transaction=${encodeURIComponent(transactionId)}`
      );
    } else if (status.status === 'failed' || status.status === 'cancelled') {
      res.redirect(
        `${config.webUrl}/checkout/error?reason=${encodeURIComponent(status.failureReason || status.status)}`
      );
    } else {
      res.redirect(
        `${config.webUrl}/checkout/pending?transaction=${encodeURIComponent(transactionId)}`
      );
    }
  } catch (error) {
    console.error('[CALLBACK ERROR]', error);
    res.redirect(`${config.webUrl}/checkout/error?reason=unknown`);
  }
});

/**
 * GET /webhooks/payment/error
 * Payment error callback handler
 */
router.get('/payment/error', async (req: Request, res: Response) => {
  const { error, message, transaction_id } = req.query;

  console.error('[PAYMENT ERROR CALLBACK]', { error, message, transaction_id });

  res.redirect(
    `${config.webUrl}/checkout/error?reason=${encodeURIComponent(String(message || error || 'payment_failed'))}`
  );
});

export default router;
