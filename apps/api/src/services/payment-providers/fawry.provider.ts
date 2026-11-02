/**
 * Fawry (FawryPay) adapter: reference code at a Fawry outlet, and card (SP6b).
 *
 * Implemented from Fawry's official developer docs (developer.fawrystaging.com, extracted
 * 2026-10-07); `UNVERIFIED:` marks every point those pages do not state.
 *
 *  - `PayAtFawry`: POST /ECommerceWeb/Fawry/payments/charge returns a reference NUMBER; the
 *    customer pays cash at a Fawry outlet quoting it, and Fawry notifies us. Rendered as a
 *    `reference-code` instruction.
 *  - `CARD`: the HOSTED checkout link (POST /fawrypay-api/api/payments/init, answered with a
 *    bare URL string; the customer is redirected there). The server-to-server 3-D Secure charge
 *    needs raw card data (PCI scope), so this adapter never uses it.
 *
 * Credentials (per merchant, encrypted at rest):
 *   merchantId  merchant code      apiKey  secure key (signs requests AND notifications)
 *   settings    { methods: ['payatfawry','card'], expiryHours }
 * The merchant reference we send (`merchantRefNum`, `ORD-1042-3fa9c1d2b7`) is the provider
 * reference everywhere. Fawry's own reference NUMBER (PayAtFawry charge response, or
 * `fawryRefNumber` of status v2) is what refunds use; the hosted card flow has none up front,
 * so `invoiceId` stays undefined there and a refund reads it from status v2.
 *
 * MONEY: Fawry takes and returns amounts with TWO decimals. Piastres are converted at this
 * edge by integer string math (`minorToDecimalString` / `toMinor`), and the signatures use
 * the same two-place text, so a signature can never disagree with the amount sent.
 *
 * SIGNATURES are plain SHA-256 over concatenated fields with the secure key APPENDED (not
 * an HMAC): charge, hosted init, status, refund and the notification's `messageSignature`
 * (which is in the BODY, not a header). Formulas are pinned in
 * `tests/unit/fawry-official-contract.test.ts` against the documented samples.
 *
 * Hosts: staging https://atfawry.fawrystaging.com; production https://www.atfawry.com for
 * /ECommerceWeb/..., and https://atfawry.com (no www) for the hosted-checkout init.
 * UNVERIFIED: production host of status v2 (docs show only staging; www.atfawry.com by symmetry).
 */
import crypto from 'node:crypto';
import {
  fawrySettingsSchema,
  minorToDecimalString,
  FAWRY_DEFAULT_EXPIRY_HOURS,
} from '@ebda/shared';
import {
  credentialScope,
  gatewayRequest,
  IdempotencyCache,
  merchantReference,
  moneyFromGateway,
  parseJsonBody,
  resolveBaseUrl,
  safeEqual,
  type BaseUrls,
  type FetchLike,
  type GatewayAdapterOptions,
} from './gateway-http';
import { assertChargeable, assertRefundAmount, callProvider } from './provider-call';
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
  type WebhookEventV2,
  type WebhookHeaders,
} from './types';
import { timedFetch } from '../../lib/fetch-with-timeout';

export const FAWRY_BASE_URLS: BaseUrls = {
  // Staging host from Fawry's developer portal; live host from Fawry's integration pages.
  sandbox: 'https://atfawry.fawrystaging.com',
  live: 'https://www.atfawry.com',
};

/** Hosted-checkout init host: production has NO `www` there (official docs). Same override mechanism. */
export const FAWRY_HOSTED_BASE_URLS: BaseUrls = {
  sandbox: 'https://atfawry.fawrystaging.com',
  live: 'https://atfawry.com',
};

/** Fawry's documented ceiling for a 2-decimal JSON number to survive a double: keep it far below 2^53. */
export const FAWRY_MAX_MINOR = 1_000_000_000_000;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export interface FawryNotification {
  requestId?: string;
  fawryRefNumber?: string;
  merchantRefNumber?: string;
  paymentAmount?: number | string;
  orderAmount?: number | string;
  orderStatus?: string;
  paymentMethod?: string;
  paymentRefrenceNumber?: string;
  messageSignature?: string;
  [k: string]: unknown;
}

