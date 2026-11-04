import { Router, Request, Response, NextFunction } from 'express';
import { storefrontOrigin } from '@ebda/shared';
import express from 'express';
import crypto from 'crypto';
import { runInTenantContext, withStore } from '@ebda/database';
import {
  findOrderByIdempotencyKey,
  getOrderStoreId,
  getStorefrontForPaymentRef,
  storefrontForStoreId,
  resolveStoreFromWebhookRef,
  webhookInbox,
} from '../lib/definer';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { PaymentProvider } from '../services/payment-providers/types';
import {
  detectGatewayProvider,
  extractWebhookSignature,
  isGatewayWebhookProvider,
  webhookRefs,
} from '../services/payment-providers/webhook-signature';
import { config } from '../config';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';
import { doStoreIdList } from '../lib/store-backend';
import { storeMoney } from '../lib/repo-factory';
import { shippingCarrierService } from '../services/shipping-carrier.service';
import { inngest } from '../lib/inngest/client';
import { sendAlert } from '../services/alerts.service';
import { redis } from '../services/redis.service';
import { isTerminalWebhookClientError } from '../lib/inngest/webhook-offload.guard';

const router = Router();

// Timing floor for every refusal (see rejectUnverifiedDelivery). Stamped on entry to this router.
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.locals.webhookStartedAt = Date.now();
  next();
});

/**
 * SEC-5: authenticate a delivery BEFORE anything is persisted or queued. The store is already
 * resolved, so its own secret is available now; a forged body therefore never writes an inbox
 * row, never emits an Inngest event and never reaches the super-admin viewer. A terminal client
 * error (bad / missing signature, malformed body) makes this return false and the caller answers
 * 401 (`rejectUnverifiedDelivery`): NOT a 200, because a genuine delivery that fails (rotated secret,
 * clock skew) must be retried by the gateway, not dropped as accepted. Anything else (DB, network)
 * rethrows: a 5xx makes the gateway retry too.
 * `handleWebhook` verifies again over the stored raw body, so the async path stays cryptographic.
 */
async function deliveryIsAuthentic(args: {
  provider: PaymentProvider;
  payload: Record<string, unknown>;
  signature: string;
  storeId: string;
  rawBody: Buffer;
  idempotencyKey: string;
}): Promise<boolean> {
  try {
    await PaymentService.verifyWebhookDelivery(
      args.provider,
      args.payload,
      args.signature,
      args.storeId,
      args.rawBody.toString()
    );
    return true;
  } catch (err) {
    if (isTerminalWebhookClientError(err)) {
      logger.warn(
        { provider: args.provider, storeId: args.storeId, idempotencyKey: args.idempotencyKey },
        '[WEBHOOK] Signature not verified; not persisted, not queued'
      );
      return false;
    }
    throw err;
  }
}

/** Failures per source IP and store before the answer becomes 429 (per 5 minutes). */
const SIGNATURE_FAILURES_PER_SOURCE = 20;

/**
 * Every refusal takes at least this long from the start of the request (padded with a sleep), so the
 * fast no-store branch is not distinguishable from the slower real signature check by timing. A real
 * check that is already slower than the floor is not padded; the floor only removes the fast side.
 */
export const REJECT_FLOOR_MS = 150;

/**
 * A fixed-cost HMAC over the raw body, burned when there is no store (or the wrong store) to verify
 * against, so the unknown-payment answer costs about what a real signature check costs and timing
 * does not tell the two apart. The result is discarded.
 */
async function burnDummyWork(rawBody: Buffer): Promise<void> {
  const mac = crypto.createHmac('sha256', 'ebda-webhook-dummy-key').update(rawBody).digest();
  crypto.timingSafeEqual(mac, Buffer.alloc(mac.length));
  try {
    // The same Redis round trip the real failure path makes (hmac-fail counter), on a dummy key.
    await redis.incrementRateLimit('payment-hmac-fail:dummy', 300);
  } catch {
    // best effort
  }
}

