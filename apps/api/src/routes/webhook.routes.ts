import { Router, Request, Response, NextFunction } from 'express';
import { storefrontOrigin } from '@force/shared';
import express from 'express';
import crypto from 'crypto';
import { prisma, runInTenantContext, withRlsBypass } from '@force/database';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { PaymentProvider } from '../services/payment-providers/types';
import { config } from '../config';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';
import { shippingCarrierService } from '../services/shipping-carrier.service';
import { inngest } from '../lib/inngest/client';

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
 * Check if a webhook has already been processed (idempotency check).
 *
 * Runs inside withRlsBypass because the storeId is not known yet at this point
 * (we haven't resolved which store this webhook belongs to). The query is
 * read-only and cross-tenant by nature — we're matching on an idempotency key
 * that may span any store.
 */
async function checkIdempotency(idempotencyKey: string): Promise<{
  alreadyProcessed: boolean;
  orderId?: string;
}> {
  return withRlsBypass(async tx => {
    const order = await tx.order.findUnique({
      where: { idempotencyKey },
      select: { id: true, webhookProcessedAt: true },
    });

    if (order && order.webhookProcessedAt) {
      return { alreadyProcessed: true, orderId: order.id };
    }

    return { alreadyProcessed: false, orderId: order?.id };
  });
}

/**
 * Mark a webhook as processed.
 *
 * storeId is required so the write runs inside runInTenantContext and the
 * FORCE RLS GUC is set on the connection. When storeId is unavailable (edge
 * case where we have an orderId but not a storeId) we fall back to
 * withRlsBypass — the write is still safe because orderId is the primary key.
 */
async function markWebhookProcessed(
  orderId: string,
  idempotencyKey: string,
  storeId?: string
): Promise<void> {
  if (storeId) {
    await runInTenantContext(storeId, () =>
      prisma.order.update({
        where: { id: orderId },
        data: { idempotencyKey, webhookProcessedAt: new Date() },
      })
    );
  } else {
    await withRlsBypass(tx =>
      tx.order.update({
        where: { id: orderId },
        data: { idempotencyKey, webhookProcessedAt: new Date() },
      })
    );
  }
}

/**
 * Persist an inbound payment webhook to the durable WebhookEvent inbox.
 *
 * This is the "persist the raw event durably" step of the offload flow: the
 * route records the raw bytes + signature + parsed payload BEFORE handing the
 * heavy processing to Inngest. If Inngest is briefly unavailable the row is
 * still here (and the route falls back to inline processing), so no webhook is
 * lost.
 *
 * Upsert on the unique idempotencyKey — a duplicate provider delivery that
 * races past checkIdempotency lands on the SAME inbox row rather than creating
 * a second one (idempotency layer 2). We never overwrite a row that has already
 * been processed.
 *
 * Runs in withRlsBypass: webhook_events is a cross-tenant inbox (storeId may be
 * null on the platform path, and the Inngest consumer must read the row before
 * it can enter tenant context). Mirrors checkIdempotency /
 * resolveStoreIdFromWebhookPayload, which also run cross-tenant.
 */
async function recordInboundWebhook(input: {
  provider: PaymentProvider;
  idempotencyKey: string;
  storeId?: string;
  payload: Record<string, unknown>;
  rawBody: string;
  signature: string;
}): Promise<string> {
  try {
    return await withRlsBypass(async tx => {
      // First delivery: create the row. On the unique-key conflict (a
      // re-delivery), refresh the volatile fields — but ONLY for a row that has
      // NOT already been processed. This preserves the stored audit bytes
      // (rawBody/signature/payload) of a 'processed' row so a late re-delivery
      // can't corrupt the record of what we actually acted on. `status` is never
      // touched here: a non-terminal row stays reprocessable, a 'processed' row
      // stays a consumer no-op (shouldProcessInboxRow). The fresh inngest.send
      // below re-enqueues regardless.
      const existing = await tx.webhookEvent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, status: true },
      });

      if (!existing) {
        const created = await tx.webhookEvent.create({
          data: {
            provider: input.provider,
            idempotencyKey: input.idempotencyKey,
            storeId: input.storeId ?? null,
            payload: input.payload as object,
            rawBody: input.rawBody,
            signature: input.signature,
            status: 'received',
          },
          select: { id: true },
        });
        return created.id;
      }

      if (existing.status !== 'processed') {
        await tx.webhookEvent.update({
          where: { id: existing.id },
          data: {
            payload: input.payload as object,
            rawBody: input.rawBody,
            signature: input.signature,
            storeId: input.storeId ?? null,
          },
        });
      }
      return existing.id;
    });
  } catch (err) {
    // Two near-simultaneous deliveries of the same txn both passed the
    // findUnique (saw no row) and both tried to create → the second hits a
    // P2002 on the unique idempotency_key. The aborted tx can't recover
    // in-place, so re-read the row the winner just created in a FRESH tx and
    // return its id. Without this the route 500s and the provider retries — the
    // exact "5xx → provider retry loop" the inbox exists to avoid.
    if ((err as { code?: string } | null)?.code === 'P2002') {
      const row = (await withRlsBypass(tx =>
        tx.webhookEvent.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        })
      )) as { id: string } | null;
      if (row) return row.id;
    }
    throw err;
  }
}