/**
 * `messageSignature` of a server notification (v2):
 * SHA-256(fawryRefNumber + merchantRefNumber + paymentAmount(2dp) + orderAmount(2dp) +
 *         orderStatus + paymentMethod + paymentRefrenceNumber(if any) + secureKey).
 * The reference library spells it `paymentRefrenceNumber`, and so does Fawry's payload.
 */
export function fawryNotificationSignature(
  n: Required<
    Pick<
      FawryNotification,
      'fawryRefNumber' | 'merchantRefNumber' | 'orderStatus' | 'paymentMethod'
    >
  > & { paymentAmountMinor: number; orderAmountMinor: number; paymentRefrenceNumber?: string },
  secureKey: string
): string {
  return sha256(
    n.fawryRefNumber +
      n.merchantRefNumber +
      minorToDecimalString(n.paymentAmountMinor) +
      minorToDecimalString(n.orderAmountMinor) +
      n.orderStatus +
      n.paymentMethod +
      (n.paymentRefrenceNumber ?? '') +
      secureKey
  );
}

/**
 * PayAtFawry charge: SHA-256(merchantCode + merchantRefNum + customerProfileId(if any) +
 * paymentMethod + amount(2dp) + secureKey). `paymentMethod` is the mixed-case request value
 * ("PayAtFawry"). The card fields and returnUrl belong only to the server-side card charge.
 */
export const fawryChargeSignature = (
  p: {
    merchantCode: string;
    merchantRefNum: string;
    customerProfileId?: string;
    paymentMethod: string;
    amountMinor: number;
  },
  secureKey: string
) =>
  sha256(
    p.merchantCode +
      p.merchantRefNum +
      (p.customerProfileId ?? '') +
      p.paymentMethod +
      minorToDecimalString(p.amountMinor) +
      secureKey
  );

export interface FawryInitItem {
  itemId: string;
  quantity: number;
  priceMinor: number;
}

/**
 * Hosted checkout init: SHA-256(merchantCode + merchantRefNum + customerProfileId("" if none) +
 * returnUrl + for each item sorted by itemId: itemId + quantity + price(2dp) + secureKey).
 */
export const fawryHostedInitSignature = (
  p: {
    merchantCode: string;
    merchantRefNum: string;
    customerProfileId?: string;
    returnUrl: string;
    items: FawryInitItem[];
  },
  secureKey: string
) =>
  sha256(
    p.merchantCode +
      p.merchantRefNum +
      (p.customerProfileId ?? '') +
      p.returnUrl +
      [...p.items]
        .sort((x, y) => (x.itemId < y.itemId ? -1 : x.itemId > y.itemId ? 1 : 0))
        .map(i => i.itemId + String(i.quantity) + minorToDecimalString(i.priceMinor))
        .join('') +
      secureKey
  );

export const fawryStatusSignature = (merchantCode: string, merchantRef: string, key: string) =>
  sha256(merchantCode + merchantRef + key);

/** SHA-256(merchantCode + referenceNumber + refundAmount(2dp) + reason(if exists) + secureKey). */
export const fawryRefundSignature = (
  merchantCode: string,
  referenceNumber: string,
  refundMinor: number,
  reason: string,
  key: string
) => sha256(merchantCode + referenceNumber + minorToDecimalString(refundMinor) + reason + key);

const capabilities: ProviderCapabilities = {
  methods: ['payatfawry', 'card'],
  instructions: ['reference-code', 'redirect'],
  currencies: ['EGP'],
  partialRefunds: true,
  refunds: true,
  webhooks: true,
  remoteStatus: true,
  savedCards: false,
};

const STATUS_MAP: Record<string, PaymentStatus> = {
  NEW: 'pending',
  UNPAID: 'pending',
  PAID: 'completed',
  DELIVERED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELED: 'cancelled',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
  PARTIAL_REFUNDED: 'partially_refunded',
};

