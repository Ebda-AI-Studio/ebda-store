/**
 * Kashier adapter (SP5 task 3). Built from the shapes documented in
 * docs/ebda/research/egypt-payment-providers.md — NO sandbox keys existed when
 * this was written, so everything marked UNVERIFIED must be confirmed against
 * `test-api.kashier.io` before go-live:
 *
 *  - UNVERIFIED: exact paths/bodies for payment sessions (`POST /v3/payment/sessions`),
 *    the saved-card charge (`POST /v3/orders`, `interactionSource: RECURRING`) and the
 *    redirect/response field names. Paths are constants below.
 *  - UNVERIFIED: that recurring/token charging is enabled on Ebda's account
 *    (the research found one account answered 404 "isn't enabled for recurring
 *    agreements"). Ask Kashier for enablement in writing.
 *  - DOCUMENTED (research): webhook = HMAC-SHA256, header `x-kashier-signature`,
 *    keyed with the Payment API key; the payload's `signatureKeys` array, sorted
 *    alphabetically, selects which `data` fields are signed; refund =
 *    `PUT /v3/orders/:orderId`; amounts are decimal strings with exactly 2dp.
 *
 * Base URL is configurable (`KASHIER_BASE_URL`, default the sandbox).
 */
import { minorToDecimalString, tryToMinor } from '@ebda/shared';
import {
  BillingProviderError,
  BillingSignatureError,
  headerValue,
  type BillingProvider,
  type BillingWebhookConfirmation,
  type BillingWebhookEvent,
  type BillingWebhookKind,
  type CardSetupRequest,
  type ChargeRequest,
  type ChargeResult,
  type CheckoutRequest,
  type CheckoutResult,
  type HeaderBag,
  type ParsedReturn,
  type RefundRequest,
  type RefundResult,
  type GatewayReversals,
} from './types';
import { hmacSha256Hex, safeEqual } from './signature';
import {
  classifyKashierTransaction,
  KASHIER_TRANSACTION_DETAILS_SOURCE,
  kashierTransactionDetailsPath,
} from '../payment-providers/kashier-confirm';

export interface KashierConfig {
  baseUrl: string;
  merchantId: string;
  /** Secret key — sent as the `Authorization` header on API calls. */
  secretKey: string;
  /** Payment API key — keys the webhook HMAC. */
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const KASHIER_SANDBOX_URL = 'https://test-api.kashier.io';
/** Operations that take money back from a charge (refund family per the webhook docs, plus chargeback names). */
const REVERSAL_OPS = new Set([
  'refund',
  'partial_refund',
  'void',
  'reversal',
  'chargeback',
  'dispute',
]);
/** Operations that move money forward or verify it (never a reversal). */
const KNOWN_FORWARD_OPS = new Set([
  'pay',
  'payment',
  'capture',
  'authorize',
  'authorization',
  '3dsecure_verify',
  'reject',
]);
const SESSIONS_PATH = '/v3/payment/sessions';
/** A subscription checkout page stays payable this long. */
const CHECKOUT_TTL_MS = 60 * 60_000;
const CHARGE_PATH = '/v3/orders';
const refundPath = (orderId: string) => `/v3/orders/${encodeURIComponent(orderId)}`;

/**
 * The signed fields a webhook MUST cover. A (validly signed) payload whose
 * `signatureKeys` omits any of these could have its unsigned amount/status
 * rewritten in transit, so it is rejected.
 */
const REQUIRED_SIGNED_KEYS = [
  'amount',
  'currency',
  'merchantOrderId',
  'status',
  // The id the dedupe key, the refund lookup and the PROVIDERS-17 confirmation use.
  'transactionId',
] as const;

/** The FEP (order operations) host for a dashboard API base: (test-)api.kashier.io -> (test-)fep. */
export function kashierFepBase(apiBase: string): string {
  return apiBase.replace(
    /^https:\/\/(test-)?api\.kashier\.io/,
    (_m, t) => `https://${t ?? ''}fep.kashier.io`
  );
}

/** Integer piastres -> Kashier's decimal string ("199.99"). Integer math only. */
export function gatewayAmount(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError(
      `Invalid amount ${amountMinor}: must be a non-negative integer of minor units`
    );
  }
  return minorToDecimalString(amountMinor, 'EGP');
}

