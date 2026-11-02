/**
 * Geidea (Egypt) payment adapter, CREATION ONLY (directive PLANS-ALL-1, Ruling PROVIDERS-3).
 *
 * Built ONLY from what Geidea publishes (docs.geidea.net, read 2026-10-26):
 *   - Create Session: `POST {base}/payment-intent/api/v2/direct/session` on the Egypt host
 *     `https://api.merchant.geidea.net` (docs.geidea.net/docs/geidea-checkout-v2), HTTP Basic auth
 *     with `merchantPublicKey:apiPassword`, server to server.
 *   - Body: amount (2 decimals), currency, timestamp, signature, callbackUrl (https), plus the optional
 *     merchantReferenceId, returnUrl, language.
 *   - Request signature: base64( HMAC-SHA256( apiPassword, publicKey + amount(2dp) + currency +
 *     merchantReferenceId + timestamp ) ), no separator (the page's PHP/C# samples).
 *   - Response: `responseCode "000"` = success, `session.id`.
 *
 * NOT documented publicly, so deliberately NOT implemented (never invent a field):
 *   - the server-to-server CALLBACK payload and its signature (separator, HMAC vs appended password):
 *     `verifyWebhook` therefore REFUSES every delivery (fail closed) until a real merchant / Geidea
 *     support confirms the format;
 *   - retrieving an order (`getStatus`), refunds, voids;
 *   - the Egypt hosted-payment-page address (only the KSA shape `.../hpp/checkout/?<sessionId>` is
 *     shown): the redirect needs `GEIDEA_HPP_BASE_URL`; without it `createPayment` fails closed
 *     with PROVIDER_MISCONFIGURED instead of sending the customer to a guessed address;
 *   - a harmless credential check: no `testConnection` (the connection is "unverified", PROVIDERS-3);
 *   - the session timestamp's time zone (the sample shows `Y/m/d H:i:s`): UTC is used.
 * Consequence: a Geidea payment can be CREATED but is never auto-confirmed by Ebda yet.
 */
import crypto from 'node:crypto';
import { minorToDecimalString } from '@ebda/shared';
import {
  IdempotencyCache,
  credentialScope,
  gatewayRequest,
  merchantReference,
  resolveBaseUrl,
  type BaseUrls,
  type FetchLike,
  type GatewayAdapterOptions,
} from './gateway-http';
import { assertChargeable } from './provider-call';
import {
  PaymentProviderError,
  type CreatePaymentV2Request,
  type CreatePaymentV2Result,
  type PaymentProviderV2,
  type PaymentStatusV2,
  type ProviderCapabilities,
  type ProviderCredentials,
  type RefundV2Result,
  type WebhookEventV2,
} from './types';
import { timedFetch } from '../../lib/fetch-with-timeout';

/** Egypt host. Geidea documents no separate sandbox host: test keys on the same host (UNVERIFIED). */
export const GEIDEA_BASE_URLS: BaseUrls = {
  sandbox: 'https://api.merchant.geidea.net',
  live: 'https://api.merchant.geidea.net',
};

export const GEIDEA_SESSION_PATH = '/payment-intent/api/v2/direct/session';
export const GEIDEA_MAX_MINOR = 1_000_000_000_000;

const capabilities: ProviderCapabilities = {
  methods: ['card'],
  instructions: ['redirect'],
  currencies: ['EGP'],
  partialRefunds: false,
  refunds: false,
  webhooks: false,
  remoteStatus: false,
  savedCards: false,
};

/** base64(HMAC-SHA256(apiPassword, publicKey + amount + currency + merchantReferenceId + timestamp)). */
export function geideaSessionSignature(
  publicKey: string,
  amountDecimal: string,
  currency: string,
  merchantReferenceId: string,
  timestamp: string,
  apiPassword: string
): string {
  return crypto
    .createHmac('sha256', apiPassword)
    .update(`${publicKey}${amountDecimal}${currency}${merchantReferenceId}${timestamp}`)
    .digest('base64');
}

