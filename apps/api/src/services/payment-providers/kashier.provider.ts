/**
 * Kashier adapter: hosted payment session (SP6b).
 *
 * The customer is redirected to Kashier's hosted page (card, wallet) created by a
 * payment SESSION; Kashier then calls our webhook and the customer returns to the
 * storefront. The session's merchant order id is OUR reference (`ORD-1042-3fa9c1d2b7`):
 * it is the provider reference everywhere (status, refund, webhook), so the payment can
 * be found from either side.
 *
 * Credentials (per merchant, encrypted at rest):
 *   merchantId  MID-...                    apiKey  Payment API key (also the webhook key)
 *   secretKey   Secret key (`Authorization` header on server calls)
 *   settings    { methods: ['card','wallet'], display: 'ar' | 'en' }
 *
 * MONEY: Kashier takes and returns DECIMAL amounts with two places ("123.45"). Piastres
 * are converted at this edge only, by integer string math (`minorToDecimalString` /
 * `toMinor`), never by `/ 100`.
 *
 * WEBHOOK: `x-kashier-signature` is HMAC-SHA256 (hex) over `key=value&...` of the keys
 * the payload NAMES in `data.signatureKeys`, sorted alphabetically. A payload that names
 * its own signed keys must not be trusted to name the right ones, so the adapter also
 * REQUIRES the keys that carry the order, amount, currency and status to be among them:
 * otherwise an attacker could sign nothing but a harmless field and edit the amount.
 *
 * `UNVERIFIED:` marks every field that could not be confirmed against Kashier's own
 * documentation (developers.kashier.io was unreachable when this was written); 6c
 * checks each against a real sandbox.
 */
import crypto from 'node:crypto';
import { kashierSettingsSchema, minorToDecimalString } from '@force/shared';
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
  type WebhookEventV2,
  type WebhookHeaders,
} from './types';

export const KASHIER_SIGNATURE_HEADER = 'x-kashier-signature';

export const KASHIER_API_URLS: BaseUrls = {
  // Payment sessions. Sandbox host from the research brief (developers.kashier.io).
  sandbox: 'https://test-api.kashier.io',
  // UNVERIFIED: the live API host.
  live: 'https://api.kashier.io',
};
export const KASHIER_ORDERS_URLS: BaseUrls = {
  // UNVERIFIED: order retrieval / refund live on the "fep" host (test-fep.kashier.io is
  // named in the research brief; which endpoint uses which host is not confirmed).
  sandbox: 'https://test-fep.kashier.io',
  live: 'https://fep.kashier.io',
};

/** Keys whose values decide the payment: all four must be covered by the signature. */
export const KASHIER_REQUIRED_SIGNED_KEYS = [
  'merchantOrderId',
  'amount',
  'currency',
  'status',
] as const;

