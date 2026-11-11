/**
 * Kashier adapter: hosted payment session (SP6b), aligned to Kashier's OFFICIAL docs
 * (developers.kashier.io, fetched 2026-10-07; the facts this file leans on are pinned by
 * tests/unit/kashier-official-contract.test.ts and tests/contracts/kashier/*.json).
 *
 * The customer is redirected to Kashier's hosted page (card, wallet, bnpl) created by a
 * payment SESSION; Kashier then calls our webhook and the customer returns to the
 * storefront. The session's `order` is OUR reference (`ORD-1042-3fa9c1d2b7`): it is the
 * provider reference everywhere (status, refund, webhook `merchantOrderId`), so the payment
 * can be found from either side.
 *
 * Credentials (per merchant, encrypted at rest):
 *   merchantId  MID-<digits>-<digits>      body field `merchantId`
 *   apiKey      Payment API key            `api-key` header on create-session ONLY, and the
 *                                          HMAC key of the webhook signature
 *   secretKey   Secret key                 `Authorization: <secret>` (raw, NO Bearer)
 *   settings    { methods: ['card','wallet','bnpl'], display: 'ar' | 'en' }
 *
 * HOSTS (mode-scoped keys: a test key validates only on the test- hosts):
 *   dashboard API  test-api.kashier.io | api.kashier.io   sessions, order search, validate-credentials
 *   FEP            test-fep.kashier.io | fep.kashier.io   PUT /v3/orders/:kashierOrderId (refund)
 *
 * MONEY: Kashier takes the session amount as a DECIMAL STRING ("100.00") and sends/returns
 * decimal numbers elsewhere (refund request `transaction.amount` is a JSON NUMBER). Piastres
 * are converted at this edge only, by integer string math (`minorToDecimalString` /
 * `moneyFromGateway`), never by `/ 100`.
 *
 * WEBHOOK: `x-kashier-signature` is HMAC-SHA256 (hex) over `k=v&k=v` of the keys the payload
 * NAMES in `data.signatureKeys`, sorted alphabetically, ONLY the values URL-encoded (RFC 3986).
 * A payload that names its own signed keys must not be trusted to name the right ones, so the
 * adapter also REQUIRES the keys that carry the order, amount, currency, status and
 * transaction id to be among them: otherwise an attacker could sign nothing but a harmless
 * field and edit the amount.
 *
 * CONFIRMATION (PROVIDERS-17): the signature does not cover `event`, so no delivery is
 * applied as it arrives: `confirmWebhookEvent` asks Kashier's transaction-details API what the
 * signed transaction id really is, and that answer is what the payment pipeline applies.
 *
 * `UNVERIFIED:` marks every field that Kashier's documentation does not publish; 6c checks
 * each against a real sandbox.
 */
import crypto from 'node:crypto';
import { kashierSettingsSchema, minorToDecimalString } from '@ebda/shared';
import {
  credentialScope,
  gatewayRequest,
  IdempotencyCache,
  merchantReference,
  moneyFromGateway,
  parseJsonBody,
  resolveBaseUrl,
  safeEqual,
  webhookHeader,
  type BaseUrls,
  type FetchLike,
  type GatewayAdapterOptions,
} from './gateway-http';
import { assertChargeable, assertRefundAmount } from './provider-call';
import {
  PaymentProviderError,
  type ConnectionTestResult,
  type CreatePaymentV2Request,
  type CreatePaymentV2Result,
  type PartialRefundV2Request,
  type PaymentProviderV2,
  type PaymentStatus,
  type PaymentStatusV2,
  type ProviderCapabilities,
  type ProviderCredentials,
  type RefundV2Request,
  type RefundV2Result,
  type WebhookConfirmation,
  type WebhookEventV2,
  type WebhookHeaders,
} from './types';
import {
  classifyKashierTransaction,
  KASHIER_TRANSACTION_DETAILS_SOURCE,
  kashierTransactionDetailsPath,
  type KashierConfirmedTxn,
} from './kashier-confirm';

export const KASHIER_SIGNATURE_HEADER = 'x-kashier-signature';

/** Dashboard / management API: payment sessions, order search, validate-credentials. */
export const KASHIER_API_URLS: BaseUrls = {
  sandbox: 'https://test-api.kashier.io',
  live: 'https://api.kashier.io',
};
/** FEP (payment API): `PUT /v3/orders/:kashierOrderId` refund / void / capture. */
export const KASHIER_ORDERS_URLS: BaseUrls = {
  sandbox: 'https://test-fep.kashier.io',
  live: 'https://fep.kashier.io',
};