/**
 * The ONE answer for every delivery we will not act on because it cannot be authenticated: a bad
 * signature, a payment no store owns, and a payment that belongs to another store than the URL
 * names. Same status and same generic body for all three, so the response is no oracle for which
 * payment references exist. 401, not 200: a genuine delivery that fails (rotated secret, clock
 * skew) must be RETRIED by the gateway, never accepted and dropped. Nothing is stored. Failures are
 * counted per source IP (one bucket, so the count cannot tell the cases apart either); past the
 * budget the answer is 429, still a retry signal. The P0 alert "payment webhook signature failures
 * for store X" fires from `PaymentService.verifyWebhookDelivery` after 3 failures in 5 minutes.
 * A gateway retries a 401 a bounded number of times, then gives up.
 */
async function rejectUnverifiedDelivery(req: Request, res: Response): Promise<void> {
  const startedAt = (res.locals.webhookStartedAt as number | undefined) ?? Date.now();
  let failures = 0;
  try {
    failures = await redis.incrementRateLimit(`webhook-sigfail:${req.ip ?? 'unknown'}`, 300);
  } catch {
    // Counting is best effort; the refusal below is the control.
  }
  // Pad to the floor so every refusal takes the same minimum time.
  const wait = REJECT_FLOOR_MS - (Date.now() - startedAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  if (failures > SIGNATURE_FAILURES_PER_SOURCE) {
    res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many invalid webhook signatures' },
    });
    return;
  }
  res.status(401).json({
    success: false,
    error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature could not be verified' },
  });
}

/**
 * A VALIDLY SIGNED delivery whose payment no store can resolve yet (audit M-050 / DB-2). The Payment row
 * is committed only after the gateway accepts the invoice, and on Cloudflare the entity index lags the
 * checkout by an outbox drain, so a fast callback can arrive first. 200 made the gateway drop it for
 * good and the order stayed unpaid; answer 503 + Retry-After so the gateway redelivers, and tell an
 * operator. Only reachable after the signature verified (Ruling WEBHOOK-ORDER-1), so it reveals
 * nothing to an unauthenticated caller.
 */
function respondUnresolvedPayment(res: Response, provider: string, idempotencyKey: string): void {
  logger.warn(
    { provider, idempotencyKey },
    '[WEBHOOK] Verified delivery, no store owns this payment yet; asking for a retry'
  );
  void sendAlert({
    level: 'info',
    scope: 'platform',
    source: 'payment.webhook.unresolved',
    title: `payment webhook for an unknown payment (${provider})`,
    body: `A signed ${provider} webhook named a payment no store owns. It was answered 503 so the gateway retries. If it keeps arriving, find the payment at the provider.`,
    context: { provider, idempotencyKey },
  }).catch(() => undefined);
  res
    .status(503)
    .set('Retry-After', '60')
    .json({
      success: false,
      error: { code: 'PAYMENT_NOT_YET_VISIBLE', message: 'Payment not found yet, please retry' },
    });
}

function respondUnresolvedForDoFleet(
  res: Response,
  provider: string,
  idempotencyKey: string
): void {
  logger.error(
    { provider, idempotencyKey },
    '[WEBHOOK] No store resolves this reference while Durable Object stores exist; refused for retry'
  );
  void sendAlert({
    level: 'p0',
    scope: 'platform',
    source: 'payment.webhook.unresolvable_do_fleet',
    title: 'payment webhook with an unresolvable reference while Durable Object stores exist',
    body: `A ${provider} webhook named a payment neither Postgres nor the D1 entity index resolves. It was answered 503 so the gateway retries (nothing was applied). If it keeps arriving, the entity index outbox is stuck or the payment is unknown: check d1_outbox dead letters, then the provider dashboard.`,
    context: { provider, idempotencyKey },
  }).catch(() => undefined);
  res
    .status(503)
    .set('Retry-After', '60')
    .json({
      success: false,
      error: { code: 'PAYMENT_NOT_YET_VISIBLE', message: 'Payment not found yet, please retry' },
    });
}

/**
 * Ruling WEBHOOK-ORDER-1: authenticate FIRST. Returns the owning store id, or undefined after having
 * answered:
 *  - a bad or missing signature, a payment no store can be found for (generic URL), or a payment of
 *    another store than the URL names: the ONE constant 401 (`rejectUnverifiedDelivery`), identical
 *    bytes for all, padded to the timing floor;
 *  - a VALID signature (per-store URL, checked with that store's secret before any payment lookup) for a
 *    payment not resolvable yet: 503 + Retry-After (M-050).
 * The generic URL carries no store, so the payment lookup has to come first there; an unresolvable
 * reference cannot be verified and gets the same constant 401.
 */