/**
 * The offload decision point shared by BOTH the explicit `/payment/:provider`
 * handler and the auto-detect `/payment` handler so they behave identically.
 *
 *   1. Persist the raw event to the WebhookEvent inbox (durable).
 *   2. Try to enqueue `payment/webhook.received` — on success the heavy
 *      PaymentService.handleWebhook mutation runs in the payment-webhook-process
 *      Inngest function, OFF this request / the shared API pool. We return
 *      `enqueued: true` and the caller ACKs 200 immediately.
 *   3. If inngest.send() throws (Inngest unreachable), DO NOT lose the webhook —
 *      fall back to processing INLINE here (the previous behaviour), and return
 *      the real result so the caller's audit log + 200 response stay accurate.
 *
 * Tradeoff (documented): we ACK 200 once the row is durably persisted AND the
 * event is enqueued (or processed inline). If Inngest were to silently drop an
 * already-accepted event, the WebhookEvent row is the durable backstop for a
 * replay sweep (follow-up). The inline fallback covers the common
 * Inngest-unavailable case so the provider is never told "retry" unnecessarily.
 */
async function enqueueOrProcessWebhook(args: {
  provider: PaymentProvider;
  idempotencyKey: string;
  storeId?: string;
  payload: Record<string, unknown>;
  rawBody: string;
  signature: string;
}): Promise<{
  enqueued: boolean;
  result?: { success: boolean; status?: string; orderId?: string };
}> {
  const { provider, idempotencyKey, storeId, payload, rawBody, signature } = args;

  // 1. Durable persist FIRST — before we attempt anything that can fail.
  const webhookEventId = await recordInboundWebhook({
    provider,
    idempotencyKey,
    storeId,
    payload,
    rawBody,
    signature,
  });

  // 2. Try to offload to Inngest.
  try {
    await inngest.send({
      name: 'payment/webhook.received',
      data: { webhookEventId, provider, idempotencyKey, storeId },
    });
    return { enqueued: true };
  } catch (sendErr) {
    // 3. Inngest send failed — process inline so the webhook is never lost.
    logger.error(
      { err: sendErr, provider, webhookEventId },
      '[WEBHOOK] inngest.send failed — falling back to inline processing'
    );
    const result = await processWebhookInline({
      provider,
      idempotencyKey,
      storeId,
      payload,
      rawBody,
      signature,
    });
    // Mark the inbox row processed so a later replay sweep doesn't re-run it.
    await withRlsBypass(tx =>
      tx.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          status: 'processed',
          processedAt: new Date(),
          resultOrderId: result.orderId ?? null,
          resultStatus: result.status ?? null,
        },
      })
    ).catch(() => undefined);
    return { enqueued: false, result };
  }
}

/**
 * The inline processing path — IDENTICAL to the pre-offload behaviour. Used only
 * as the fallback when inngest.send() fails (so a webhook storm during an
 * Inngest outage still completes, just on the request path as before). The
 * normal path never calls this; the Inngest consumer runs the same
 * handleWebhook + markWebhookProcessed off the request path.
 */