/** A Kashier merchant id: `MID-<digits>-<digits>` (dashboard top bar). */
export const KASHIER_MID_PATTERN = /^MID-\d+-\d+$/;

/** A session is payable for this long when the caller gives no `expiresAt`. */
const DEFAULT_SESSION_TTL_MS = 60 * 60_000;

/**
 * Keys whose values decide the payment: all must be covered by the signature. `transactionId`
 * is here because the event id (the inbox dedupe key) is built from it, and a delivery whose
 * transaction id is unsigned could be re-labelled into a "new" event.
 */
export const KASHIER_REQUIRED_SIGNED_KEYS = [
  'merchantOrderId',
  'amount',
  'currency',
  'status',
  'transactionId',
] as const;

/**
 * The session's `customer.reference`: the shopper's customer id, else `guest-<orderId>` for a
 * guest checkout. Both are opaque ids (no PII: never a phone number or an email).
 */
export function kashierCustomerReference(customerId: string | undefined, orderId: string): string {
  const id = customerId?.trim();
  return id ? id : `guest-${orderId}`;
}

/** RFC 3986 percent-encoding: `encodeURIComponent` leaves `!'()*` alone; RFC 3986 encodes them. */
const rfc3986 = (v: string): string =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  );

/**
 * The signature input: keys sorted ordinally, `key=value` pairs joined by `&`, ONLY the values
 * URL-encoded (RFC 3986: space -> %20, `|` -> %7C, `(` -> %28).
 */
export function kashierSignaturePayload(
  data: Record<string, unknown>,
  signatureKeys: string[]
): string {
  return [...signatureKeys]
    .sort()
    .map(k => `${k}=${rfc3986(String(data[k] ?? ''))}`)
    .join('&');
}

export function kashierSignature(
  data: Record<string, unknown>,
  signatureKeys: string[],
  key: string
): string {
  return crypto
    .createHmac('sha256', key)
    .update(kashierSignaturePayload(data, signatureKeys))
    .digest('hex');
}

/**
 * The `allowedMethods` token list of a session. A prepaid-only (gold) order drops `bnpl` (Ruling
 * SHARIA-GOLD-1); if that leaves nothing, the hosted page falls back to card + wallet.
 */
export function allowedMethodsFor(methods: readonly string[], excludeBnpl: boolean): string {
  const kept = excludeBnpl ? methods.filter(m => m !== 'bnpl') : [...methods];
  return (kept.length > 0 ? kept : ['card', 'wallet']).join(',');
}

const capabilities: ProviderCapabilities = {
  methods: ['card', 'wallet'],
  instructions: ['redirect'],
  currencies: ['EGP'],
  partialRefunds: true,
  refunds: true,
  webhooks: true,
  remoteStatus: true,
  savedCards: false,
};

/** Order-level `OrderStatus` (order search). PARTIALLY_REFUNDED / REFUNDED appear on refund responses. */
const ORDER_STATUS_MAP: Record<string, PaymentStatus> = {
  INITIATED: 'pending',
  CAPTURED: 'completed',
  AUTHORIZED: 'processing',
  FAILED: 'failed',
  REJECTED: 'failed',
  CANCELLED: 'cancelled',
  REVERSED: 'cancelled',
  EXPIRED: 'expired',
  // UNVERIFIED: not in the search enum, but `response.payload.order.status` of a refund shows them.
  PARTIALLY_REFUNDED: 'partially_refunded',
  REFUNDED: 'refunded',
};

/** `data.status` of a webhook is the TRANSACTION status: SUCCESS | FAILURE | PENDING. */
const WEBHOOK_STATUS_MAP: Record<string, PaymentStatus> = {
  SUCCESS: 'completed',
  FAILURE: 'failed',
  PENDING: 'pending',
};

/** Webhook `event`s that move money back to the customer. */
const REFUND_EVENTS = new Set(['refund', 'partial_refund', 'void', 'reversal']);
/** Webhook `event`s that report the payment itself. */
const PAYMENT_EVENTS = new Set(['pay', 'authorize', 'capture', 'reject']);

