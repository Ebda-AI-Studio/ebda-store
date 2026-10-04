/**
 * Fawry (FawryPay) adapter: reference code at a Fawry outlet, and card (SP6b).
 *
 *  - `PAYATFAWRY`: the charge returns a reference NUMBER; the customer pays cash at a Fawry
 *    outlet / wallet / ATM quoting it, and Fawry notifies us. Rendered as a
 *    `reference-code` instruction.
 *  - `CARD`: a hosted 3-D Secure redirect. This adapter never takes raw card numbers
 *    (that would put card data on our servers); it only starts the hosted flow.
 *
 * Credentials (per merchant, encrypted at rest):
 *   merchantId  merchant code      apiKey  secure key (signs requests AND notifications)
 *   settings    { methods: ['payatfawry','card'], expiryHours }
 * The merchant reference we send (`merchantRefNum`, `ORD-1042-3fa9c1d2b7`) is the provider
 * reference everywhere; Fawry's own reference NUMBER is kept as the invoice id (it is what
 * refunds and the reference-code instruction use).
 *
 * MONEY: Fawry takes and returns amounts with TWO decimals. Piastres are converted at this
 * edge by integer string math (`minorToDecimalString` / `toMinor`), and the signatures use
 * the same two-place text, so a signature can never disagree with the amount sent.
 *
 * SIGNATURES are plain SHA-256 over concatenated fields with the secure key APPENDED (not
 * an HMAC): charge, status, refund and the notification's `messageSignature` (which is in
 * the BODY, not a header).
 *
 * `UNVERIFIED:` marks every field that could not be confirmed against Fawry's own
 * documentation (developer.fawrystaging.com was unreachable when this was written; the
 * signature formulas come from the research brief and the fawry-node reference library);
 * 6c checks each against the staging environment.
 */
import crypto from 'node:crypto';
import {
  fawrySettingsSchema,
  minorToDecimalString,
  FAWRY_DEFAULT_EXPIRY_HOURS,
} from '@force/shared';
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