/** Fawry status codes (refund + status pages). */
const CODE_MERCHANT_INVALID = 9901;
const CODE_ORDER_NOT_FOUND = 9938;
const CODE_REFUND_TOO_BIG = 9935;
const CODE_NOT_PAID = 9954;
const CODE_BAD_SIGNATURE = 9946;

interface FawryStatusBody {
  statusCode?: number | string;
  statusDescription?: string;
  /** Fawry's own reference number (the one a refund takes). */
  fawryRefNumber?: string | number;
  merchantRefNumber?: string;
  orderStatus?: string;
  orderAmount?: number | string;
  paymentAmount?: number | string;
  /**
   * UNVERIFIED: NOT in Fawry's documented status v2 payload. Read only when present, so a
   * gateway that does send it is tracked exactly; otherwise a REFUNDED order reads as fully
   * refunded and a PARTIAL_REFUNDED one as "amount not reported".
   */
  refundedAmount?: number | string;
  paymentMethod?: string;
  /** Documented both as epoch ms and as "dd-MM-yyyy HH:mm:ss". */
  paymentTime?: number | string;
}

/** The hosted init answers a bare URL string; a JSON string literal is accepted too. */
function parseInitUrl(text: string): string | undefined {
  let candidate = text.trim();
  if (candidate.startsWith('"')) {
    try {
      const v: unknown = JSON.parse(candidate);
      if (typeof v === 'string') candidate = v.trim();
    } catch {
      return undefined;
    }
  }
  try {
    const u = new URL(candidate);
    return u.protocol === 'https:' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** paymentTime as epoch ms (number or digit string). The "dd-MM-yyyy HH:mm:ss" form carries no
 * timezone in the docs, so it is left undefined rather than guessed. */
function parsePaymentTime(v: unknown): Date | undefined {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' && /^\d{10,}$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function createFawryProvider(options: GatewayAdapterOptions = {}): PaymentProviderV2 {
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((url, init) => timedFetch('fawry', 'payment')(url, init));
  const created = new IdempotencyCache<CreatePaymentV2Result>();
  const refunds = new IdempotencyCache<RefundV2Result>();

  const base = (c: ProviderCredentials) =>
    resolveBaseUrl('FAWRY_BASE_URL', FAWRY_BASE_URLS, c.mode, options.baseUrls);
  const hostedBase = (c: ProviderCredentials) =>
    resolveBaseUrl('FAWRY_BASE_URL', FAWRY_HOSTED_BASE_URLS, c.mode, options.baseUrls);

  const requireKeys = (c: ProviderCredentials) => {
    if (!c.merchantId || !c.apiKey) {
      throw new PaymentProviderError(
        'PROVIDER_MISCONFIGURED',
        'Fawry is not set up: add the merchant code and the secure key'
      );
    }
    return { merchantCode: c.merchantId, secureKey: c.apiKey };
  };

  const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };

  /**
   * Fawry reports most failures as HTTP 200 with a `statusCode` other than 200.
   * 9938 order not found, 9901 / 9946 merchant code / signature refused (a credentials
   * problem), 9935 refund above the paid amount, 9954 order not paid; anything else is a
   * rejected request. (The refund page documents the codes; they are applied to every call.)
   */
  const assertOk = (
    op: string,
    body: { statusCode?: number | string; statusDescription?: string }
  ) => {
    const code = Number(body.statusCode ?? 200);
    if (code === 200) return;
    const text = String(body.statusDescription ?? '');
    switch (code) {
      case CODE_ORDER_NOT_FOUND:
        throw new PaymentProviderError('PAYMENT_NOT_FOUND', `${op}: ${code} ${text}`.trim());
      case CODE_MERCHANT_INVALID:
      case CODE_BAD_SIGNATURE:
        throw new PaymentProviderError(
          'PROVIDER_MISCONFIGURED',
          `${op}: Fawry refused the merchant code or signature (${code})`
        );
      case CODE_REFUND_TOO_BIG:
        throw new PaymentProviderError('REFUND_EXCEEDS_CAPTURED', `${op}: ${code} ${text}`.trim());
      case CODE_NOT_PAID:
        throw new PaymentProviderError('PAYMENT_NOT_CAPTURED', `${op}: ${code} ${text}`.trim());
      default:
        throw new PaymentProviderError('PROVIDER_REJECTED', `${op}: ${code} ${text}`.trim());
    }
  };

  /** One signed status v2 call; returns the raw body (the caller decides what a code means). */
  const statusCall = async (
    c: ProviderCredentials,
    merchantRef: string
  ): Promise<FawryStatusBody> => {
    const k = requireKeys(c);
    const q = new URLSearchParams({
      merchantCode: k.merchantCode,
      merchantRefNumber: merchantRef,
      signature: fawryStatusSignature(k.merchantCode, merchantRef, k.secureKey),
    });
    return gatewayRequest<FawryStatusBody>(
      'fawry.getStatus',
      fetchImpl,
      `${base(c)}/ECommerceWeb/Fawry/payments/status/v2?${q.toString()}`,
      { method: 'GET', headers: jsonHeaders },
      options.timeoutMs,
      { notFound: 'PAYMENT_NOT_FOUND' }
    );
  };

  const readStatus = async (
    c: ProviderCredentials,
    merchantRef: string
  ): Promise<FawryStatusBody> => {
    const res = await statusCall(c, merchantRef);
    assertOk('fawry.getStatus', res);
    return res;
  };

  /**
   * Status v2 has NO refunded-amount field: REFUNDED means the whole paid amount, and
   * PARTIAL_REFUNDED means "some, amount not reported" (`refundedKnown: false`, refundedMinor
   * 0 and NOT a guess; Fawry itself enforces the ceiling with 9935 on the next refund).
   */
  const toStatus = (s: FawryStatusBody): PaymentStatusV2 & { refundedKnown: boolean } => {
    const amountMinor = moneyFromGateway(s.orderAmount ?? s.paymentAmount, 'orderAmount');
    const mapped = STATUS_MAP[String(s.orderStatus ?? '').toUpperCase()] ?? 'pending';
    const paid = mapped === 'completed' || mapped === 'refunded' || mapped === 'partially_refunded';
    const paidMinor =
      s.paymentAmount !== undefined
        ? moneyFromGateway(s.paymentAmount, 'paymentAmount')
        : amountMinor;
    let refundedMinor = 0;
    let refundedKnown = true;
    if (s.refundedAmount !== undefined) {
      refundedMinor = moneyFromGateway(s.refundedAmount, 'refundedAmount');
    } else if (mapped === 'refunded') {
      refundedMinor = paidMinor;
    } else if (mapped === 'partially_refunded') {
      refundedKnown = false;
    }
    return {
      status: mapped,
      amountMinor,
      capturedMinor: paid ? paidMinor : 0,
      refundedMinor: paid ? Math.min(refundedMinor, paidMinor) : 0,
      refundedKnown,
      currency: 'EGP',
      method: s.paymentMethod,
      paidAt: paid ? parsePaymentTime(s.paymentTime) : undefined,
    };
  };

  async function doRefund(
    c: ProviderCredentials,
    providerRef: string,
    wantMinor: number | null,
    reason?: string
  ): Promise<RefundV2Result> {
    const k = requireKeys(c);
    const status = await readStatus(c, providerRef);
    const st = toStatus(status);
    const fawryRef = status.fawryRefNumber !== undefined ? String(status.fawryRefNumber) : '';
    if (st.capturedMinor <= 0 || !fawryRef) {
      throw new PaymentProviderError('PAYMENT_NOT_CAPTURED', 'cannot refund an uncaptured payment');
    }
    // When the refunded total is not reported (PARTIAL_REFUNDED), no remainder is computed: the
    // whole paid amount is the only ceiling we can state and Fawry enforces the rest (9935).
    const remaining = st.refundedKnown ? st.capturedMinor - st.refundedMinor : st.capturedMinor;
    const amount = wantMinor ?? remaining;
    if (amount <= 0 || amount > remaining) {
      throw new PaymentProviderError(
        'REFUND_EXCEEDS_CAPTURED',
        `refund ${amount} exceeds the ${remaining} piastres still refundable`
      );
    }
    const why = (reason ?? '').slice(0, 100);
    const res = await gatewayRequest<{ statusCode?: number | string; statusDescription?: string }>(
      'fawry.refund',
      fetchImpl,
      `${base(c)}/ECommerceWeb/Fawry/payments/refund`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          merchantCode: k.merchantCode,
          referenceNumber: fawryRef,
          refundAmount: Number(minorToDecimalString(amount)),
          ...(why ? { reason: why } : {}),
          signature: fawryRefundSignature(k.merchantCode, fawryRef, amount, why, k.secureKey),
        }),
      },
      options.timeoutMs
    );
    assertOk('fawry.refund', res);
    return {
      // Fawry returns no refund id (documented response: type/statusCode/statusDescription), so the
      // reference is derived and stable.
      refundRef: `fawry-refund-${fawryRef}-${st.refundedMinor + amount}`,
      status: 'completed',
      amountMinor: amount,
      // UNVERIFIED: after a PARTIAL_REFUNDED order the prior total is unknown, so this is a LOWER
      // bound (this refund only); the payment pipeline keeps its own refund ledger.
      refundedTotalMinor: st.refundedMinor + amount,
    };
  }

  /** Hosted-checkout init: the answer is a bare URL string, not JSON (so not `gatewayRequest`). */
  const initCardCheckout = (c: ProviderCredentials, body: unknown): Promise<string> =>
    callProvider(
      'fawry.createPayment',
      async signal => {
        const res = await fetchImpl(`${hostedBase(c)}/fawrypay-api/api/payments/init`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify(body),
          signal,
        });
        const text = await res.text();
        if (res.ok) {
          const url = parseInitUrl(text);
          if (url) return url;
          // A JSON error object (HTTP 200 with a statusCode) is mapped like every other call.
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          if (parsed && typeof parsed === 'object') {
            assertOk('fawry.createPayment', parsed as { statusCode?: number | string });
          }
          throw new PaymentProviderError(
            'PROVIDER_UNAVAILABLE',
            'fawry.createPayment: Fawry answered without a card page URL'
          );
        }
        if (res.status === 401 || res.status === 403) {
          throw new PaymentProviderError(
            'PROVIDER_MISCONFIGURED',
            `fawry.createPayment: the gateway refused the merchant credentials (HTTP ${res.status})`
          );
        }
        if (res.status >= 500 || res.status === 429 || res.status === 408) {
          throw new PaymentProviderError(
            'PROVIDER_UNAVAILABLE',
            `fawry.createPayment: gateway HTTP ${res.status}`
          );
        }
        throw new PaymentProviderError(
          'PROVIDER_REJECTED',
          `fawry.createPayment: gateway HTTP ${res.status}`
        );
      },
      options.timeoutMs
    );

  const scope = (c: ProviderCredentials) => credentialScope([c.merchantId, c.apiKey, c.mode]);

  return {
    name: 'fawry',
    capabilities,

    /**
     * ONE status v2 call for a reference that cannot exist, correctly signed. Documented:
     * 9946 wrong signature, 9901 invalid merchant code. UNVERIFIED: that status v2 answers an
     * unknown order with 9938 (documented on the refund page only), so 9938 = "credentials
     * accepted, order not found" is the assumed success. Never throws, never echoes a body.
     */
    async testConnection(creds: ProviderCredentials): Promise<ConnectionTestResult> {
      if (!creds.merchantId || !creds.apiKey) {
        return {
          ok: false,
          code: 'incomplete',
          message: 'Fawry needs the merchant code and the secure key',
        };
      }
      const probe = `ebda-conn-${crypto.randomBytes(8).toString('hex')}`;
      try {
        const res = await statusCall(creds, probe);
        const code = Number(res.statusCode ?? 200);
        if (code === CODE_ORDER_NOT_FOUND) {
          return {
            ok: true,
            code: 'ok',
            message: 'Fawry accepted the merchant code and secure key',
          };
        }
        if (code === CODE_MERCHANT_INVALID || code === CODE_BAD_SIGNATURE) {
          return {
            ok: false,
            code: 'bad_credentials',
            message: 'Fawry refused the merchant code or secure key',
          };
        }
        return {
          ok: false,
          code: 'unknown',
          message: `Fawry answered with an unexpected status code (${Number.isFinite(code) ? code : 'none'})`,
        };
      } catch (err) {
        if (err instanceof PaymentProviderError) {
          if (err.code === 'PROVIDER_MISCONFIGURED') {
            return {
              ok: false,
              code: 'bad_credentials',
              message: 'Fawry refused the merchant credentials',
            };
          }
          if (err.isOutage) {
            return { ok: false, code: 'unreachable', message: 'Fawry could not be reached' };
          }
        }
        return { ok: false, code: 'unknown', message: 'Fawry answered something unexpected' };
      }
    },

    async createPayment(
      req: CreatePaymentV2Request,
      creds: ProviderCredentials
    ): Promise<CreatePaymentV2Result> {
      assertChargeable(req);
      if (req.amountMinor > FAWRY_MAX_MINOR) {
        throw new PaymentProviderError('AMOUNT_INVALID', 'amount is above the supported maximum');
      }
      const k = requireKeys(creds);
      const parsed = fawrySettingsSchema.safeParse(creds.settings ?? {});
      if (!parsed.success) {
        throw new PaymentProviderError('PROVIDER_MISCONFIGURED', 'Fawry settings are invalid');
      }
      const settings = parsed.data;
      const wanted = req.metadata?.method;
      const method = (wanted ?? settings.methods[0]).toLowerCase();
      if (method !== 'payatfawry' && method !== 'card') {
        throw new PaymentProviderError(
          'PROVIDER_MISCONFIGURED',
          `Fawry method "${method}" is unknown`
        );
      }
      if (!(settings.methods as readonly string[]).includes(method)) {
        throw new PaymentProviderError(
          'PROVIDER_MISCONFIGURED',
          `Fawry method "${method}" is not enabled for this merchant`
        );
      }
      // customerMobile and customerEmail are required by both Fawry calls.
      if (!req.customer.phone || !req.customer.email) {
        throw new PaymentProviderError(
          'PROVIDER_REJECTED',
          'Fawry needs the customer mobile number and email'
        );
      }
      const customerMobile = req.customer.phone;
      const customerEmail = req.customer.email;
      const language = req.customer.language === 'en' ? 'en-gb' : 'ar-eg';

      return created.once(scope(creds), req.idempotencyKey, async () => {
        const merchantRefNum = merchantReference(req.orderNumber, req.idempotencyKey);
        const expiresAt =
          req.expiresAt ??
          new Date(Date.now() + (settings.expiryHours ?? FAWRY_DEFAULT_EXPIRY_HOURS) * 3_600_000);
        const lines = (req.items ?? []).filter(
          i => Number.isSafeInteger(i.unitPrice) && i.quantity > 0
        );
        const linesTotal = lines.reduce((n, i) => n + i.unitPrice * i.quantity, 0);
        // The items must add up to the amount (shipping, coupons, the wallet part otherwise
        // break that): one line carries the whole amount unless the customer's lines do.
        const items: Array<{
          itemId: string;
          description: string;
          priceMinor: number;
          quantity: number;
        }> =
          lines.length > 0 && linesTotal === req.amountMinor
            ? lines.map((i, n) => ({
                itemId: i.sku ?? `item-${n + 1}`,
                description: i.name.slice(0, 100),
                priceMinor: i.unitPrice,
                quantity: i.quantity,
              }))
            : [
                {
                  itemId: req.orderNumber ?? req.orderId,
                  description: `Order ${req.orderNumber ?? req.orderId}`,
                  priceMinor: req.amountMinor,
                  quantity: 1,
                },
              ];
        const chargeItems = items.map(i => ({
          itemId: i.itemId,
          description: i.description,
          price: Number(minorToDecimalString(i.priceMinor)),
          quantity: i.quantity,
        }));
        const description = `Order ${req.orderNumber ?? req.orderId}`;

        if (method === 'card') {
          // Hosted checkout: NO amount field (the total is the items), the signature covers the
          // return URL and the items sorted by itemId.
          const returnUrl = req.returnUrls.success;
          const url = await initCardCheckout(creds, {
            merchantCode: k.merchantCode,
            merchantRefNum,
            customerMobile,
            customerEmail,
            customerName: req.customer.name,
            paymentExpiry: expiresAt.getTime(),
            language,
            chargeItems,
            returnUrl,
            authCaptureModePayment: false,
            paymentMethod: 'CARD',
            ...(req.webhookUrl ? { orderWebHookUrl: req.webhookUrl } : {}),
            signature: fawryHostedInitSignature(
              {
                merchantCode: k.merchantCode,
                merchantRefNum,
                returnUrl,
                items: items.map(i => ({
                  itemId: i.itemId,
                  quantity: i.quantity,
                  priceMinor: i.priceMinor,
                })),
              },
              k.secureKey
            ),
          });
          return {
            providerRef: merchantRefNum,
            // No Fawry reference number exists yet; status v2 provides it later.
            invoiceId: undefined,
            instruction: { kind: 'redirect', url, expiresAt },
            status: 'pending',
            amountMinor: req.amountMinor,
            currency: 'EGP',
            metadata: { method: 'CARD' },
          } satisfies CreatePaymentV2Result;
        }

        const paymentMethod = 'PayAtFawry';
        const res = await gatewayRequest<{
          statusCode?: number | string;
          statusDescription?: string;
          referenceNumber?: string | number;
          orderAmount?: number | string;
          /** UNVERIFIED: not on the documented charge response (only on the hosted return URL). */
          expirationTime?: number;
        }>(
          'fawry.createPayment',
          fetchImpl,
          `${base(creds)}/ECommerceWeb/Fawry/payments/charge`,
          {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({
              merchantCode: k.merchantCode,
              merchantRefNum,
              customerName: req.customer.name,
              customerMobile,
              customerEmail,
              paymentMethod,
              amount: Number(minorToDecimalString(req.amountMinor)),
              currencyCode: 'EGP',
              description,
              language,
              paymentExpiry: expiresAt.getTime(),
              chargeItems,
              ...(req.webhookUrl ? { orderWebHookUrl: req.webhookUrl } : {}),
              signature: fawryChargeSignature(
                {
                  merchantCode: k.merchantCode,
                  merchantRefNum,
                  paymentMethod,
                  amountMinor: req.amountMinor,
                },
                k.secureKey
              ),
            }),
          },
          options.timeoutMs
        );
        assertOk('fawry.createPayment', res);
        const referenceNumber =
          res.referenceNumber !== undefined ? String(res.referenceNumber) : '';
        if (!referenceNumber) {
          throw new PaymentProviderError(
            'PROVIDER_UNAVAILABLE',
            'Fawry answered without a reference number'
          );
        }
        const recorded =
          res.orderAmount !== undefined
            ? moneyFromGateway(res.orderAmount, 'orderAmount')
            : req.amountMinor;
        // The documented response has no expiry: it is the paymentExpiry we sent.
        const expiry = res.expirationTime ? new Date(res.expirationTime) : expiresAt;
        return {
          providerRef: merchantRefNum,
          invoiceId: referenceNumber,
          instruction: { kind: 'reference-code', code: referenceNumber, expiresAt: expiry },
          status: 'pending',
          amountMinor: recorded,
          currency: 'EGP',
          metadata: { method: 'PAYATFAWRY' },
        } satisfies CreatePaymentV2Result;
      });
    },

    verifyWebhook(
      rawBody: string | Buffer,
      _headers: WebhookHeaders,
      creds: ProviderCredentials
    ): WebhookEventV2 {
      const key = creds.webhookSecret ?? creds.apiKey;
      const body = parseJsonBody(rawBody) as FawryNotification;
      // The signature is IN the body (`messageSignature`), not a header.
      if (typeof body.messageSignature !== 'string' || !body.messageSignature || !key) {
        throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'missing signature');
      }
      const { fawryRefNumber, merchantRefNumber, orderStatus, paymentMethod } = body;
      if (
        typeof fawryRefNumber !== 'string' ||
        typeof merchantRefNumber !== 'string' ||
        typeof orderStatus !== 'string' ||
        typeof paymentMethod !== 'string'
      ) {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'missing notification fields');
      }
      // A malformed amount is a malformed (not a forged) delivery; the signature is checked
      // over the CANONICAL two-place text of the amounts, so a number written another way
      // ("100", 100.0) still verifies and a different value never does.
      const paymentAmountMinor = moneyFromGateway(body.paymentAmount, 'paymentAmount');
      const orderAmountMinor = moneyFromGateway(body.orderAmount, 'orderAmount');
      const expected = fawryNotificationSignature(
        {
          fawryRefNumber,
          merchantRefNumber,
          orderStatus,
          paymentMethod,
          paymentAmountMinor,
          orderAmountMinor,
          paymentRefrenceNumber:
            typeof body.paymentRefrenceNumber === 'string' ? body.paymentRefrenceNumber : undefined,
        },
        key
      );
      if (!safeEqual(expected, body.messageSignature.toLowerCase())) {
        throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'signature mismatch');
      }

      const status = STATUS_MAP[orderStatus.toUpperCase()];
      if (!status) throw new PaymentProviderError('WEBHOOK_MALFORMED', 'unknown order status');
      // Identity only from SIGNED fields (`requestId` is not covered by the signature).
      const eventId = `fawry:${fawryRefNumber}:${orderStatus}:${paymentAmountMinor}:${
        typeof body.paymentRefrenceNumber === 'string' ? body.paymentRefrenceNumber : ''
      }`;

      if (status === 'refunded' || status === 'partially_refunded') {
        return {
          kind: 'refund',
          eventId,
          providerRef: merchantRefNumber,
          // The status alone is NOT unique per refund (every partial notice would share one id and the 2nd+ would be dropped
          // as a redelivery). Append the notice's own signed reference number when Fawry sends one.
          refundRef: `fawry-refund-${fawryRefNumber}-${orderStatus}${
            typeof body.paymentRefrenceNumber === 'string' &&
            /^[A-Za-z0-9_.-]{1,64}$/.test(body.paymentRefrenceNumber)
              ? `~${body.paymentRefrenceNumber}`
              : ''
          }`,
          status: 'completed',
          // UNVERIFIED: the notification does not say how much THIS refund was, and no field
          // that says so is covered by the signature. 0 = "not reported": the payment pipeline
          // holds the balance and alerts a human instead of trusting an unsigned number.
          amountMinor: 0,
          currency: 'EGP',
          rawPayload: body,
        };
      }
      return {
        kind: 'payment',
        eventId,
        providerRef: merchantRefNumber,
        status,
        // The amount actually paid (what the payment pipeline compares to the order total).
        amountMinor: status === 'completed' ? paymentAmountMinor : orderAmountMinor,
        currency: 'EGP',
        method: paymentMethod,
        rawPayload: body,
      };
    },

    async getStatus(providerRef: string, creds: ProviderCredentials): Promise<PaymentStatusV2> {
      const st: Partial<ReturnType<typeof toStatus>> = toStatus(
        await readStatus(creds, providerRef)
      );
      delete st.refundedKnown;
      return st as PaymentStatusV2;
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

export const fawryProvider: PaymentProviderV2 = createFawryProvider();
