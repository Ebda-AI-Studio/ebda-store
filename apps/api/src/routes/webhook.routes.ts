import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import crypto from 'crypto';
import { prisma } from '@force/database';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { PaymentProvider } from '../services/payment-providers/types';
import { config } from '../config';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';
import { whatsappService } from '../services/whatsapp.service';
import { shippingCarrierService } from '../services/shipping-carrier.service';

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
    logger.warn({ provider }, '[WEBHOOK] Missing signature for webhook');

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
  req.webhookSignature = signature;
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
    default:
      return `unknown_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
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
      const signature = req.webhookSignature || '';

      // req.body is a raw Buffer (from express.raw). Parse it here so handlers
      // can access properties while the raw Buffer is preserved for signature
      // verification inside PaymentService.handleWebhook.
      const rawBody: Buffer = req.body as Buffer;
      const payload = JSON.parse(rawBody.toString()) as Record<string, unknown>;

      // Validate provider
      const validProviders: PaymentProvider[] = ['tap', 'myfatoorah', 'hesabe', 'upayments'];
      if (!validProviders.includes(provider)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PROVIDER', message: 'Invalid payment provider' },
        });
        return;
      }

      // Generate idempotency key from parsed payload
      const idempotencyKey = generateIdempotencyKey(provider, payload);

      // Check for duplicate webhook
      const { alreadyProcessed, order } = await checkIdempotency(idempotencyKey);

      if (alreadyProcessed) {
        logger.info({ idempotencyKey }, '[WEBHOOK] Duplicate webhook detected');

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

      // Pass the parsed payload for business logic and the raw body string for
      // HMAC signature verification so providers compute the correct digest.
      const result = await PaymentService.handleWebhook(
        provider,
        payload,
        signature,
        undefined,
        rawBody.toString()
      );

      // Mark as processed if we have an order
      if (result.orderId) {
        await markWebhookProcessed(result.orderId, idempotencyKey);
      }

      logger.info({ provider, result }, '[WEBHOOK] Processed');

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
      logger.error({ err: error }, '[WEBHOOK ERROR] Failed to process webhook');
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
    // req.body is a raw Buffer (from express.raw). Parse it so we can inspect
    // payload fields for provider auto-detection.
    const rawBody: Buffer = req.body as Buffer;
    const payload = JSON.parse(rawBody.toString()) as Record<string, unknown>;

    // Try to detect provider from payload
    let provider: PaymentProvider = 'tap';

    if (payload.InvoiceId !== undefined) {
      provider = 'myfatoorah';
    } else if (payload.paymentId && payload.resultCode) {
      provider = 'hesabe';
    } else if (payload.invoice_id) {
      provider = 'upayments';
    } else if (payload.id && payload.object === 'charge') {
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
      logger.warn({ provider }, '[WEBHOOK] Missing signature for auto-detected webhook');
      res.status(401).json({
        success: false,
        error: { code: 'MISSING_SIGNATURE', message: 'Webhook signature is required' },
      });
      return;
    }

    // Idempotency check - same pattern as provider-specific handler
    const idempotencyKey = generateIdempotencyKey(provider, payload);
    const { alreadyProcessed, order } = await checkIdempotency(idempotencyKey);

    if (alreadyProcessed) {
      logger.info({ idempotencyKey }, '[WEBHOOK] Duplicate auto-detected webhook detected');

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

    // Pass the parsed payload for business logic and the raw body string for
    // HMAC signature verification so providers compute the correct digest.
    const result = await PaymentService.handleWebhook(
      provider,
      payload,
      signature,
      undefined,
      rawBody.toString()
    );

    // Mark as processed if we have an order
    if (result.orderId) {
      await markWebhookProcessed(result.orderId, idempotencyKey);
    }

    logger.info({ provider, result }, '[WEBHOOK] Auto-detected provider processed');

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
    logger.error({ err: error }, '[WEBHOOK ERROR] Failed to process auto-detected webhook');
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
    logger.error({ err: error }, '[CALLBACK ERROR] Failed to process payment callback');
    res.redirect(`${config.webUrl}/checkout/error?reason=unknown`);
  }
});

/**
 * GET /webhooks/payment/error
 * Payment error callback handler
 */
router.get('/payment/error', async (req: Request, res: Response) => {
  const { error, message, transaction_id } = req.query;

  logger.error(
    { error, message, transaction_id },
    '[PAYMENT ERROR CALLBACK] Payment error callback received'
  );

  res.redirect(
    `${config.webUrl}/checkout/error?reason=${encodeURIComponent(String(message || error || 'payment_failed'))}`
  );
});

// ==========================================
// WhatsApp Webhooks (Meta Cloud API)
// ==========================================

/**
 * GET /webhooks/whatsapp
 * Meta sends a GET request to verify the webhook endpoint.
 * Responds with the hub.challenge value on success.
 */
router.get('/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'verify';
  const result = whatsappService.verifyWebhook(mode, token, challenge, verifyToken);

  if (result) {
    return res.status(200).send(result);
  }

  return res.status(403).send('Forbidden');
});

/**
 * POST /webhooks/whatsapp
 * Receives delivery status updates from Meta.
 * Always responds 200 — Meta retries on any non-200.
 */
router.post('/whatsapp', express.json(), async (req: Request, res: Response) => {
  try {
    const statuses = whatsappService.processWebhookEvent(req.body);

    for (const status of statuses) {
      // Update NotificationLog where providerMessageId matches.
      // No ordering guard here — the service layer already filters to
      // known statuses (sent | delivered | read | failed).
      await prisma.notificationLog.updateMany({
        where: { providerMessageId: status.messageId },
        data: { status: status.status, updatedAt: new Date() },
      });
    }

    logger.info({ count: statuses.length }, '[WEBHOOK] WhatsApp status updates processed');
    res.sendStatus(200);
  } catch (err) {
    logger.error({ err }, '[WEBHOOK] WhatsApp webhook error');
    res.sendStatus(200); // Always 200 — never trigger Meta retries
  }
});

// ==========================================
// Shipping Carrier Webhooks
// ==========================================

/**
 * POST /webhooks/shipping/icarry
 * Receive push notifications from iCarry
 */
router.post('/shipping/icarry', express.json(), async (req: Request, res: Response) => {
  try {
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, String(v ?? '')])
    );
    await shippingCarrierService.processWebhook('icarry', req.body, headers);
    res.sendStatus(200);
  } catch (err) {
    logger.error({ err }, '[WEBHOOK] iCarry shipping webhook error');
    res.sendStatus(200); // Always 200 to prevent carrier retries
  }
});

/**
 * POST /webhooks/shipping/aramex
 * Receive push notifications from Aramex
 */
router.post('/shipping/aramex', express.json(), async (req: Request, res: Response) => {
  try {
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, String(v ?? '')])
    );
    await shippingCarrierService.processWebhook('aramex', req.body, headers);
    res.sendStatus(200);
  } catch (err) {
    logger.error({ err }, '[WEBHOOK] Aramex shipping webhook error');
    res.sendStatus(200); // Always 200 to prevent carrier retries
  }
});

export default router;