async function processWebhookInline(args: {
  provider: PaymentProvider;
  idempotencyKey: string;
  storeId?: string;
  payload: Record<string, unknown>;
  rawBody: string;
  signature: string;
}): Promise<{ success: boolean; status?: string; orderId?: string }> {
  const { provider, idempotencyKey, storeId, payload, rawBody, signature } = args;
  let result: { success: boolean; status?: string; orderId?: string };
  if (storeId) {
    result = await runInTenantContext(storeId, () =>
      PaymentService.handleWebhook(provider, payload, signature, storeId, rawBody)
    );
  } else {
    // No storeId (platform-level path): call handleWebhook directly rather
    // than through withRlsBypass. withRlsBypass opens its OWN
    // basePrisma.$transaction and calls fn(tx) directly — it never runs fn
    // inside tenantStorage.run(tx, ...), so a discarded `_tx` param (as this
    // call previously had) means the SET LOCAL app.bypass_rls='true' it
    // issues is scoped to a transaction handleWebhook's ambient
    // ALS-proxied `prisma` export never touches — a no-op. This mirrors the
    // documented OLD-idiom escape (20260609000000_complete_force_rls_coverage):
    // orders/payments policies already allow-contextless when
    // current_store_id() IS NULL, which is exactly this branch's state, so
    // no wrapper is needed at all.
    result = await PaymentService.handleWebhook(provider, payload, signature, storeId, rawBody);
  }
  if (result.orderId) {
    await markWebhookProcessed(result.orderId, idempotencyKey, storeId);
  }
  return result;
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
 *
 * Runs inside withRlsBypass because the storeId is unknown at this point —
 * we're doing a cross-tenant payment lookup to discover which store owns the
 * incoming webhook. Once storeId is known the caller switches to
 * runInTenantContext for all subsequent writes.
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

  // Cross-tenant read — storeId not known yet, so use withRlsBypass.
  return withRlsBypass(async tx => {
    const payment = await tx.payment.findFirst({
      where: {
        OR: [...(transactionId ? [{ transactionId }] : []), ...(invoiceId ? [{ invoiceId }] : [])],
      },
      select: { order: { select: { storeId: true } } },
    });
    return payment?.order?.storeId;
  });
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
      //
      // FORCE RLS: resolveStoreIdFromWebhookPayload runs in withRlsBypass
      // (cross-tenant). Once storeId is known, handleWebhook + markWebhookProcessed
      // run in runInTenantContext(storeId) so all their payment/order writes are
      // correctly scoped. When storeId is undefined (platform-level path)
      // handleWebhook is called directly with no wrapper — see
      // processWebhookInline's no-storeId branch for why.
      const storeIdForWebhook = await resolveStoreIdFromWebhookPayload(provider, payload);

      // Offload the heavy PaymentService.handleWebhook mutation off this request:
      // persist the raw event to the durable WebhookEvent inbox, enqueue an
      // Inngest event, and ACK 200 immediately. The payment-webhook-process
      // function runs handleWebhook + markWebhookProcessed in
      // runInTenantContext(storeId) off the shared API pool, so a webhook storm
      // can't starve auth (P2024). If inngest.send fails we process inline as
      // before so the webhook is never lost.
      const { enqueued, result } = await enqueueOrProcessWebhook({
        provider,
        idempotencyKey,
        storeId: storeIdForWebhook,
        payload,
        rawBody: rawBody.toString(),
        signature,
      });

      logger.info(
        { provider, storeId: storeIdForWebhook, enqueued, result },
        enqueued ? '[WEBHOOK] Accepted + enqueued' : '[WEBHOOK] Processed inline (Inngest fallback)'
      );

      await auditLog({
        action: enqueued ? 'WEBHOOK_ENQUEUED' : 'WEBHOOK_PROCESSED',
        resourceType: 'payment',
        resourceId: result?.orderId,
        details: {
          provider,
          idempotencyKey,
          status: result?.status || (enqueued ? 'enqueued' : 'unknown'),
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Return minimal acknowledgment — no internal IDs or order details.
      // 200 after the event is durably persisted + enqueued (or processed inline).
      res.json({
        success: true,
        data: {
          message: enqueued ? 'Webhook accepted' : 'Webhook processed',
          status: result?.status || (enqueued ? 'accepted' : 'unknown'),
        },
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
    //
    // FORCE RLS: resolveStoreIdFromWebhookPayload runs in withRlsBypass
    // (cross-tenant). Once storeId is known, handleWebhook + markWebhookProcessed
    // run in runInTenantContext(storeId) so all their payment/order writes are
    // correctly scoped. When storeId is undefined handleWebhook is called
    // directly with no wrapper — see processWebhookInline's no-storeId branch.
    const storeIdForWebhook = await resolveStoreIdFromWebhookPayload(provider, payload);

    // Same offload path as the explicit /payment/:provider handler: persist to
    // the durable inbox, enqueue to Inngest, ACK 200. Inline fallback on send
    // failure so no webhook is lost. See enqueueOrProcessWebhook.
    const { enqueued, result } = await enqueueOrProcessWebhook({
      provider,
      idempotencyKey,
      storeId: storeIdForWebhook,
      payload,
      rawBody: rawBody.toString(),
      signature,
    });

    logger.info(
      { provider, storeId: storeIdForWebhook, enqueued, result },
      enqueued
        ? '[WEBHOOK] Auto-detected provider accepted + enqueued'
        : '[WEBHOOK] Auto-detected provider processed inline (Inngest fallback)'
    );

    await auditLog({
      action: enqueued ? 'WEBHOOK_ENQUEUED' : 'WEBHOOK_PROCESSED',
      resourceType: 'payment',
      resourceId: result?.orderId,
      details: {
        provider,
        idempotencyKey,
        status: result?.status || (enqueued ? 'enqueued' : 'unknown'),
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Return minimal acknowledgment — no internal IDs or order details.
    res.json({
      success: true,
      data: {
        message: enqueued ? 'Webhook accepted' : 'Webhook processed',
        status: result?.status || (enqueued ? 'accepted' : 'unknown'),
      },
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
      if (order?.store) return storefrontOrigin(order.store);
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
      if (order?.store) baseUrl = storefrontOrigin(order.store);
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
