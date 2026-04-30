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
  orderId?: string;
}> {
  const order = await prisma.order.findUnique({
    where: { idempotencyKey },
    select: { id: true, webhookProcessedAt: true },
  });

  if (order && order.webhookProcessedAt) {
    return { alreadyProcessed: true, orderId: order.id };
  }

  return { alreadyProcessed: false, orderId: order?.id };
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
 * Generate idempotency key from webhook payload.
 *
 * Returns null when the payload doesn't carry a provider-specific
 * transaction ID we can hash on. The previous implementation fell
 * through to `${prefix}_undefined` in that case — every malformed
 * webhook from the same provider then collided on a single
 * idempotency row, so the SECOND such delivery was silently dropped
 * as "already processed". Returning null forces the handler to 400
 * the request and Sentry instead of swallowing it.
 *
 * The unknown-provider branch still produces a unique random key —
 * we WANT to record those so manual investigation can find the row,
 * but they should never collide with a real provider's namespace.
 */
function generateIdempotencyKey(
  provider: PaymentProvider,
  payload: Record<string, unknown>
): string | null {
  const charge = payload.charge as Record<string, unknown> | undefined;
  const reference = payload.reference as Record<string, unknown> | undefined;
  const data = payload.Data as Record<string, unknown> | undefined;

  const stringify = (v: unknown): string | null => {
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
    return null;
  };

  switch (provider) {
    case 'tap': {
      const id = stringify(payload.id) ?? stringify(charge?.id) ?? stringify(reference?.id);
      return id ? `tap_${id}` : null;
    }
    case 'myfatoorah': {
      const id = stringify(payload.InvoiceId) ?? stringify(data?.InvoiceId);
      return id ? `mf_${id}` : null;
    }
    case 'hesabe': {
      const id = stringify(payload.paymentId) ?? stringify(payload.transaction_id);
      return id ? `hesabe_${id}` : null;
    }
    case 'upayments': {
      const id = stringify(payload.invoice_id) ?? stringify(payload.transaction_id);
      return id ? `up_${id}` : null;
    }
    default:
      return `unknown_${provider}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
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

      // Generate idempotency key from parsed payload. null means the
      // payload didn't carry a provider transaction ID we recognise —
      // refuse to process rather than collide on a `${prefix}_undefined`
      // row. Sentry picks up the 400 so we can fix the parser when a
      // provider rolls a new payload schema.
      const idempotencyKey = generateIdempotencyKey(provider, payload);
      if (!idempotencyKey) {
        logger.warn(
          { provider, payloadKeys: Object.keys(payload) },
          '[WEBHOOK] Could not derive idempotency key — payload missing transaction ID'
        );
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_TRANSACTION_ID',
            message: 'Webhook payload missing transaction ID',
          },
        });
        return;
      }

      // Check for duplicate webhook
      const { alreadyProcessed, orderId } = await checkIdempotency(idempotencyKey);

      if (alreadyProcessed) {
        logger.info({ idempotencyKey }, '[WEBHOOK] Duplicate webhook detected');

        await auditLog({
          action: 'WEBHOOK_DUPLICATE',
          resourceType: 'payment',
          resourceId: orderId,
          details: {
            provider,
            idempotencyKey,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        // Return success to prevent provider retries — no order details in response
        res.json({
          success: true,
          data: { message: 'Webhook already processed' },
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

      // Return minimal acknowledgment — no internal IDs or order details
      res.json({
        success: true,
        data: { message: 'Webhook processed', status: result.status || 'unknown' },
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

    // Idempotency check - same pattern as provider-specific handler.
    // null means we couldn't derive a transaction ID — refuse to
    // process rather than collide on a poison key.
    const idempotencyKey = generateIdempotencyKey(provider, payload);
    if (!idempotencyKey) {
      logger.warn(
        { provider, payloadKeys: Object.keys(payload) },
        '[WEBHOOK] Auto-detected webhook missing transaction ID'
      );
      res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_TRANSACTION_ID',
          message: 'Webhook payload missing transaction ID',
        },
      });
      return;
    }
    const { alreadyProcessed, orderId } = await checkIdempotency(idempotencyKey);

    if (alreadyProcessed) {
      logger.info({ idempotencyKey }, '[WEBHOOK] Duplicate auto-detected webhook detected');

      await auditLog({
        action: 'WEBHOOK_DUPLICATE',
        resourceType: 'payment',
        resourceId: orderId,
        details: {
          provider,
          idempotencyKey,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Return success to prevent provider retries — no order details in response
      res.json({
        success: true,
        data: { message: 'Webhook already processed' },
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

    // Return minimal acknowledgment — no internal IDs or order details
    res.json({
      success: true,
      data: { message: 'Webhook processed', status: result.status || 'unknown' },
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

  // Resolve the correct storefront URL — custom domain if the store has one,
  // otherwise fall back to the platform's web URL.
  async function getStorefrontUrl(): Promise<string> {
    try {
      if (!transactionId) return config.webUrl;
      const order = await prisma.order.findFirst({
        where: {
          OR: [{ idempotencyKey: { contains: transactionId } }, { id: transactionId }],
        },
        select: { store: { select: { domain: true, slug: true } } },
      });
      if (order?.store?.domain) return `https://${order.store.domain}`;
      if (order?.store?.slug) return `${config.webUrl}/${order.store.slug}`;
      return config.webUrl;
    } catch {
      return config.webUrl;
    }
  }

  if (!transactionId) {
    res.redirect(`${config.webUrl}/checkout/error?reason=missing_transaction`);
    return;
  }

  try {
    const [status, baseUrl] = await Promise.all([
      PaymentService.getPaymentStatus(transactionId),
      getStorefrontUrl(),
    ]);

    if (status.status === 'completed') {
      res.redirect(`${baseUrl}/checkout/success?transaction=${encodeURIComponent(transactionId)}`);
    } else if (status.status === 'failed' || status.status === 'cancelled') {
      res.redirect(
        `${baseUrl}/checkout/error?reason=${encodeURIComponent(status.failureReason || status.status)}`
      );
    } else {
      res.redirect(`${baseUrl}/checkout/pending?transaction=${encodeURIComponent(transactionId)}`);
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

  // Resolve storefront URL for the order's store
  let baseUrl = config.webUrl;
  if (transaction_id) {
    try {
      const order = await prisma.order.findFirst({
        where: {
          OR: [
            { idempotencyKey: { contains: String(transaction_id) } },
            { id: String(transaction_id) },
          ],
        },
        select: { store: { select: { domain: true, slug: true } } },
      });
      if (order?.store?.domain) baseUrl = `https://${order.store.domain}`;
      else if (order?.store?.slug) baseUrl = `${config.webUrl}/${order.store.slug}`;
    } catch {
      // Fall back to platform URL
    }
  }

  res.redirect(
    `${baseUrl}/checkout/error?reason=${encodeURIComponent(String(message || error || 'payment_failed'))}`
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

  const verifyToken = config.whatsappVerifyToken;
  if (!verifyToken) {
    return res.status(500).send('WhatsApp verify token not configured');
  }
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
