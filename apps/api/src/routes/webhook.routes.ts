import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import crypto from 'crypto';
import { prisma } from '@force/database';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { PaymentProvider } from '../services/payment-providers/types';
import { config } from '../config';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';
import { shippingCarrierService } from '../services/shipping-carrier.service';
import { sendAlert } from '../services/alerts.service';

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

/**
 * Resolve which store this webhook belongs to BEFORE calling handleWebhook,
 * so PaymentService.handleWebhook can verify the HMAC signature with the
 * correct per-store webhook secret from PaymentConfig (not the empty
 * platform-level env-var fallback).
 *
 * Without this, every incoming webhook for a per-store provider would
 * either fail signature verification or 500 with PROVIDER_NOT_CONFIGURED.
 *
 * Returns undefined when we can't match the payload to a Payment row —
 * handleWebhook will then take its env-var path, which is correct
 * behaviour for the platform-only test stores (currently none in prod).
 */
async function resolveStoreIdFromWebhookPayload(
  provider: PaymentProvider,
  payload: Record<string, unknown>
): Promise<string | undefined> {
  const data = payload.Data as Record<string, unknown> | undefined;
  const charge = payload.charge as Record<string, unknown> | undefined;
  const stringify = (v: unknown): string | null => {
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
    return null;
  };

  let transactionId: string | null = null;
  let invoiceId: string | null = null;
  switch (provider) {
    case 'tap':
      transactionId = stringify(payload.id) ?? stringify(charge?.id);
      break;
    case 'myfatoorah':
      invoiceId = stringify(payload.InvoiceId) ?? stringify(data?.InvoiceId);
      break;
    case 'hesabe':
      transactionId = stringify(payload.paymentId) ?? stringify(payload.transaction_id);
      break;
    case 'upayments':
      transactionId = stringify(payload.transaction_id);
      invoiceId = stringify(payload.invoice_id);
      break;
  }

  if (!transactionId && !invoiceId) return undefined;

  const payment = await prisma.payment.findFirst({
    where: {
      OR: [...(transactionId ? [{ transactionId }] : []), ...(invoiceId ? [{ invoiceId }] : [])],
    },
    select: { order: { select: { storeId: true } } },
  });

  return payment?.order?.storeId;
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
      // storeId is resolved upfront so handleWebhook can load the right
      // per-store webhook secret for signature verification — without this,
      // signature checks against platform-level env vars (always empty in
      // FWB prod) would reject every per-tenant webhook.
      const storeIdForWebhook = await resolveStoreIdFromWebhookPayload(provider, payload);
      const result = await PaymentService.handleWebhook(
        provider,
        payload,
        signature,
        storeIdForWebhook,
        rawBody.toString()
      );

      // Mark as processed if we have an order
      if (result.orderId) {
        await markWebhookProcessed(result.orderId, idempotencyKey);
      }

      logger.info({ provider, storeId: storeIdForWebhook, result }, '[WEBHOOK] Processed');

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

    // Try to detect provider from payload.
    //
    // MyFatoorah wraps every webhook in `{Event, Data: {...}}` so the
    // identifying fields live under `Data`, not at the root. Real
    // production webhooks were being misdetected as 'tap' (the default
    // fallback) before we added the nested check — see the synthetic
    // test on 2026-05-13 which surfaced this latent bug.
    let provider: PaymentProvider = 'tap';
    const data = payload.Data as Record<string, unknown> | undefined;

    if (payload.InvoiceId !== undefined || data?.InvoiceId !== undefined) {
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
    // Resolve storeId from the payment row matching this payload so the per-
    // store webhook secret is used for signature verification (see handler
    // above for the same rationale).
    const storeIdForWebhook = await resolveStoreIdFromWebhookPayload(provider, payload);
    const result = await PaymentService.handleWebhook(
      provider,
      payload,
      signature,
      storeIdForWebhook,
      rawBody.toString()
    );

    // Mark as processed if we have an order
    if (result.orderId) {
      await markWebhookProcessed(result.orderId, idempotencyKey);
    }

    logger.info(
      { provider, storeId: storeIdForWebhook, result },
      '[WEBHOOK] Auto-detected provider processed'
    );

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
// Shipping Carrier Webhooks
// ==========================================

/**
 * Verify a shared-secret bearer token on a carrier webhook. iCarry /
 * Aramex don't sign their payloads, so we configure a shared secret
 * in both control panels and check `Authorization: Bearer <secret>`
 * (or `X-Webhook-Secret`) on every inbound POST. Fail-closed: if the
 * env var isn't configured, refuse every webhook — better to lose a
 * tracking-status push than to accept arbitrary "delivered" forgeries.
 *
 * Uses timing-safe equality so a stopwatch attacker can't probe for
 * the secret one byte at a time.
 */
function verifyCarrierWebhookSecret(req: Request, expected: string): boolean {
  if (!expected) return false;
  const auth = (req.headers.authorization as string | undefined) || '';
  const fromBearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
  const fromHeader = (req.headers['x-webhook-secret'] as string | undefined) || '';
  const presented = fromBearer || fromHeader;
  if (!presented || presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

/**
 * POST /webhooks/shipping/icarry
 * Receive push notifications from iCarry
 */
router.post('/shipping/icarry', express.json(), async (req: Request, res: Response) => {
  if (!verifyCarrierWebhookSecret(req, config.icarryWebhookSecret)) {
    logger.warn({ ip: req.ip }, '[WEBHOOK] iCarry webhook rejected — bad/missing secret');
    res.sendStatus(401);
    return;
  }
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
/**
 * POST /webhooks/vercel-budget — Vercel Spend Management notification.
 *
 * Vercel POSTs this when:
 *   - The configured spend budget is reached/exceeded (project gets paused)
 *   - The billing cycle ends (so paused projects can be resumed)
 *
 * Auth: HMAC-SHA1 of the RAW request body using `VERCEL_WEBHOOK_SECRET`,
 * delivered via `x-vercel-signature`. Constant-time compare. Mounted
 * under the parent router which already applies `express.raw({type:
 * 'application/json'})` so `req.body` is a Buffer here.
 *
 * Side effects:
 *   - Sends a P0 Telegram alert via existing alerts.service so Ahmad gets
 *     the ping immediately (the Telegram bot env vars are already wired).
 *   - Logs the full Vercel payload to pino at info level so post-incident
 *     review against the persistent log drain is possible.
 *
 * Future v2: auto-resume the project via Vercel API on
 * billing_cycle.end events. v1 is alert-only — manual resume via
 * dashboard once Ahmad sees the Telegram ping.
 */
router.post('/vercel-budget', async (req: Request, res: Response) => {
  const secret = process.env.VERCEL_WEBHOOK_SECRET;
  if (!secret) {
    logger.error(
      '[VERCEL_BUDGET] VERCEL_WEBHOOK_SECRET unset — refusing webhook to prevent spoofed alerts'
    );
    res.status(503).json({ ok: false, error: 'webhook_not_configured' });
    return;
  }

  const signature = (req.headers['x-vercel-signature'] as string) || '';
  if (!signature) {
    logger.warn('[VERCEL_BUDGET] Missing x-vercel-signature header');
    res.status(401).json({ ok: false, error: 'missing_signature' });
    return;
  }

  // `req.body` is a Buffer because the parent /api/v1/webhooks mount
  // applies express.raw(). HMAC over the raw bytes is what Vercel
  // signs against.
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const expected = crypto.createHmac('sha1', secret).update(rawBody).digest('hex');

  let valid = false;
  try {
    valid =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    valid = false;
  }
  if (!valid) {
    logger.warn({ sig: signature.slice(0, 12) }, '[VERCEL_BUDGET] Invalid signature');
    res.status(401).json({ ok: false, error: 'invalid_signature' });
    return;
  }

  // Parse the verified payload. Vercel's schema is loose — capture every
  // key into the alert + log so we never miss context.
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch (err) {
    logger.error({ err }, '[VERCEL_BUDGET] Body parse failed');
    res.status(400).json({ ok: false, error: 'invalid_json' });
    return;
  }

  const type = String(payload.type ?? 'unknown');
  const inner = (payload.payload as Record<string, unknown> | undefined) ?? {};
  const spend = inner.spend ?? '?';
  const budget = inner.budget ?? '?';
  const currency = inner.currency ?? 'USD';
  const scope = inner.scope ?? 'team';

  logger.info({ type, payload }, '[VERCEL_BUDGET] webhook received');

  // Fire the Telegram alert via the shared alerts.service.
  try {
    const isBudgetEvent = type === 'budget.exceeded' || type === 'budget.notification';
    await sendAlert({
      level: isBudgetEvent ? 'p0' : 'info',
      source: 'webhook.vercel-budget',
      title: isBudgetEvent
        ? `Vercel budget ${type === 'budget.exceeded' ? 'EXCEEDED' : 'notification'}`
        : 'Vercel billing cycle ended',
      body:
        `Type: ${type}\nSpend: ${spend} ${currency}\nBudget: ${budget} ${currency}\nScope: ${scope}\n` +
        (type === 'budget.exceeded'
          ? '⚠️ Vercel may have paused projects. Resume via dashboard.'
          : type === 'billing_cycle.end'
            ? 'Paused projects can be resumed now.'
            : ''),
      context: inner,
      scope: 'platform',
    });
  } catch (err) {
    logger.warn({ err }, '[VERCEL_BUDGET] sendAlert failed (webhook still ACKed)');
  }

  // Always 200 OK after signature passes — webhooks should ack so Vercel
  // doesn't retry indefinitely. Downstream failures (Telegram down, etc.)
  // are surfaced via logs, not via webhook retry.
  res.status(200).json({ ok: true });
});

router.post('/shipping/aramex', express.json(), async (req: Request, res: Response) => {
  if (!verifyCarrierWebhookSecret(req, config.aramexWebhookSecret)) {
    logger.warn({ ip: req.ip }, '[WEBHOOK] Aramex webhook rejected — bad/missing secret');
    res.sendStatus(401);
    return;
  }
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