/** One entry of `GET /v3/payment/orders` (documented projection: no amounts). */
interface KashierOrderEntry {
  merchantOrderId?: string;
  /** The Kashier order id (uuid): the path parameter of `PUT /v3/orders/:id`. */
  orderId?: string;
  status?: string;
  // UNVERIFIED: the documented projection carries no money; read only if a response has them.
  amount?: string | number;
  capturedAmount?: string | number;
  refundedAmount?: string | number;
  method?: string;
  paidAt?: string;
}

interface OrderSearchResponse {
  data?: KashierOrderEntry[];
  pagination?: { page?: number; pages?: number };
}

interface RefundResponse {
  status?: string;
  response?: {
    status?: string;
    transactionId?: string;
    amount?: string | number;
    payload?: {
      order?: { status?: string; totalRefundedAmount?: string | number };
      transaction?: { amount?: string | number };
    };
  };
}

const present = (v: unknown): v is string | number =>
  typeof v === 'string' || typeof v === 'number';

export function createKashierProvider(options: GatewayAdapterOptions = {}): PaymentProviderV2 {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const created = new IdempotencyCache<CreatePaymentV2Result>();
  const refunds = new IdempotencyCache<RefundV2Result>();

  const apiBase = (c: ProviderCredentials) =>
    resolveBaseUrl('KASHIER_BASE_URL', KASHIER_API_URLS, c.mode, options.baseUrls);
  const fepBase = (c: ProviderCredentials) =>
    resolveBaseUrl('KASHIER_BASE_URL', KASHIER_ORDERS_URLS, c.mode, options.baseUrls);

  const requireKeys = (c: ProviderCredentials) => {
    if (!c.merchantId || !c.secretKey || !c.apiKey) {
      throw new PaymentProviderError(
        'PROVIDER_MISCONFIGURED',
        'Kashier is not set up: add the merchant id, Payment API key and Secret key'
      );
    }
    return { merchantId: c.merchantId, secretKey: c.secretKey, apiKey: c.apiKey };
  };

  /** `Authorization: <secret>` (raw value, not Bearer). Every call but create-session sends only this. */
  const authHeaders = (c: ProviderCredentials) => {
    if (!c.secretKey) {
      throw new PaymentProviderError(
        'PROVIDER_MISCONFIGURED',
        'Kashier is not set up: add the Secret key'
      );
    }
    return { Authorization: c.secretKey, 'Content-Type': 'application/json' };
  };

  /**
   * The order search entry whose merchantOrderId EQUALS `providerRef`. `search` is a partial,
   * case-insensitive match, so the exact entry may sit among look-alikes (a few pages at most).
   */
  const findOrder = async (
    c: ProviderCredentials,
    providerRef: string
  ): Promise<KashierOrderEntry> => {
    for (let page = 1; page <= 3; page++) {
      const res = await gatewayRequest<OrderSearchResponse>(
        'kashier.getStatus',
        fetchImpl,
        `${apiBase(c)}/v3/payment/orders?search=${encodeURIComponent(providerRef)}&page=${page}`,
        { method: 'GET', headers: authHeaders(c) },
        options.timeoutMs,
        { notFound: 'PAYMENT_NOT_FOUND' }
      );
      const hit = (res.data ?? []).find(o => o.merchantOrderId === providerRef);
      if (hit) return hit;
      if (!res.pagination?.pages || page >= res.pagination.pages) break;
    }
    throw new PaymentProviderError(
      'PAYMENT_NOT_FOUND',
      'kashier.getStatus: no order for that reference'
    );
  };

  /**
   * Money truth does NOT come from this call: the documented order-search projection has no
   * amounts. When a response carries them (UNVERIFIED) they are used; otherwise the amounts are
   * reported as 0 and `amountsKnown` is false. The amount and the refund total of record come
   * from the signed webhook and the refund response.
   */
  const toStatus = (o: KashierOrderEntry): { st: PaymentStatusV2; amountsKnown: boolean } => {
    const mapped = ORDER_STATUS_MAP[String(o.status ?? '').toUpperCase()] ?? 'pending';
    const amountsKnown = present(o.amount);
    const amountMinor = amountsKnown ? moneyFromGateway(o.amount, 'amount') : 0;
    const captured = present(o.capturedAmount)
      ? moneyFromGateway(o.capturedAmount, 'capturedAmount')
      : 0;
    const refundedMinor = present(o.refundedAmount)
      ? moneyFromGateway(o.refundedAmount, 'refundedAmount')
      : 0;
    const paid =
      mapped === 'completed' ||
      mapped === 'partially_refunded' ||
      mapped === 'refunded' ||
      captured > 0;
    let status: PaymentStatus = mapped;
    if (amountsKnown && paid && refundedMinor > 0) {
      status = refundedMinor >= amountMinor ? 'refunded' : 'partially_refunded';
    }
    return {
      amountsKnown,
      st: {
        amountsKnown,
        status,
        amountMinor,
        capturedMinor: amountsKnown && paid ? captured || amountMinor : 0,
        refundedMinor: amountsKnown && paid ? refundedMinor : 0,
        currency: 'EGP',
        method: o.method,
        paidAt: o.paidAt ? new Date(o.paidAt) : undefined,
      },
    };
  };

  async function doRefund(
    c: ProviderCredentials,
    providerRef: string,
    wantMinor: number | null,
    reason?: string
  ): Promise<RefundV2Result> {
    const order = await findOrder(c, providerRef);
    const { st, amountsKnown } = toStatus(order);
    const paid =
      st.status === 'completed' || st.status === 'partially_refunded' || st.status === 'refunded';
    if (!paid) {
      throw new PaymentProviderError('PAYMENT_NOT_CAPTURED', 'cannot refund an uncaptured payment');
    }
    if (typeof order.orderId !== 'string' || !order.orderId) {
      throw new PaymentProviderError(
        'PROVIDER_REJECTED',
        'kashier.refund: order has no Kashier order id'
      );
    }
    // Local bound only when the order reported amounts; otherwise Kashier enforces it.
    let amount = wantMinor;
    if (amountsKnown) {
      const remaining = st.capturedMinor - st.refundedMinor;
      amount = wantMinor ?? remaining;
      if (amount <= 0 || amount > remaining) {
        throw new PaymentProviderError(
          'REFUND_EXCEEDS_CAPTURED',
          `refund ${amount} exceeds the ${remaining} piastres still refundable`
        );
      }
    }
    const res = await gatewayRequest<RefundResponse>(
      'kashier.refund',
      fetchImpl,
      `${fepBase(c)}/v3/orders/${encodeURIComponent(order.orderId)}`,
      {
        method: 'PUT',
        headers: authHeaders(c),
        body: JSON.stringify({
          apiOperation: 'REFUND',
          reason: reason ?? 'refund',
          // JSON NUMBER (documented), from the exact decimal string: no float math.
          // Omitted = full refund of what remains (only when the remainder is unknowable here).
          ...(amount !== null
            ? { transaction: { amount: Number(minorToDecimalString(amount)) } }
            : {}),
        }),
      },
      options.timeoutMs
    );
    const outcome = String(res.status ?? res.response?.status ?? '').toUpperCase();
    if (outcome !== 'SUCCESS' && outcome !== 'PENDING') {
      throw new PaymentProviderError('PROVIDER_REJECTED', 'Kashier did not accept the refund');
    }
    const payload = res.response?.payload;
    const reported = present(payload?.order?.totalRefundedAmount)
      ? moneyFromGateway(payload?.order?.totalRefundedAmount, 'totalRefundedAmount')
      : undefined;
    const sentOrReported =
      amount ??
      (present(res.response?.amount)
        ? moneyFromGateway(res.response?.amount, 'amount')
        : present(payload?.transaction?.amount)
          ? moneyFromGateway(payload?.transaction?.amount, 'amount')
          : reported !== undefined
            ? reported - st.refundedMinor
            : undefined);
    if (sentOrReported === undefined || sentOrReported <= 0) {
      throw new PaymentProviderError(
        'PROVIDER_UNAVAILABLE',
        'Kashier accepted the refund but did not report its amount'
      );
    }
    return {
      refundRef:
        res.response?.transactionId ??
        `kashier-refund-${providerRef}-${st.refundedMinor + sentOrReported}`,
      status: outcome === 'PENDING' ? 'pending' : 'completed',
      amountMinor: sentOrReported,
      // `totalRefundedAmount` is Kashier's own running total; UNVERIFIED fallback when it is absent.
      refundedTotalMinor: reported ?? st.refundedMinor + sentOrReported,
    };
  }

  const scope = (c: ProviderCredentials) => credentialScope([c.merchantId, c.secretKey, c.mode]);

  /** An explicit false/invalid flag in an (unpublished-shape) validate-credentials body. */
  const bodyRejects = (body: unknown, depth = 0): boolean => {
    if (!body || typeof body !== 'object' || depth > 3) return false;
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (['valid', 'isValid', 'success', 'verified'].includes(k) && v === false) return true;
      if (bodyRejects(v, depth + 1)) return true;
    }
    return false;
  };

  return {
    name: 'kashier',
    capabilities,

    async testConnection(creds: ProviderCredentials): Promise<ConnectionTestResult> {
      if (!creds.merchantId || !creds.secretKey || !creds.apiKey) {
        return {
          ok: false,
          code: 'incomplete',
          message: 'Add the merchant id, Payment API key and Secret key',
        };
      }
      if (!KASHIER_MID_PATTERN.test(creds.merchantId)) {
        return {
          ok: false,
          code: 'incomplete',
          message: 'The merchant id must look like MID-1234-567',
        };
      }
      const mode = creds.mode === 'live' ? 'live' : 'test';
      try {
        const body = await gatewayRequest<unknown>(
          'kashier.testConnection',
          fetchImpl,
          `${apiBase(creds)}/v2/merchants/validate-credentials`,
          {
            method: 'POST',
            headers: authHeaders(creds),
            body: JSON.stringify({
              secretKeys: [{ mode, key: creds.secretKey }],
              apiKeys: [{ mode, key: creds.apiKey }],
            }),
          },
          options.timeoutMs
        );
        // UNVERIFIED: the 200 body is unpublished; only an explicit false/invalid flag is read.
        if (bodyRejects(body)) {
          return {
            ok: false,
            code: 'bad_credentials',
            message: 'Kashier did not accept these keys for this mode',
          };
        }
        return { ok: true, code: 'ok', message: 'Kashier accepted the credentials' };
      } catch (err) {
        const code = err instanceof PaymentProviderError ? err.code : 'PROVIDER_UNAVAILABLE';
        if (code === 'PROVIDER_MISCONFIGURED') {
          return { ok: false, code: 'bad_credentials', message: 'Kashier refused the Secret key' };
        }
        if (code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_UNAVAILABLE') {
          return {
            ok: false,
            code: 'unreachable',
            message: 'Kashier could not be reached; try again',
          };
        }
        return { ok: false, code: 'unknown', message: 'Kashier answered something unexpected' };
      }
    },

    async createPayment(
      req: CreatePaymentV2Request,
      creds: ProviderCredentials
    ): Promise<CreatePaymentV2Result> {
      assertChargeable(req);
      const keys = requireKeys(creds);
      const parsedSettings = kashierSettingsSchema.safeParse(creds.settings ?? {});
      if (!parsedSettings.success) {
        throw new PaymentProviderError('PROVIDER_MISCONFIGURED', 'Kashier settings are invalid');
      }
      const settings = parsedSettings.data;
      return created.once(scope(creds), req.idempotencyKey, async () => {
        const merchantOrderId = merchantReference(req.orderNumber, req.idempotencyKey);
        const res = await gatewayRequest<{
          _id?: string;
          sessionUrl?: string;
          paymentParams?: { amount?: string | number };
        }>(
          'kashier.createPayment',
          fetchImpl,
          `${apiBase(creds)}/v3/payment/sessions`,
          {
            method: 'POST',
            // Authorization + api-key: the only call that sends the Payment API key.
            headers: { ...authHeaders(creds), 'api-key': keys.apiKey },
            body: JSON.stringify({
              expireAt: (
                req.expiresAt ?? new Date(Date.now() + DEFAULT_SESSION_TTL_MS)
              ).toISOString(),
              maxFailureAttempts: 3,
              amount: minorToDecimalString(req.amountMinor),
              currency: 'EGP',
              order: merchantOrderId,
              merchantId: keys.merchantId,
              merchantRedirect: req.returnUrls.success,
              type: 'one-time',
              display: settings.display,
              // `customer.reference` is REQUIRED by the real API (sandbox 2026-10-08: 400
              // '"customer.reference" is required'). A guest has no customer id, so the
              // reference is derived from the order: stable, and never the phone or email.
              customer: {
                email: req.customer.email || undefined,
                reference: kashierCustomerReference(req.customer.id, req.orderId),
              },
              allowedMethods: allowedMethodsFor(
                settings.methods,
                req.metadata?.excludeBnpl === 'true'
              ),
              failureRedirect: false,
              serverWebhook: req.webhookUrl,
              metaData: { orderId: req.orderId },
            }),
          },
          options.timeoutMs
        );
        const url = res.sessionUrl;
        if (!url) {
          throw new PaymentProviderError(
            'PROVIDER_UNAVAILABLE',
            'Kashier answered without a session URL'
          );
        }
        const recordedAmount = res.paymentParams?.amount;
        const recorded = present(recordedAmount)
          ? moneyFromGateway(recordedAmount, 'amount')
          : req.amountMinor;
        return {
          providerRef: merchantOrderId,
          invoiceId: res._id,
          instruction: { kind: 'redirect', url, expiresAt: req.expiresAt },
          status: 'pending',
          amountMinor: recorded,
          currency: 'EGP',
        } satisfies CreatePaymentV2Result;
      });
    },

    verifyWebhook(
      rawBody: string | Buffer,
      hdrs: WebhookHeaders,
      creds: ProviderCredentials
    ): WebhookEventV2 {
      const given = webhookHeader(hdrs, KASHIER_SIGNATURE_HEADER);
      const key = creds.webhookSecret ?? creds.apiKey;
      if (!given || !key) {
        throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'missing signature');
      }
      const body = parseJsonBody(rawBody);
      const data = body.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'missing data');
      }
      const d = data as Record<string, unknown>;
      const signed = d.signatureKeys;
      if (!Array.isArray(signed) || !signed.every(k => typeof k === 'string')) {
        throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'no signatureKeys');
      }
      const keys = signed as string[];
      // The payload names its own signed keys: refuse one that leaves the amount, status,
      // currency, order id or transaction id unsigned, however valid its signature is.
      if (!KASHIER_REQUIRED_SIGNED_KEYS.every(k => keys.includes(k))) {
        throw new PaymentProviderError(
          'WEBHOOK_BAD_SIGNATURE',
          'signatureKeys do not cover the order, amount, currency, status and transaction'
        );
      }
      if (!safeEqual(kashierSignature(d, keys, key), given.toLowerCase())) {
        throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'signature mismatch');
      }

      const merchantOrderId = d.merchantOrderId;
      if (typeof merchantOrderId !== 'string' || !merchantOrderId) {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'missing merchantOrderId');
      }
      const transactionId = d.transactionId;
      if (typeof transactionId !== 'string' || !transactionId) {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'missing transactionId');
      }
      if (d.currency !== 'EGP') {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'unsupported currency');
      }
      // `data.amount` is a decimal NUMBER (the docs' example shows 11334 beside card.amount 11334).
      // UNVERIFIED: that it is major units (EGP) rather than piastres; read as EGP decimal here.
      const amountMinor = moneyFromGateway(d.amount, 'amount');
      if (typeof d.status !== 'string') {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'status is not a string');
      }
      const rawStatus = d.status.toUpperCase();
      const txnStatus = WEBHOOK_STATUS_MAP[rawStatus];
      if (!txnStatus) throw new PaymentProviderError('WEBHOOK_MALFORMED', 'unknown status');

      // Stable across redeliveries and bound to SIGNED values only. `event` is NOT covered by
      // the signature, so the id deliberately omits it: a captured delivery re-labelled
      // `pay` <-> `refund` keeps the SAME id and the inbox drops it as a replay, so a relabel
      // cannot be counted twice. RESIDUAL: if an attacker wins the race against the genuine
      // delivery, the relabelled one is the first stored. That is why the label is never
      // APPLIED: the payment pipeline calls `confirmWebhookEvent` (PROVIDERS-17) and acts on
      // the kind Kashier's own transaction record reports, so a relabel stores a delivery whose
      // applied effect is the genuine one.
      const eventId = `kashier:${transactionId}:${rawStatus}`;
      const event = typeof body.event === 'string' ? body.event.toLowerCase() : '';

      if (REFUND_EVENTS.has(event)) {
        return {
          kind: 'refund',
          eventId,
          providerRef: merchantOrderId,
          refundRef: transactionId,
          status:
            txnStatus === 'completed' ? 'completed' : txnStatus === 'failed' ? 'failed' : 'pending',
          amountMinor,
          currency: 'EGP',
          rawPayload: body,
        };
      }
      // `idempotency` (a replay marker) and anything unknown is NOT guessed into a payment.
      if (!PAYMENT_EVENTS.has(event)) {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'unsupported event');
      }
      // authorize + SUCCESS = funds held, not captured: not `completed`.
      const status: PaymentStatus =
        event === 'authorize' && txnStatus === 'completed' ? 'processing' : txnStatus;
      return {
        kind: 'payment',
        eventId,
        providerRef: merchantOrderId,
        status,
        amountMinor,
        currency: 'EGP',
        method: keys.includes('method') && typeof d.method === 'string' ? d.method : undefined,
        transactionRef: transactionId,
        rawPayload: body,
      };
    },

    /**
     * PROVIDERS-17: `event` is unsigned, so the kind (and the status) applied is the one
     * Kashier's transaction-details API reports for the SIGNED transaction id, never the
     * delivery's label. The signed amount, currency, order and transaction id are kept.
     * Throws (nothing applied, the webhook queue retries) when Kashier cannot be asked or
     * its answer is not a clear match.
     */
    async confirmWebhookEvent(
      ev: WebhookEventV2,
      creds: ProviderCredentials
    ): Promise<WebhookConfirmation> {
      const transactionId = ev.kind === 'refund' ? ev.refundRef : ev.transactionRef;
      if (!transactionId) {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'event has no Kashier transaction id');
      }
      const res = await gatewayRequest<unknown>(
        'kashier.confirmWebhook',
        fetchImpl,
        `${apiBase(creds)}${kashierTransactionDetailsPath(transactionId)}`,
        { method: 'GET', headers: authHeaders(creds) },
        options.timeoutMs,
        // Not found YET is not "did not happen": retried like an outage.
        { notFound: 'PROVIDER_UNAVAILABLE' }
      );
      let txn: KashierConfirmedTxn;
      try {
        txn = classifyKashierTransaction(res, { transactionId, merchantOrderId: ev.providerRef });
      } catch (err) {
        throw new PaymentProviderError(
          'PROVIDER_UNAVAILABLE',
          `kashier.confirmWebhook: ${err instanceof Error ? err.message : 'unconfirmed'}`
        );
      }
      const base = {
        eventId: ev.eventId,
        providerRef: ev.providerRef,
        amountMinor: ev.amountMinor,
        currency: 'EGP' as const,
        rawPayload: ev.rawPayload,
      };
      let event: WebhookEventV2;
      if (txn.kind === 'refund') {
        event = {
          ...base,
          kind: 'refund',
          refundRef: transactionId,
          status:
            txn.status === 'SUCCESS'
              ? 'completed'
              : txn.status === 'FAILURE'
                ? 'failed'
                : 'pending',
        };
      } else {
        const st = WEBHOOK_STATUS_MAP[txn.status];
        event = {
          ...base,
          kind: 'payment',
          // authorize + SUCCESS = funds held, not captured.
          status: txn.kind === 'authorize' && st === 'completed' ? 'processing' : st,
          method: ev.kind === 'payment' ? ev.method : undefined,
          transactionRef: transactionId,
        };
      }
      return {
        event,
        claimed: { kind: ev.kind, status: ev.status },
        confirmed: { kind: event.kind, status: event.status },
        mismatch: event.kind !== ev.kind || event.status !== ev.status,
        source: KASHIER_TRANSACTION_DETAILS_SOURCE,
      };
    },

    async getStatus(providerRef: string, creds: ProviderCredentials): Promise<PaymentStatusV2> {
      return toStatus(await findOrder(creds, providerRef)).st;
    },

    async refund(req: RefundV2Request, creds: ProviderCredentials): Promise<RefundV2Result> {
      return refunds.once(scope(creds), req.idempotencyKey, () =>
        doRefund(creds, req.providerRef, null, req.reason)
      );
    },

    async partialRefund(
      req: PartialRefundV2Request,
      creds: ProviderCredentials
    ): Promise<RefundV2Result> {
      assertRefundAmount(req.amountMinor);
      return refunds.once(scope(creds), req.idempotencyKey, () =>
        doRefund(creds, req.providerRef, req.amountMinor, req.reason)
      );
    },
  };
}

export const kashierProvider: PaymentProviderV2 = createKashierProvider();