async function gateDelivery(args: {
  req: Request;
  res: Response;
  provider: PaymentProvider;
  payload: Record<string, unknown>;
  rawBody: Buffer;
  signature: string;
  idempotencyKey: string;
  urlStoreId: string | undefined;
}): Promise<string | undefined> {
  const { req, res, provider, payload, rawBody, signature, idempotencyKey, urlStoreId } = args;
  const authentic = (storeId: string) =>
    deliveryIsAuthentic({ provider, payload, signature, storeId, rawBody, idempotencyKey });
  const refuse = async (burn: boolean) => {
    if (burn) await burnDummyWork(rawBody);
    await rejectUnverifiedDelivery(req, res);
    return undefined;
  };

  if (urlStoreId) {
    if (!(await authentic(urlStoreId))) return refuse(false);
    const owner = await resolveStoreIdFromWebhookPayload(provider, payload, urlStoreId);
    // A reference that belongs to ANOTHER store is indistinguishable from an unknown one: same 503,
    // same body. Otherwise a caller holding store A's secret could probe which refs exist in store B.
    if (!owner || owner !== urlStoreId) {
      // Ruling WEBHOOK-SCOPE-1: refused and logged server-side only; the caller sees the same 503 either way.
      logger.warn(
        { provider, urlStoreId, idempotencyKey, crossStore: Boolean(owner) },
        owner
          ? '[WEBHOOK] Reference belongs to another store than the signed one; refused'
          : '[WEBHOOK] Reference not found in the signed store; refused'
      );
      respondUnresolvedPayment(res, provider, idempotencyKey);
      return undefined;
    }
    return owner;
  }

  const owner = await resolveStoreIdFromWebhookPayload(provider, payload);
  if (!owner) {
    // Once any store lives on its Durable Object an unresolvable reference may be ITS payment whose index row has not landed
    // (CF-PAY-1): never the constant 401 (the gateway would not retry and the order would stay unpaid), but 503 + retry and a
    // P0. The answer is the same for a forged delivery, so it reveals nothing; the alert is throttled by its fixed title.
    if ((await doStoreIdList()).length > 0) {
      await burnDummyWork(rawBody);
      respondUnresolvedForDoFleet(res, provider, idempotencyKey);
      return undefined;
    }
    return refuse(true);
  }
  if (!(await authentic(owner))) return refuse(false);
  return owner;
}

/**
 * The key a delivery is stored and deduped under: the store id in front of the provider's own key.
 * `orders.idempotency_key` and the inbox key are globally unique, so two stores that hold the same
 * provider reference string would otherwise treat each other's deliveries as duplicates (Ruling WEBHOOK-SCOPE-1).
 */
export function storeScopedIdempotencyKey(storeId: string, idempotencyKey: string): string {
  return `${storeId}:${idempotencyKey}`;
}

/**
 * Check if a webhook has already been processed (idempotency check).
 *
 * Runs through a SECURITY DEFINER lookup because the storeId is not known yet
 * at this point (we haven't resolved which store this webhook belongs to). The
 * query is read-only and cross-tenant by nature — we're matching on an
 * idempotency key that may span any store.
 */
async function checkIdempotency(
  idempotencyKey: string,
  storeId: string
): Promise<{
  alreadyProcessed: boolean;
  orderId?: string;
}> {
  // A store on its Durable Object dedupes inside the DO (`payment_event_log`, same section as the effects, Ruling CF-PAY-1);
  // there is no Postgres order row to look up (NZ-N12-3: nothing of a DO store's webhook may touch Postgres).
  if (await storeMoney(storeId)) return { alreadyProcessed: false };
  // The store is not known yet, so this exact-key lookup is a definer
  // (`ebda_webhook_order_by_idempotency`), not a store-scoped read.
  const order = await findOrderByIdempotencyKey(idempotencyKey);
  // Ruling WEBHOOK-SCOPE-1: a key another store settled is not a duplicate of THIS store's delivery.
  if (order && order.storeId !== storeId) return { alreadyProcessed: false };
  if (order && order.webhookProcessedAt) {
    return { alreadyProcessed: true, orderId: order.orderId };
  }
  return { alreadyProcessed: false, orderId: order?.orderId };
}