/** The signature input: sorted keys, `key=value` pairs joined by `&`, values URL-encoded. */
export function kashierSignaturePayload(
  data: Record<string, unknown>,
  signatureKeys: string[]
): string {
  return [...signatureKeys]
    .sort()
    .map(k => `${k}=${encodeURIComponent(String(data[k] ?? ''))}`)
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

const STATUS_MAP: Record<string, PaymentStatus> = {
  SUCCESS: 'completed',
  PAID: 'completed',
  CAPTURED: 'completed',
  PENDING: 'pending',
  PROCESSING: 'processing',
  CREATED: 'pending',
  FAILED: 'failed',
  FAILURE: 'failed',
  DECLINED: 'failed',
  ERROR: 'failed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled',
};

interface KashierOrder {
  merchantOrderId?: string;
  status?: string;
  amount?: string | number;
  capturedAmount?: string | number;
  refundedAmount?: string | number;
  currency?: string;
  method?: string;
  paidAt?: string;
}

export function createKashierProvider(options: GatewayAdapterOptions = {}): PaymentProviderV2 {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const created = new IdempotencyCache<CreatePaymentV2Result>();
  const refunds = new IdempotencyCache<RefundV2Result>();

  const apiBase = (c: ProviderCredentials) =>
    resolveBaseUrl('KASHIER_BASE_URL', KASHIER_API_URLS, c.mode, options.baseUrls);
  const ordersBase = (c: ProviderCredentials) =>
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

  const headers = (c: ProviderCredentials) => {
    const k = requireKeys(c);
    return {
      // UNVERIFIED: header names. Kashier documents the secret key as `Authorization` and the
      // Payment API key as `api-key` for payment sessions.
      Authorization: k.secretKey,
      'api-key': k.apiKey,
      'Content-Type': 'application/json',
    };
  };

  const readOrder = async (c: ProviderCredentials, providerRef: string): Promise<KashierOrder> => {
    const res = await gatewayRequest<{ response?: KashierOrder } & KashierOrder>(
      'kashier.getStatus',
      fetchImpl,
      // UNVERIFIED: GET /v3/orders/{merchantOrderId} and its `{ response: {...} }` envelope.
      `${ordersBase(c)}/v3/orders/${encodeURIComponent(providerRef)}`,
      { method: 'GET', headers: headers(c) },
      options.timeoutMs,
      { notFound: 'PAYMENT_NOT_FOUND' }
    );
    return res.response ?? res;
  };

  const toStatus = (o: KashierOrder): PaymentStatusV2 => {
    const amountMinor = moneyFromGateway(o.amount, 'amount');
    const captured =
      o.capturedAmount !== undefined ? moneyFromGateway(o.capturedAmount, 'capturedAmount') : 0;
    const refundedMinor =
      o.refundedAmount !== undefined ? moneyFromGateway(o.refundedAmount, 'refundedAmount') : 0;
    const mapped = STATUS_MAP[String(o.status ?? '').toUpperCase()] ?? 'pending';
    const paid = mapped === 'completed' || captured > 0;
    let status: PaymentStatus = mapped;
    if (paid && refundedMinor > 0) {
      status = refundedMinor >= amountMinor ? 'refunded' : 'partially_refunded';
    }
    return {
      status,
      amountMinor,
      capturedMinor: paid ? captured || amountMinor : 0,
      refundedMinor: paid ? refundedMinor : 0,
      currency: 'EGP',
      method: o.method,
      paidAt: o.paidAt ? new Date(o.paidAt) : undefined,
    };
  };

  async function doRefund(
    c: ProviderCredentials,
    providerRef: string,
    wantMinor: number | null,
    reason?: string
  ): Promise<RefundV2Result> {
    const st = toStatus(await readOrder(c, providerRef));
    if (st.capturedMinor <= 0) {
      throw new PaymentProviderError('PAYMENT_NOT_CAPTURED', 'cannot refund an uncaptured payment');
    }
    const remaining = st.capturedMinor - st.refundedMinor;
    const amount = wantMinor ?? remaining;
    if (amount <= 0 || amount > remaining) {
      throw new PaymentProviderError(
        'REFUND_EXCEEDS_CAPTURED',
        `refund ${amount} exceeds the ${remaining} piastres still refundable`
      );
    }
    const res = await gatewayRequest<{
      status?: string;
      response?: { transactionId?: string; status?: string };
    }>(
      'kashier.refund',
      fetchImpl,
      // UNVERIFIED: PUT /v3/orders/{id} with `apiOperation: "REFUND"` (research brief names the
      // path; the body shape and the string-typed amount are not confirmed).
      `${ordersBase(c)}/v3/orders/${encodeURIComponent(providerRef)}`,
      {
        method: 'PUT',
        headers: headers(c),
        body: JSON.stringify({
          apiOperation: 'REFUND',
          reason: reason ?? 'refund',
          transaction: { amount: minorToDecimalString(amount) },
        }),
      },
      options.timeoutMs
    );
    const ok = String(res.status ?? res.response?.status ?? '').toUpperCase();
    if (ok !== 'SUCCESS' && ok !== 'PENDING') {
      throw new PaymentProviderError('PROVIDER_REJECTED', 'Kashier did not accept the refund');
    }
    return {
      refundRef:
        res.response?.transactionId ?? `kashier-refund-${providerRef}-${st.refundedMinor + amount}`,
      status: ok === 'PENDING' ? 'pending' : 'completed',
      amountMinor: amount,
      refundedTotalMinor: st.refundedMinor + amount,
    };
  }

  const scope = (c: ProviderCredentials) => credentialScope([c.merchantId, c.secretKey, c.mode]);

  return {
    name: 'kashier',
    capabilities,

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
          sessionId?: string;
          sessionUrl?: string;
          amount?: string | number;
        }>(
          'kashier.createPayment',
          fetchImpl,
          // UNVERIFIED: POST /v3/payment/sessions and the field names of body and response.
          `${apiBase(creds)}/v3/payment/sessions`,
          {
            method: 'POST',
            headers: headers(creds),
            body: JSON.stringify({
              merchantId: keys.merchantId,
              order: merchantOrderId,
              amount: minorToDecimalString(req.amountMinor),
              currency: 'EGP',
              type: 'one-time',
              allowedMethods: settings.methods.join(','),
              display: settings.display,
              merchantRedirect: req.returnUrls.success,
              failureRedirect: false,
              serverWebhook: req.webhookUrl,
              customer: { email: req.customer.email || undefined, reference: req.customer.id },
              metaData: { orderId: req.orderId },
              ...(req.expiresAt ? { expireAt: req.expiresAt.toISOString() } : {}),
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
        const recorded =
          res.amount !== undefined ? moneyFromGateway(res.amount, 'amount') : req.amountMinor;
        return {
          providerRef: merchantOrderId,
          invoiceId: res._id ?? res.sessionId,
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
      // currency or order id unsigned, however valid its signature is.
      if (!KASHIER_REQUIRED_SIGNED_KEYS.every(k => keys.includes(k))) {
        throw new PaymentProviderError(
          'WEBHOOK_BAD_SIGNATURE',
          'signatureKeys do not cover the order, amount, currency and status'
        );
      }
      if (!safeEqual(kashierSignature(d, keys, key), given.toLowerCase())) {
        throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'signature mismatch');
      }

      const merchantOrderId = d.merchantOrderId;
      if (typeof merchantOrderId !== 'string' || !merchantOrderId) {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'missing merchantOrderId');
      }
      if (d.currency !== 'EGP') {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'unsupported currency');
      }
      const amountMinor = moneyFromGateway(d.amount, 'amount');
      const rawStatus = String(d.status ?? '').toUpperCase();
      // Identity only from SIGNED values: `body.event` and any key `signatureKeys` leaves out
      // are not covered by the signature, so a captured delivery could be edited to look new
      // (a second `order/created`) or to look like a refund.
      const txn =
        keys.includes('transactionId') && typeof d.transactionId === 'string'
          ? d.transactionId
          : undefined;
      const identity = `${merchantOrderId}:${rawStatus}:${amountMinor}:${txn ?? ''}`;

      // A refund is told from the SIGNED status, not from the unsigned `event` field.
      // UNVERIFIED: the status strings Kashier uses for refunds.
      if (/^(PARTIALLY_?|PARTIAL_?)?REFUND/.test(rawStatus)) {
        return {
          kind: 'refund',
          eventId: `kashier:refund:${identity}`,
          providerRef: merchantOrderId,
          refundRef: txn ?? `${merchantOrderId}-refund-${amountMinor}`,
          status: /FAIL|REJECT|DECLIN/.test(rawStatus)
            ? 'failed'
            : /PEND/.test(rawStatus)
              ? 'pending'
              : 'completed',
          amountMinor,
          currency: 'EGP',
          rawPayload: body,
        };
      }
      const status = STATUS_MAP[rawStatus];
      if (!status) throw new PaymentProviderError('WEBHOOK_MALFORMED', 'unknown status');
      return {
        kind: 'payment',
        eventId: `kashier:pay:${identity}`,
        providerRef: merchantOrderId,
        status,
        amountMinor,
        currency: 'EGP',
        method: typeof d.method === 'string' ? d.method : undefined,
        paidAt:
          status === 'completed' && typeof d.paidAt === 'string' ? new Date(d.paidAt) : undefined,
        rawPayload: body,
      };
    },

    async getStatus(providerRef: string, creds: ProviderCredentials): Promise<PaymentStatusV2> {
      return toStatus(await readOrder(creds, providerRef));
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