/** Kashier decimal string -> integer piastres, or null when malformed / not 2dp-safe. */
export function parseGatewayAmount(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  return tryToMinor(String(raw), 'EGP');
}

const TOKEN_KEY = /token/i;

/** Deep copy with every `*token*` key removed — card tokens must never be persisted/logged. */
export function stripTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTokens);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (TOKEN_KEY.test(k)) continue;
      out[k] = stripTokens(v);
    }
    return out;
  }
  return value;
}

/** Percent-encode like `qs.stringify` (RFC 3986), which Kashier's reference code uses. */
function enc(v: string): string {
  return encodeURIComponent(v).replace(
    /[!'()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Signature string for a webhook `data` object: sorted `signatureKeys`, `k=v` joined by `&`. */
export function kashierSignaturePayload(
  data: Record<string, unknown>,
  signatureKeys: string[]
): string {
  return [...signatureKeys]
    .sort()
    .map(k => `${enc(k)}=${enc(scalar(data[k]))}`)
    .join('&');
}

export class KashierBillingProvider implements BillingProvider {
  readonly name = 'kashier' as const;
  /**
   * Kashier's recurring guide (https://developers.kashier.io/docs/accept-payments/recurring,
   * read 2026-10-07) delivers the card token to `serverWebhook` only "once the
   * customer completes payment"; no zero-amount / verify-only save is documented.
   * So Kashier cannot save a card with nothing charged (Ruling EBDA-FUNNEL-2): the
   * funnel runs in `pay_at_trial_end` mode on Kashier until Kashier confirms in
   * writing a no-charge (or authorize-then-void) tokenization.
   */
  readonly capabilities = { cardSetupWithoutCharge: false };
  private readonly cfg: Required<Omit<KashierConfig, 'fetchImpl'>> & { fetchImpl: typeof fetch };

  constructor(cfg: KashierConfig) {
    this.cfg = {
      timeoutMs: 15_000,
      fetchImpl: (...a) => fetch(...a),
      ...cfg,
      baseUrl: (cfg.baseUrl || KASHIER_SANDBOX_URL).replace(/\/+$/, ''),
    } as KashierBillingProvider['cfg'];
  }

  private async call(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    base: string = this.cfg.baseUrl
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    if (!this.cfg.secretKey || !this.cfg.merchantId) {
      throw new BillingProviderError('Kashier is not configured (merchant id / secret key)', true);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.cfg.fetchImpl(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: this.cfg.secretKey,
          'api-key': this.cfg.apiKey,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
        signal: ctl.signal,
      });
    } catch (err) {
      // Timeout / DNS / reset: we cannot know whether the gateway processed it.
      throw new BillingProviderError(`Kashier request failed: ${(err as Error).message}`, false);
    } finally {
      clearTimeout(timer);
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }
    if (res.status >= 500) {
      throw new BillingProviderError(`Kashier answered ${res.status}`, false);
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      // Bad keys / account not enabled for this feature: nothing was charged.
      throw new BillingProviderError(
        `Kashier refused the request (${res.status}): ${scalar(json.message ?? json.error)}`,
        true
      );
    }
    return { status: res.status, json };
  }

  async createCardSetupSession(_req: CardSetupRequest): Promise<CheckoutResult> {
    // Refused BEFORE any network call: nothing can have been charged.
    throw new BillingProviderError(
      'Kashier has no documented card tokenization without a payment (Ruling EBDA-FUNNEL-2)',
      true
    );
  }

  async createCheckoutForSubscription(req: CheckoutRequest): Promise<CheckoutResult> {
    // The fields the payment-sessions API REQUIRES (developers.kashier.io API reference,
    // CreatePaymentSessionRequest: expireAt, maxFailureAttempts, amount, currency, order,
    // merchantId, merchantRedirect, type, display, customer); `order` is what webhooks echo as
    // `merchantOrderId`. The merchant adapter (payment-providers/kashier.provider.ts) sends the same.
    const { status, json } = await this.call('POST', SESSIONS_PATH, {
      expireAt: new Date(Date.now() + CHECKOUT_TTL_MS).toISOString(),
      maxFailureAttempts: 3,
      merchantId: this.cfg.merchantId,
      order: req.merchantOrderId,
      amount: gatewayAmount(req.amountMinor),
      currency: req.currency,
      paymentType: 'credit',
      type: 'one-time',
      allowedMethods: 'card',
      // Save the card so Ebda can charge it on renewal (needs account enablement).
      // Documented values are "optional" | "forced" (payment-sessions page, 2026-10-07).
      saveCard: 'forced',
      display: req.locale ?? 'ar',
      description: req.description,
      merchantRedirect: req.returnUrl,
      serverWebhook: req.webhookUrl,
      customer: { reference: req.customer.reference, email: req.customer.email },
    });
    const url = typeof json.sessionUrl === 'string' ? json.sessionUrl : null;
    if (status >= 400 || !url) {
      throw new BillingProviderError(
        `Kashier did not return a checkout URL (${status}): ${scalar(json.message)}`,
        true
      );
    }
    return {
      redirectUrl: url,
      providerSessionId: typeof json._id === 'string' ? json._id : null,
    };
  }

  async chargeSavedCard(req: ChargeRequest): Promise<ChargeResult> {
    const { status, json } = await this.call('POST', CHARGE_PATH, {
      merchantId: this.cfg.merchantId,
      // Kashier has no idempotency header: a unique merchantOrderId per attempt
      // is the dedupe handle (research: `REN-{tenant}-{period}-{retry}`).
      merchantOrderId: req.merchantOrderId ?? req.idempotencyKey,
      amount: gatewayAmount(req.amountMinor),
      currency: req.currency,
      description: req.description,
      interactionSource: 'RECURRING',
      paymentMethod: { type: 'card', card: { cardToken: req.token } },
    });
    const raw = stripTokens(json);
    const state = scalar(json.status).toUpperCase();
    const chargeId = scalar(json.transactionId ?? json.orderId ?? json.kashierOrderId) || null;
    if (state === 'SUCCESS' || state === 'APPROVED' || state === 'PAID') {
      return { status: 'succeeded', chargeId, raw };
    }
    if (state === 'PENDING' || state === 'PROCESSING') return { status: 'pending', chargeId, raw };
    return {
      status: 'failed',
      chargeId,
      failureReason:
        scalar(json.message ?? json.errorMessage ?? json.reason) || `declined (${status})`,
      raw,
    };
  }

  /**
   * What became of a charge whose answer was lost (M-023). Kashier can only be asked by TRANSACTION id (the
   * documented transaction-details API, the same read that confirms webhooks, PROVIDERS-17). A charge whose
   * answer never arrived has no transaction id yet, and a lookup by merchant order id is not documented, so
   * without an id this THROWS (cannot tell) instead of claiming "not found": the sweep then leaves the row
   * pending and raises a P1; it never retries a charge it cannot rule out.
   */
  async getChargeStatus(req: {
    idempotencyKey: string;
    merchantOrderId: string;
    chargeId: string | null;
  }): Promise<ChargeResult | null> {
    if (!req.chargeId) {
      throw new BillingProviderError(
        'Kashier cannot be asked about a charge without a transaction id (no documented lookup by merchant order id)',
        false
      );
    }
    const { status, json } = await this.call(
      'GET',
      kashierTransactionDetailsPath(req.chargeId),
      undefined
    );
    if (status >= 400) {
      throw new BillingProviderError(`Kashier transaction details answered ${status}`, false);
    }
    let txn;
    try {
      txn = classifyKashierTransaction(json, {
        transactionId: req.chargeId,
        merchantOrderId: req.merchantOrderId,
      });
    } catch (err) {
      throw new BillingProviderError(
        `Kashier did not answer clearly: ${(err as Error).message}`,
        false
      );
    }
    if (txn.kind !== 'payment') {
      throw new BillingProviderError(`Kashier reports a ${txn.kind}, not a charge`, false);
    }
    const raw = stripTokens(json);
    if (txn.status === 'SUCCESS') return { status: 'succeeded', chargeId: req.chargeId, raw };
    if (txn.status === 'PENDING') return { status: 'pending', chargeId: req.chargeId, raw };
    return {
      status: 'failed',
      chargeId: req.chargeId,
      failureReason: 'declined (gateway lookup)',
      raw,
    };
  }

  /**
   * The daily reversal reconcile's read (#837): the charge's transaction details (the same documented
   * `getTransactionDetails` call that confirms webhooks) list every operation on it in `body.transactions[]`
   * (`operation`, `status`, `transactionId`). A successful refund-type operation, or a chargeback/dispute if Kashier
   * records one there, is a reversal. Kashier's webhook docs list `pay, authorize, capture, refund, partial_refund,
   * void, reject, reversal` as event operations and no chargeback/dispute event, so a chargeback is only seen here
   * (UNVERIFIED: the operation name Kashier would use; an unknown operation pages a person instead of being ignored).
   */
  async listReversals(req: {
    chargeId: string;
    merchantOrderId: string;
  }): Promise<GatewayReversals> {
    const { status, json } = await this.call(
      'GET',
      kashierTransactionDetailsPath(req.chargeId),
      undefined
    );
    if (status >= 400) {
      throw new BillingProviderError(`Kashier transaction details answered ${status}`, false);
    }
    const body = (json as { body?: unknown } | null)?.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || scalar(body.transactionId) !== req.chargeId) {
      throw new BillingProviderError('Kashier transaction details are not for this charge', false);
    }
    const order = scalar(body.merchantOrderId);
    if (order && order !== req.merchantOrderId) {
      throw new BillingProviderError('Kashier transaction belongs to a different order', false);
    }
    const out: GatewayReversals = { reversals: [], unknownOperations: [] };
    for (const t of Array.isArray(body.transactions) ? body.transactions : []) {
      if (!t || typeof t !== 'object') continue;
      const e = t as Record<string, unknown>;
      const op = scalar(e.operation).toLowerCase();
      const ok = scalar(e.status).toUpperCase() === 'SUCCESS';
      if (REVERSAL_OPS.has(op)) {
        if (ok && scalar(e.transactionId)) {
          out.reversals.push({
            ref: scalar(e.transactionId),
            operation: op,
            amountMinor: parseGatewayAmount(e.amount),
          });
        }
      } else if (!KNOWN_FORWARD_OPS.has(op)) {
        out.unknownOperations.push(op || '(empty)');
      }
    }
    return out;
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    // Order operations live on the FEP host (API reference `updateOrder`: test-fep.kashier.io /
    // fep.kashier.io), not on the dashboard API host the other calls use.
    const { status, json } = await this.call(
      'PUT',
      refundPath(req.chargeId),
      {
        apiOperation: 'REFUND',
        reason: `refund ${req.idempotencyKey}`,
        // A JSON NUMBER (API reference, RefundRequest; the merchant adapter does the same).
        transaction: { amount: Number(gatewayAmount(req.amountMinor)) },
      },
      kashierFepBase(this.cfg.baseUrl)
    );
    const raw = stripTokens(json);
    const state = scalar(json.status).toUpperCase();
    const refundId = scalar(json.transactionId ?? json.refundId) || null;
    if (state === 'SUCCESS' || state === 'REFUNDED') return { status: 'succeeded', refundId, raw };
    if (state === 'PENDING') return { status: 'pending', refundId, raw };
    return {
      status: 'failed',
      refundId,
      failureReason: scalar(json.message ?? json.reason) || `refund rejected (${status})`,
      raw,
    };
  }

  /** Every value a webhook needs: the Payment API key (HMAC), and the secret key + MID it confirms with. */
  isConfigured(): boolean {
    return !!(this.cfg.apiKey && this.cfg.secretKey && this.cfg.merchantId);
  }

  verifyWebhook(rawBody: Buffer | string, headers: HeaderBag): BillingWebhookEvent {
    const provided = headerValue(headers, 'x-kashier-signature');
    if (!provided) throw new BillingSignatureError('Missing x-kashier-signature');
    if (!this.cfg.apiKey) throw new BillingSignatureError('Kashier API key not configured');

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
    } catch {
      throw new BillingSignatureError('Unparseable webhook body');
    }
    const data = (payload?.data ?? null) as Record<string, unknown> | null;
    const keys = data?.signatureKeys;
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray(keys) ||
      !keys.every(k => typeof k === 'string')
    ) {
      throw new BillingSignatureError('Webhook has no signatureKeys');
    }
    for (const required of REQUIRED_SIGNED_KEYS) {
      if (!keys.includes(required)) {
        throw new BillingSignatureError(`signatureKeys does not cover "${required}"`);
      }
    }
    const expected = hmacSha256Hex(
      this.cfg.apiKey,
      kashierSignaturePayload(data, keys as string[])
    );
    if (!safeEqual(expected, provided.trim().toLowerCase())) {
      throw new BillingSignatureError();
    }

    // ── Signature good: only now interpret the payload. ──
    const rawStatus = scalar(data.status).toUpperCase();
    const isRefund = scalar(payload.event).toLowerCase() === 'refund';
    let kind: BillingWebhookKind = 'ignored';
    if (['SUCCESS', 'APPROVED', 'PAID'].includes(rawStatus)) {
      kind = isRefund ? 'refund.succeeded' : 'charge.succeeded';
    } else if (['FAILURE', 'FAILED', 'DECLINED', 'ERROR', 'EXPIRED'].includes(rawStatus)) {
      kind = isRefund ? 'refund.failed' : 'charge.failed';
    }
    const txn = scalar(data.transactionId ?? data.kashierOrderId ?? data.orderId);
    const merchantOrderId = scalar(data.merchantOrderId) || null;
    const cardToken = scalar(
      data.cardDataToken ??
        data.cardToken ??
        (data.paymentMethod as { card?: { cardToken?: unknown } } | undefined)?.card?.cardToken
    );
    const created = Date.parse(scalar(data.createdAt ?? data.date));
    return {
      eventId: `${txn || merchantOrderId || 'unknown'}:${rawStatus || 'UNKNOWN'}`,
      kind,
      merchantOrderId,
      providerRef: txn || null,
      amountMinor: parseGatewayAmount(data.amount),
      currency: scalar(data.currency) || null,
      failureReason: kind.endsWith('failed')
        ? scalar(data.message ?? data.errorMessage ?? data.reason) || rawStatus
        : undefined,
      card: cardToken ? { token: cardToken } : undefined,
      customerRef:
        scalar((data.customer as { reference?: unknown } | undefined)?.reference) || undefined,
      occurredAt: Number.isNaN(created) ? new Date() : new Date(created),
      raw: stripTokens(payload),
    };
  }

  /**
   * PROVIDERS-17: `event` (refund vs payment) is not covered by Kashier's signature, so the
   * kind applied is the one Kashier's transaction-details API reports for the SIGNED
   * transaction id. Throws (the route answers 500, Kashier redelivers, nothing is marked seen)
   * when Kashier cannot be asked or does not answer clearly.
   */
  async confirmWebhookEvent(event: BillingWebhookEvent): Promise<BillingWebhookConfirmation> {
    if (!event.providerRef) {
      throw new BillingProviderError('Kashier webhook has no transaction id to confirm', false);
    }
    const { status, json } = await this.call(
      'GET',
      kashierTransactionDetailsPath(event.providerRef),
      undefined
    );
    if (status >= 400) {
      throw new BillingProviderError(`Kashier transaction details answered ${status}`, false);
    }
    let txn;
    try {
      txn = classifyKashierTransaction(json, {
        transactionId: event.providerRef,
        merchantOrderId: event.merchantOrderId,
      });
    } catch (err) {
      throw new BillingProviderError(
        `Kashier did not confirm the webhook: ${(err as Error).message}`,
        false
      );
    }
    // A held authorization is not a charge; a pending transaction moves nothing yet.
    const kind: BillingWebhookKind =
      txn.status === 'PENDING' || txn.kind === 'authorize'
        ? 'ignored'
        : txn.kind === 'refund'
          ? txn.status === 'SUCCESS'
            ? 'refund.succeeded'
            : 'refund.failed'
          : txn.status === 'SUCCESS'
            ? 'charge.succeeded'
            : 'charge.failed';
    return {
      event: { ...event, kind },
      claimed: event.kind,
      confirmed: kind,
      mismatch: kind !== event.kind,
      source: KASHIER_TRANSACTION_DETAILS_SOURCE,
    };
  }

  parseReturn(query: Record<string, unknown>): ParsedReturn {
    const status = scalar(query.paymentStatus ?? query.status).toUpperCase();
    return {
      merchantOrderId: scalar(query.merchantOrderId) || null,
      providerRef: scalar(query.orderReference ?? query.transactionId) || null,
      outcome: ['SUCCESS', 'APPROVED', 'PAID'].includes(status)
        ? 'success'
        : status
          ? 'failure'
          : 'unknown',
      trusted: false,
    };
  }
}