/**
 * The ONE dedupe check every payment-webhook entry path uses (provider route, per-store route and
 * the auto-detect route): the current key, then any earlier key shape the same delivery may have
 * been stored under (`legacyIdempotencyKeys`), so a replay cannot slip past on a changed format.
 */
async function checkWebhookIdempotency(
  provider: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  storeId: string
): Promise<{ alreadyProcessed: boolean; orderId?: string }> {
  const first = await checkIdempotency(storeScopedIdempotencyKey(storeId, idempotencyKey), storeId);
  if (first.alreadyProcessed) return first;
  // Keys written before WEBHOOK-SCOPE-1 carry no store prefix: still honoured, but only for this store's orders.
  const unscoped = [
    webhookRefs(provider, payload).idempotencyKey,
    ...(webhookRefs(provider, payload).legacyIdempotencyKeys ?? []),
  ];
  for (const legacy of unscoped) {
    if (!legacy) continue;
    const hit = await checkIdempotency(legacy, storeId);
    if (hit.alreadyProcessed) return hit;
  }
  return first;
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
  // storeId is required so the write runs inside a store scope. When it is
  // unavailable (an orderId with no storeId) the order's own store is looked up
  // by primary key through a definer — never a bypass.
  const scopeStoreId = storeId ?? (await getOrderStoreId(orderId));
  if (!scopeStoreId) return;
  // A store on its Durable Object keeps its dedupe in the DO (`payment_event_log`, written in the same section as the
  // effects, Ruling CF-PAY-1): there is no Postgres order row to stamp.
  if (await storeMoney(scopeStoreId)) return;
  await withStore(scopeStoreId, tx =>
    tx.order.update({
      where: { id: orderId, storeId: scopeStoreId },
      data: { idempotencyKey, webhookProcessedAt: new Date() },
    })
  );
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
 * Goes through SECURITY DEFINER functions: webhook_events is a cross-tenant
 * inbox (storeId may be null on the platform path, and the Inngest consumer
 * must read the row before it can enter tenant context). Mirrors
 * checkIdempotency / resolveStoreIdFromWebhookPayload, which also run
 * cross-tenant.
 */
async function recordInboundWebhook(input: {
  provider: PaymentProvider;
  idempotencyKey: string;
  storeId?: string;
  payload: Record<string, unknown>;
  rawBody: string;
  signature: string;
}): Promise<string> {
  // First delivery: create the row. On the unique-key conflict (a
  // re-delivery), refresh the volatile fields — but ONLY for a row that has
  // NOT already been processed. This preserves the stored audit bytes
  // (rawBody/signature/payload) of a 'processed' row so a late re-delivery
  // can't corrupt the record of what we actually acted on. `status` is never
  // touched here: a non-terminal row stays reprocessable, a 'processed' row
  // stays a consumer no-op (shouldProcessInboxRow). The fresh inngest.send
  // below re-enqueues regardless.
  //
  // One definer call (`ebda_webhook_inbox_record`, INSERT ... ON CONFLICT), so
  // two near-simultaneous deliveries of the same txn cannot race into a P2002
  // and a 500 / provider retry loop.
  return webhookInbox.record({
    provider: input.provider,
    idempotencyKey: input.idempotencyKey,
    storeId: input.storeId ?? null,
    payload: input.payload,
    rawBody: input.rawBody,
    signature: input.signature,
  });
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
    let result: Awaited<ReturnType<typeof processWebhookInline>>;
    try {
      result = await processWebhookInline({
        provider,
        idempotencyKey,
        storeId,
        payload,
        rawBody,
        signature,
      });
    } catch (inlineErr) {
      // The tenant transaction rolled back, so nothing inside it (payment events included)
      // records WHY. Keep the reason on the durable inbox row (super-admin /webhook-events,
      // replayable), the same 'failed' + lastError the Inngest consumer writes, then rethrow:
      // the 5xx makes the gateway redeliver. Example: a Kashier delivery Kashier could not
      // confirm yet (PROVIDERS-17).
      await webhookInbox
        .update(webhookEventId, {
          status: 'failed',
          lastError: (inlineErr instanceof Error ? inlineErr.message : String(inlineErr)).slice(
            0,
            1000
          ),
        })
        .catch(() => undefined);
      throw inlineErr;
    }
    // Mark the inbox row processed so a later replay sweep doesn't re-run it.
    await webhookInbox
      .update(webhookEventId, {
        status: 'processed',
        markProcessed: {
          resultOrderId: result.orderId ?? null,
          resultStatus: result.status ?? null,
        },
      })
      .catch(() => undefined);
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
    // No storeId: the payload could not be matched to a payment, so there is no
    // store scope to enter. handleWebhook then runs contextless, which under
    // strict RLS can only find nothing and answers "no matching payment" — the
    // same outcome the platform-only (env-var) path always had for an unknown
    // reference. It must never be given a bypass.
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
 * transaction ID we can hash on: the handler then 400s the request (and
 * Sentry sees it) instead of letting every malformed webhook from one
 * provider collide on a single `${prefix}_undefined` row and be silently
 * dropped as "already processed". The key is built from fields the gateway
 * names in the (still unverified) body; it only dedupes, never authorises.
 */
function generateIdempotencyKey(
  provider: PaymentProvider,
  payload: Record<string, unknown>
): string | null {
  return webhookRefs(provider, payload).idempotencyKey;
}

/**
 * Resolve which store this webhook belongs to BEFORE calling handleWebhook,
 * so PaymentService.handleWebhook can verify the signature with the
 * correct per-store webhook secret from PaymentConfig (not an empty
 * platform-level fallback).
 *
 * Returns undefined when we can't match the payload to a Payment row;
 * handleWebhook then finds no payment and acknowledges.
 *
 * Runs through a SECURITY DEFINER lookup (`ebda_webhook_resolve_store_scoped`: within the provider, the URL store first; exact
 * match on the provider reference, store id only) because the storeId is unknown
 * at this point. Once it is known the caller switches to runInTenantContext for
 * all subsequent writes.
 */
async function resolveStoreIdFromWebhookPayload(
  provider: PaymentProvider,
  payload: Record<string, unknown>,
  urlStoreId?: string
): Promise<string | undefined> {
  const { transactionId, invoiceId } = webhookRefs(provider, payload);
  if (!transactionId && !invoiceId) return undefined;
  // Within the delivering provider, and the URL's store first: a reference shared with another provider's or
  // another store's payment must not decide which store owns THIS delivery (Ruling ITEST-14).
  return (
    (await resolveStoreFromWebhookRef({
      transactionId,
      invoiceId,
      provider,
      preferStoreId: urlStoreId ?? null,
    })) ?? undefined
  );
}

// ==========================================
// Egypt Payment Provider Webhooks
// Supports: Paymob, Kashier, Fawry
// ==========================================

/**
 * POST /webhooks/payment/:provider
 * Handle payment provider webhooks with idempotency
 */
router.post('/payment/:provider', (req: Request, res: Response, next: NextFunction) =>
  handleGatewayWebhook(req, res, next, undefined)
);

/**
 * POST /webhooks/payment/:provider/s/:storeId
 * The per-store URL the settings page shows the merchant (`paymentWebhookUrl`). Same pipeline as
 * above; the store in the path is only an EXPECTATION: the owning store is still resolved from the
 * payment reference in the body, and a delivery whose payment belongs to a different store is
 * ignored (200, nothing processed) rather than trusted.
 */
router.post('/payment/:provider/s/:storeId', (req: Request, res: Response, next: NextFunction) => {
  const storeId = req.params.storeId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storeId)) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    return;
  }
  return handleGatewayWebhook(req, res, next, storeId);
});