export const FAWRY_BASE_URLS: BaseUrls = {
  // Staging host from Fawry's developer portal; live host from Fawry's integration pages.
  sandbox: 'https://atfawry.fawrystaging.com',
  live: 'https://www.atfawry.com',
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

export const fawryChargeSignature = (
  p: {
    merchantCode: string;
    merchantRefNum: string;
    customerProfileId?: string;
    paymentMethod: string;
    amountMinor: number;
    returnUrl?: string;
  },
  secureKey: string
) =>
  // + cardNumber + cardExpiryYear + cardExpiryMonth + cvv, which are empty: no card data here.
  sha256(
    p.merchantCode +
      p.merchantRefNum +
      (p.customerProfileId ?? '') +
      p.paymentMethod +
      minorToDecimalString(p.amountMinor) +
      '' +
      '' +
      '' +
      '' +
      (p.returnUrl ?? '') +
      secureKey
  );

export const fawryStatusSignature = (merchantCode: string, merchantRef: string, key: string) =>
  sha256(merchantCode + merchantRef + key);

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

interface FawryStatusBody {
  statusCode?: number | string;
  statusDescription?: string;
  referenceNumber?: string;
  merchantRefNumber?: string;
  orderStatus?: string;
  orderAmount?: number | string;
  paymentAmount?: number | string;
  refundedAmount?: number | string;
  paymentMethod?: string;
  paymentTime?: number | string;
}

export function createFawryProvider(options: GatewayAdapterOptions = {}): PaymentProviderV2 {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const created = new IdempotencyCache<CreatePaymentV2Result>();
  const refunds = new IdempotencyCache<RefundV2Result>();

  const base = (c: ProviderCredentials) =>
    resolveBaseUrl('FAWRY_BASE_URL', FAWRY_BASE_URLS, c.mode, options.baseUrls);

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

  /** Fawry reports most failures as HTTP 200 with a `statusCode` other than 200. */
  const assertOk = (
    op: string,
    body: { statusCode?: number | string; statusDescription?: string }
  ) => {
    const code = Number(body.statusCode ?? 200);
    if (code === 200) return;
    const text = String(body.statusDescription ?? '');
    if (/not\s*found|invalid\s*(order|reference|merchant\s*ref)|no\s*such/i.test(text)) {
      throw new PaymentProviderError('PAYMENT_NOT_FOUND', `${op}: ${text}`);
    }
    // UNVERIFIED: the statusCode values that mean a bad request vs a gateway fault.
    throw new PaymentProviderError('PROVIDER_REJECTED', `${op}: ${code} ${text}`.trim());
  };

  const readStatus = async (
    c: ProviderCredentials,
    merchantRef: string
  ): Promise<FawryStatusBody> => {
    const k = requireKeys(c);
    const q = new URLSearchParams({
      merchantCode: k.merchantCode,
      merchantRefNumber: merchantRef,
      signature: fawryStatusSignature(k.merchantCode, merchantRef, k.secureKey),
    });
    const res = await gatewayRequest<FawryStatusBody>(
      'fawry.getStatus',
      fetchImpl,
      // UNVERIFIED: GET .../payments/status/v2 with these three query parameters.
      `${base(c)}/ECommerceWeb/Fawry/payments/status/v2?${q.toString()}`,
      { method: 'GET', headers: jsonHeaders },
      options.timeoutMs,
      { notFound: 'PAYMENT_NOT_FOUND' }
    );
    assertOk('fawry.getStatus', res);
    return res;
  };

  const toStatus = (s: FawryStatusBody): PaymentStatusV2 => {
    const amountMinor = moneyFromGateway(s.orderAmount ?? s.paymentAmount, 'orderAmount');
    const mapped = STATUS_MAP[String(s.orderStatus ?? '').toUpperCase()] ?? 'pending';
    const paid = mapped === 'completed' || mapped === 'refunded' || mapped === 'partially_refunded';
    const paidMinor =
      s.paymentAmount !== undefined
        ? moneyFromGateway(s.paymentAmount, 'paymentAmount')
        : amountMinor;
    // UNVERIFIED: `refundedAmount` on the status response; a REFUNDED order with no such field
    // is read as fully refunded.
    const refundedMinor =
      s.refundedAmount !== undefined
        ? moneyFromGateway(s.refundedAmount, 'refundedAmount')
        : mapped === 'refunded'
          ? paidMinor
          : 0;
    return {
      status: mapped,
      amountMinor,
      capturedMinor: paid ? paidMinor : 0,
      refundedMinor: paid ? Math.min(refundedMinor, paidMinor) : 0,
      currency: 'EGP',
      method: s.paymentMethod,
      paidAt: paid && s.paymentTime !== undefined ? new Date(Number(s.paymentTime)) : undefined,
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
    if (st.capturedMinor <= 0 || !status.referenceNumber) {
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
    const why = (reason ?? '').slice(0, 100);
    const res = await gatewayRequest<{ statusCode?: number | string; statusDescription?: string }>(
      'fawry.refund',
      fetchImpl,
      // UNVERIFIED: POST .../payments/refund body fields (merchantCode, referenceNumber,
      // refundAmount, reason, signature); the signature formula is from the research brief.
      `${base(c)}/ECommerceWeb/Fawry/payments/refund`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          merchantCode: k.merchantCode,
          referenceNumber: status.referenceNumber,
          refundAmount: Number(minorToDecimalString(amount)),
          reason: why,
          signature: fawryRefundSignature(
            k.merchantCode,
            status.referenceNumber,
            amount,
            why,
            k.secureKey
          ),
        }),
      },
      options.timeoutMs
    );
    assertOk('fawry.refund', res);
    return {
      // Fawry returns no refund id (UNVERIFIED), so the reference is derived and stable.
      refundRef: `fawry-refund-${status.referenceNumber}-${st.refundedMinor + amount}`,
      status: 'completed',
      amountMinor: amount,
      refundedTotalMinor: st.refundedMinor + amount,
    };
  }

  const scope = (c: ProviderCredentials) => credentialScope([c.merchantId, c.apiKey, c.mode]);

  return {
    name: 'fawry',
    capabilities,

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
      const paymentMethod = method === 'card' ? 'CARD' : 'PAYATFAWRY';

      return created.once(scope(creds), req.idempotencyKey, async () => {
        const merchantRefNum = merchantReference(req.orderNumber, req.idempotencyKey);
        const expiresAt =
          req.expiresAt ??
          new Date(Date.now() + (settings.expiryHours ?? FAWRY_DEFAULT_EXPIRY_HOURS) * 3_600_000);
        const returnUrl = req.returnUrls.success;
        const lines = (req.items ?? []).filter(
          i => Number.isSafeInteger(i.unitPrice) && i.quantity > 0
        );
        const linesTotal = lines.reduce((n, i) => n + i.unitPrice * i.quantity, 0);
        // The items must add up to the amount (shipping, coupons, the wallet part otherwise
        // break that): one line carries the whole amount unless the customer's lines do.
        const chargeItems =
          lines.length > 0 && linesTotal === req.amountMinor
            ? lines.map((i, n) => ({
                itemId: i.sku ?? `item-${n + 1}`,
                description: i.name.slice(0, 100),
                price: Number(minorToDecimalString(i.unitPrice)),
                quantity: i.quantity,
              }))
            : [
                {
                  itemId: req.orderNumber ?? req.orderId,
                  description: `Order ${req.orderNumber ?? req.orderId}`,
                  price: Number(minorToDecimalString(req.amountMinor)),
                  quantity: 1,
                },
              ];
        const res = await gatewayRequest<{
          statusCode?: number | string;
          statusDescription?: string;
          referenceNumber?: string | number;
          merchantRefNumber?: string;
          expirationTime?: number;
          amount?: number | string;
          nextAction?: { redirectUrl?: string };
        }>(
          'fawry.createPayment',
          fetchImpl,
          // UNVERIFIED: POST .../payments/charge body field names and the response shape.
          `${base(creds)}/ECommerceWeb/Fawry/payments/charge`,
          {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({
              merchantCode: k.merchantCode,
              merchantRefNum,
              customerName: req.customer.name,
              customerMobile: req.customer.phone ?? '',
              customerEmail: req.customer.email,
              paymentMethod,
              amount: Number(minorToDecimalString(req.amountMinor)),
              currencyCode: 'EGP',
              description: `Order ${req.orderNumber ?? req.orderId}`,
              paymentExpiry: expiresAt.getTime(),
              chargeItems,
              returnUrl,
              signature: fawryChargeSignature(
                {
                  merchantCode: k.merchantCode,
                  merchantRefNum,
                  paymentMethod,
                  amountMinor: req.amountMinor,
                  returnUrl,
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
          res.amount !== undefined ? moneyFromGateway(res.amount, 'amount') : req.amountMinor;
        const expiry = res.expirationTime ? new Date(res.expirationTime) : expiresAt;
        let instruction: CreatePaymentV2Result['instruction'];
        if (paymentMethod === 'CARD') {
          // UNVERIFIED: the hosted-card redirect is `nextAction.redirectUrl`.
          const url = res.nextAction?.redirectUrl;
          if (!url) {
            throw new PaymentProviderError(
              'PROVIDER_UNAVAILABLE',
              'Fawry answered without a card page URL'
            );
          }
          instruction = { kind: 'redirect', url, expiresAt: expiry };
        } else {
          instruction = { kind: 'reference-code', code: referenceNumber, expiresAt: expiry };
        }
        return {
          providerRef: merchantRefNum,
          invoiceId: referenceNumber,
          instruction,
          status: 'pending',
          amountMinor: recorded,
          currency: 'EGP',
          metadata: { method: paymentMethod },
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
          refundRef: `fawry-refund-${fawryRefNumber}-${orderStatus}`,
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
      return toStatus(await readStatus(creds, providerRef));
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