/** `Y/m/d H:i:s` (the documented sample format), in UTC (zone undocumented). */
export function geideaTimestamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}/${p(now.getUTCMonth() + 1)}/${p(now.getUTCDate())} ${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())}`;
}

interface GeideaSessionResponse {
  responseCode?: string;
  responseMessage?: string;
  detailedResponseMessage?: string;
  session?: { id?: string; expiryDate?: string };
}

const HPP_ENV = 'GEIDEA_HPP_BASE_URL';

export function createGeideaProvider(options: GatewayAdapterOptions = {}): PaymentProviderV2 {
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((url, init) => timedFetch('geidea', 'payment')(url, init));
  const created = new IdempotencyCache<CreatePaymentV2Result>();
  const scope = (c: ProviderCredentials) => credentialScope([c.merchantId, c.apiKey, c.mode]);
  const base = (c: ProviderCredentials) =>
    resolveBaseUrl('GEIDEA_BASE_URL', GEIDEA_BASE_URLS, c.mode, options.baseUrls);

  /** The hosted-page address: operator-set because Geidea does not publish the Egypt one. */
  const hppBase = (): string => {
    const v = process.env[HPP_ENV]?.trim();
    if (!v || !/^https:\/\//.test(v)) {
      throw new PaymentProviderError(
        'PROVIDER_MISCONFIGURED',
        'Geidea Egypt hosted payment page address is not confirmed yet (set GEIDEA_HPP_BASE_URL)'
      );
    }
    return v.replace(/\/+$/, '');
  };

  return {
    name: 'geidea',
    capabilities,

    async createPayment(
      req: CreatePaymentV2Request,
      creds: ProviderCredentials
    ): Promise<CreatePaymentV2Result> {
      assertChargeable(req);
      if (req.amountMinor > GEIDEA_MAX_MINOR) {
        throw new PaymentProviderError('AMOUNT_INVALID', 'amount is above the supported maximum');
      }
      if (!creds.merchantId || !creds.apiKey) {
        throw new PaymentProviderError(
          'PROVIDER_MISCONFIGURED',
          'Geidea is not set up: add the merchant public key and the API password'
        );
      }
      const publicKey = creds.merchantId;
      const apiPassword = creds.apiKey;
      // The callback must be https (documented). Without a webhook URL there is no callback.
      if (!req.webhookUrl || !req.webhookUrl.startsWith('https://')) {
        throw new PaymentProviderError(
          'PROVIDER_MISCONFIGURED',
          'Geidea needs an https callback URL for the payment'
        );
      }
      const hpp = hppBase(); // fail closed BEFORE a session is created that nobody can pay

      return created.once(scope(creds), req.idempotencyKey, async () => {
        const merchantReferenceId = merchantReference(req.orderNumber, req.idempotencyKey);
        const amount = minorToDecimalString(req.amountMinor);
        const timestamp = geideaTimestamp(new Date());
        const body = {
          amount: Number(amount),
          currency: req.currency,
          timestamp,
          signature: geideaSessionSignature(
            publicKey,
            amount,
            req.currency,
            merchantReferenceId,
            timestamp,
            apiPassword
          ),
          callbackUrl: req.webhookUrl,
          returnUrl: req.returnUrls.success,
          merchantReferenceId,
          language: req.customer.language === 'en' ? 'en' : 'ar',
        };
        const res = await gatewayRequest<GeideaSessionResponse>(
          'geidea.createSession',
          fetchImpl,
          `${base(creds)}${GEIDEA_SESSION_PATH}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Basic ${Buffer.from(`${publicKey}:${apiPassword}`).toString('base64')}`,
            },
            body: JSON.stringify(body),
          },
          options.timeoutMs
        );
        const sessionId = res.session?.id;
        if (res.responseCode !== '000' || !sessionId) {
          throw new PaymentProviderError(
            'PROVIDER_REJECTED',
            `geidea.createSession: responseCode ${res.responseCode ?? 'none'}`
          );
        }
        const expiry = res.session?.expiryDate ? new Date(res.session.expiryDate) : undefined;
        const expiresAt = expiry && !Number.isNaN(expiry.getTime()) ? expiry : undefined;
        return {
          providerRef: merchantReferenceId,
          invoiceId: sessionId,
          instruction: { kind: 'redirect', url: `${hpp}/hpp/checkout/?${sessionId}`, expiresAt },
          status: 'pending',
          amountMinor: req.amountMinor,
          currency: 'EGP',
          metadata: { sessionId },
        } satisfies CreatePaymentV2Result;
      });
    },

    /** Fail closed: Geidea does not publish the callback signature, so no delivery is believed. */
    verifyWebhook(): WebhookEventV2 {
      throw new PaymentProviderError(
        'WEBHOOK_BAD_SIGNATURE',
        'Geidea callbacks are not accepted yet: the callback signature format is unconfirmed'
      );
    },

    async getStatus(): Promise<PaymentStatusV2> {
      throw new PaymentProviderError(
        'STATUS_NOT_SUPPORTED',
        'Geidea order retrieval is not documented, so no remote status is available'
      );
    },

    async refund(): Promise<RefundV2Result> {
      throw new PaymentProviderError(
        'REFUND_NOT_SUPPORTED',
        'Geidea refunds are not enabled: refund from the Geidea dashboard'
      );
    },

    async partialRefund(): Promise<RefundV2Result> {
      throw new PaymentProviderError(
        'REFUND_NOT_SUPPORTED',
        'Geidea refunds are not enabled: refund from the Geidea dashboard'
      );
    },
  };
}

export const geideaProvider: PaymentProviderV2 = createGeideaProvider();