async function handleGatewayWebhook(
  req: Request,
  res: Response,
  next: NextFunction,
  urlStoreId: string | undefined
): Promise<void> {
  try {
    const provider = req.params.provider as PaymentProvider;

    // Validate provider
    if (!isGatewayWebhookProvider(provider)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PROVIDER', message: 'Invalid payment provider' },
      });
      return;
    }

    // req.body is a raw Buffer (from express.raw). Parse it here so handlers
    // can access properties while the raw Buffer is preserved for signature
    // verification inside PaymentService.handleWebhook.
    const rawBody: Buffer = req.body as Buffer;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString()) as Record<string, unknown>;
    } catch {
      res.status(400).json({
        success: false,
        error: { code: 'MALFORMED_BODY', message: 'Webhook body is not JSON' },
      });
      return;
    }

    // Each gateway carries its signature somewhere else (Paymob: ?hmac= query; Kashier: a
    // header; Fawry: `messageSignature` in the body). Every webhook must be signed; whether
    // the signature is VALID is decided later, over the raw body, with the merchant's secret.
    const signature = extractWebhookSignature(provider, req, payload);
    if (!signature) {
      // One constant answer, no lookup, no audit row for an unauthenticated caller (WEBHOOK-ORDER-1).
      await rejectUnverifiedDelivery(req, res);
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

    // Pass the parsed payload for business logic and the raw body string for
    // HMAC signature verification so providers compute the correct digest.
    // storeId is resolved upfront so handleWebhook can load the right
    // per-store webhook secret for signature verification — without this,
    // signature checks against platform-level env vars (always empty in
    // Ebda prod) would reject every per-tenant webhook.
    //
    // FORCE RLS: resolveStoreIdFromWebhookPayload runs in withRlsBypass
    // (cross-tenant). Once storeId is known, handleWebhook + markWebhookProcessed
    // run in runInTenantContext(storeId) so all their payment/order writes are
    // correctly scoped. When storeId is undefined (platform-level path)
    // handleWebhook is called directly with no wrapper — see
    // processWebhookInline's no-storeId branch for why.
    const storeIdForWebhook = await gateDelivery({
      req,
      res,
      provider,
      payload,
      rawBody,
      signature,
      idempotencyKey,
      urlStoreId: urlStoreId,
    });
    if (!storeIdForWebhook) return;

    // Per-store URL: the payment must belong to the store the URL names. Same 401 as an unknown payment.
    if (urlStoreId && urlStoreId !== storeIdForWebhook) {
      logger.warn(
        { provider, idempotencyKey, urlStoreId },
        '[WEBHOOK] Payment belongs to another store than the webhook URL; refused'
      );
      await burnDummyWork(rawBody);
      await rejectUnverifiedDelivery(req, res);
      return;
    }

    if (
      !(await deliveryIsAuthentic({
        provider,
        payload,
        signature,
        storeId: storeIdForWebhook,
        rawBody,
        idempotencyKey,
      }))
    ) {
      await rejectUnverifiedDelivery(req, res);
      return;
    }

    // Duplicate check AFTER authentication: a forged body must learn nothing about which payments
    // exist and must not write an audit row (SEC-5).
    // Check for duplicate webhook
    const { alreadyProcessed, orderId } = await checkWebhookIdempotency(
      provider,
      payload,
      idempotencyKey,
      storeIdForWebhook
    );

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

    // Offload the heavy PaymentService.handleWebhook mutation off this request:
    // persist the raw event to the durable WebhookEvent inbox, enqueue an
    // Inngest event, and ACK 200 immediately. The payment-webhook-process
    // function runs handleWebhook + markWebhookProcessed in
    // runInTenantContext(storeId) off the shared API pool, so a webhook storm
    // can't starve auth (P2024). If inngest.send fails we process inline as
    // before so the webhook is never lost.
    const { enqueued, result } = await enqueueOrProcessWebhook({
      provider,
      idempotencyKey: storeScopedIdempotencyKey(storeIdForWebhook, idempotencyKey),
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

    // Detect the gateway from the payload shape (Paymob wraps a `TRANSACTION` object, Kashier
    // names `signatureKeys`, Fawry sends `fawryRefNumber`). An unrecognised body is refused.
    const provider = detectGatewayProvider(payload);
    if (!provider) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PROVIDER', message: 'Unrecognised payment webhook' },
      });
      return;
    }

    const signature = extractWebhookSignature(provider, req, payload);

    if (!signature) {
      // One constant answer, no lookup (WEBHOOK-ORDER-1).
      await rejectUnverifiedDelivery(req, res);
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
    const storeIdForWebhook = await gateDelivery({
      req,
      res,
      provider,
      payload,
      rawBody,
      signature,
      idempotencyKey,
      urlStoreId: undefined,
    });
    if (!storeIdForWebhook) return;

    if (
      !(await deliveryIsAuthentic({
        provider,
        payload,
        signature,
        storeId: storeIdForWebhook,
        rawBody,
        idempotencyKey,
      }))
    ) {
      await rejectUnverifiedDelivery(req, res);
      return;
    }

    // Duplicate check AFTER authentication: a forged body must learn nothing about which payments
    // exist and must not write an audit row (SEC-5).
    const { alreadyProcessed, orderId } = await checkWebhookIdempotency(
      provider,
      payload,
      idempotencyKey,
      storeIdForWebhook
    );

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

    // Same offload path as the explicit /payment/:provider handler: persist to
    // the durable inbox, enqueue to Inngest, ACK 200. Inline fallback on send
    // failure so no webhook is lost. See enqueueOrProcessWebhook.
    const { enqueued, result } = await enqueueOrProcessWebhook({
      provider,
      idempotencyKey: storeScopedIdempotencyKey(storeIdForWebhook, idempotencyKey),
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
  // The reference each gateway appends to a redirect back to us: Paymob `order` (its order id),
  // Kashier `merchantOrderId`, Fawry `merchantRefNumber`. A shopper's browser is never trusted:
  // the outcome below is asked of the gateway, not read from the query.
  const { order, merchantOrderId, merchantRefNumber } = req.query;
  const transactionId = (order || merchantOrderId || merchantRefNumber) as string;

  // Which gateway sent the shopper back, from the parameter it uses: the lookup stays inside that provider.
  const callbackProvider = order ? 'paymob' : merchantOrderId ? 'kashier' : 'fawry';

  // ONE store resolution for the whole callback (provider-scoped, Ruling ITEST-14): the status read and the
  // storefront the shopper is sent back to must come from the same store, which two separate definer lookups on
  // a shared reference could not promise.
  const resolveCallbackStore = async (): Promise<string | null> =>
    transactionId
      ? resolveStoreFromWebhookRef({ transactionId, provider: callbackProvider })
      : null;

  // Resolve the correct storefront URL — custom domain if the store has one,
  // otherwise fall back to the platform's web URL.
  async function getStorefrontUrl(storeId: string | null): Promise<string> {
    try {
      if (!storeId) return config.webUrl;
      const store = await storefrontForStoreId(storeId);
      if (store) return storefrontOrigin(store);
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
    // Under strict RLS the payment is found inside its store's scope (the store comes from
    // the same definer the webhooks use).
    const callbackStoreId = await resolveCallbackStore();
    const [status, baseUrl] = await Promise.all([
      callbackStoreId
        ? withStore(callbackStoreId, () =>
            PaymentService.getPaymentStatus(transactionId, undefined, callbackStoreId)
          )
        : PaymentService.getPaymentStatus(transactionId),
      getStorefrontUrl(callbackStoreId),
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
      const store = await getStorefrontForPaymentRef(String(transaction_id));
      if (store) baseUrl = storefrontOrigin(store);
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

/** The JSON body of a carrier callback (the webhook router is mounted behind `express.raw`). */
function carrierWebhookBody(req: Request): unknown {
  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString('utf8'));
    } catch {
      return null;
    }
  }
  return req.body;
}

/**
 * POST /webhooks/shipping/bosta/:storeId/:token
 *
 * Bosta signs nothing, so the callback URL it is given per delivery carries this store's
 * secret token (the `webhookSecret` in the store's encrypted Bosta credentials) AND Bosta echoes
 * a custom header Ebda set on that delivery (`webhookCustomHeaders`, a value derived from the
 * secret): the service requires both (ruling PROVIDERS-12). A wrong token, a missing or wrong
 * header, an unknown store and a store without Bosta are all the same 401, so the response is
 * no oracle; a valid call is always answered 200 (an unrecognised or repeated event is a
 * no-op), so Bosta does not retry what we have already taken in.
 *
 * Aramex has no tracking push: it is polled by the tracking cron instead.
 */
router.post('/shipping/bosta/:storeId/:token', async (req: Request, res: Response) => {
  try {
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, String(v ?? '')])
    );
    const outcome = await shippingCarrierService.processCarrierWebhook(
      'bosta',
      req.params.storeId,
      req.params.token,
      carrierWebhookBody(req),
      headers
    );
    if (outcome === 'unauthorized') {
      logger.warn({ ip: req.ip }, '[WEBHOOK] Bosta webhook rejected: bad secret or unknown store');
      res.sendStatus(401);
      return;
    }
    res.sendStatus(200);
  } catch (err) {
    logger.error({ err }, '[WEBHOOK] Bosta shipping webhook error');
    // Bosta retries a non-2xx: an error on our side is worth a retry
    res.sendStatus(500);
  }
});

export default router;
