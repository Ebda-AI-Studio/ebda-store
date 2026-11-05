/**
 * Paymob (Accept) adapter, Intention API (SP6b), aligned with Paymob's official docs
 * (developers.paymob.com, extracted 2026-10-07).
 *
 * One integration for cards (Meeza rides the card integration), mobile wallets, valU (BNPL),
 * kiosk and Apple Pay: each customer-facing method is a Paymob INTEGRATION ID the merchant
 * pastes in settings, and the customer picks among the enabled ones on Paymob's unified
 * checkout page (a redirect to `https://eg.checkout.paymob.com/?publicKey=..&clientSecret=..`).
 * A request may name `metadata.method` to offer just one.
 *
 * Credential slots (fixed by the provider catalog, packages/shared/src/providers/catalog.ts):
 *   creds.apiKey          Paymob SECRET key (`Authorization: Token <secret>` on intention /
 *                         refund / void)
 *   creds.secretKey       Paymob API KEY (only for `POST /api/auth/tokens {api_key}` -> `token`,
 *                         which the transaction inquiry needs as `auth_token`)
 *   creds.webhookSecret   HMAC secret (verifies the transaction callback)
 *   creds.settings        { publicKey, integrationIds: { card, wallet, valu, kiosk, applepay } }
 *                         (not secret)
 *
 * Test and live use the SAME API host (accept.paymob.com); the keys + integration ids decide
 * the mode (docs, overview page).
 *
 * MONEY: Paymob's `amount` / `amount_cents` are integer cents of the currency, i.e.
 * PIASTRES for EGP. No conversion (and so no float) is involved: piastres in, piastres
 * out.
 *
 * WEBHOOK: Paymob signs the "transaction processed" callback with HMAC-SHA512 over the
 * concatenation of 20 fields in a fixed order and sends it in the `hmac` QUERY
 * parameter, not a header. The webhook route copies `?hmac=` into the
 * `x-paymob-hmac` header before calling `verifyWebhook` (the one signature slot the
 * adapter interface has). The HMAC covers the amount, the success / pending / voided /
 * refunded flags and the order id, so a tampered amount or status fails verification.
 *
 * Every detail marked `UNVERIFIED:` below is NOT stated by Paymob's official docs and must be
 * checked in 6c against a real sandbox.
 */
import crypto from 'node:crypto';
import { paymobSettingsBaseSchema, PAYMOB_METHODS, type PaymobMethod } from '@ebda/shared';
import {
  credentialScope,
  gatewayRequest,
  IdempotencyCache,
  integerPiastres,
  merchantReference,
  parseJsonBody,
  resolveBaseUrl,
  safeEqual,
  webhookHeader,
  type FetchLike,
  type GatewayAdapterOptions,
} from './gateway-http';
import { assertChargeable, assertRefundAmount } from './provider-call';
import {
  PaymentProviderError,
  type CreatePaymentV2Request,
  type ConnectionTestResult,
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

/** The header the webhook route copies Paymob's `?hmac=` query parameter into. */
export const PAYMOB_HMAC_HEADER = 'x-paymob-hmac';

/** Docs (create-intention `expiration`): maximum and default, 36 days. */
export const PAYMOB_MAX_EXPIRATION_SECONDS = 3_110_400;

export const PAYMOB_BASE_URLS = {
  // Docs: "Test and live use the same regional base URL ... The mode is controlled by the keys
  // and integration IDs you use." (Egypt: accept.paymob.com)
  sandbox: 'https://accept.paymob.com',
  live: 'https://accept.paymob.com',
};

/** Unified checkout host (docs: unified-checkout-redirection, Egypt). Same host for both modes. */
export const PAYMOB_CHECKOUT_URLS = {
  sandbox: 'https://eg.checkout.paymob.com',
  live: 'https://eg.checkout.paymob.com',
};

export interface PaymobAdapterOptions extends GatewayAdapterOptions {
  /** Clock for the callback freshness window (tests). Defaults to Date.now. */
  now?: () => number;
  /** Explicit checkout host (tests); beats `PAYMOB_CHECKOUT_URL` (non-production only) and the default. */
  checkoutBaseUrls?: Partial<Record<'sandbox' | 'live', string>>;
}

/**
 * The 20 callback fields the HMAC covers, in Paymob's documented (lexicographic) order.
 * Source: developers.paymob.com HMAC "transaction callback" page, via the research brief.
 */
export const PAYMOB_HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
] as const;

function pick(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => {
    return o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;
  }, obj);
}

/** Paymob concatenates booleans as `true` / `false` and a missing value as the empty string. */
function hmacText(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
}

/** Signed callback booleans: when present they must be real JSON booleans (type-confusion guard). */
const PAYMOB_SIGNED_BOOLEANS = [
  'error_occured',
  'has_parent_transaction',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'pending',
  'success',
] as const;

/**
 * Accept a callback whose signed `created_at` (the transaction's CREATION time) is at most this
 * old: the longest checkout expiry we ever request (36 d, so a late kiosk/Aman payment still
 * lands) plus 2 d slack.
 */
export const PAYMOB_CALLBACK_MAX_AGE_MS =
  PAYMOB_MAX_EXPIRATION_SECONDS * 1000 + 2 * 24 * 60 * 60 * 1000;
/** ...and at most this far ahead (covers the zone-less timestamp's offset plus clock skew). */
export const PAYMOB_CALLBACK_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * The first non-boolean among the signed boolean fields, or null. `hmacText` stringifies, so
 * "true" / 1 would pass the HMAC yet fail a `=== true` classifier; such a callback is refused.
 */
export function paymobNonBooleanField(obj: Record<string, unknown>): string | null {
  for (const f of PAYMOB_SIGNED_BOOLEANS) {
    const v = obj[f];
    if (v !== undefined && v !== null && typeof v !== 'boolean') return f;
  }
  return null;
}

/**
 * Canonical idempotency key shared by the adapter event id and the route dedupe: txn id plus the
 * SIGNED state, read exactly as `hmacText` does. Keeps the legacy `<id>_<4 flags>` shape when the
 * callback has no parent (so already-stored keys still match) and adds `p` for a child transaction.
 */
export function paymobCanonicalState(obj: Record<string, unknown>): {
  flags: string;
  parent: boolean;
} {
  const t = (v: unknown) => (hmacText(v) === 'true' ? 1 : 0);
  return {
    flags: [obj.pending, obj.success, obj.is_voided, obj.is_refunded].map(t).join(''),
    parent: hmacText(obj.has_parent_transaction) === 'true',
  };
}

/**
 * The string Paymob's HMAC is computed over: the 20 documented values of the callback `obj`
 * concatenated with no separator (booleans lowercase, a missing value empty).
 */
export function paymobHmacMessage(obj: Record<string, unknown>): string {
  return PAYMOB_HMAC_FIELDS.map(f => hmacText(pick(obj, f))).join('');
}

export function paymobHmac(obj: Record<string, unknown>, secret: string): string {
  return crypto.createHmac('sha512', secret).update(paymobHmacMessage(obj)).digest('hex');
}

const capabilities: ProviderCapabilities = {
  methods: PAYMOB_METHODS,
  instructions: ['redirect'],
  currencies: ['EGP'],
  partialRefunds: true,
  refunds: true,
  webhooks: true,
  remoteStatus: true,
  savedCards: false,
};

interface PaymobTransaction {
  id?: number | string | null;
  success?: boolean;
  pending?: boolean;
  amount_cents?: number | string;
  refunded_amount_cents?: number | string;
  is_voided?: boolean;
  is_refunded?: boolean;
  is_auth?: boolean;
  is_capture?: boolean;
  created_at?: string;
  currency?: string;
  parent_transaction?: number | string | null;
  has_parent_transaction?: boolean;
  is_refund?: boolean;
  is_void?: boolean;
  source_data?: { sub_type?: string; type?: string };
  order?: { id?: number | string; amount_cents?: number | string; merchant_order_id?: string };
}

export interface PaymobProvider extends PaymentProviderV2 {
  /** Same-day, full-amount cancellation of a captured payment (Paymob "void"). */
  voidPayment(req: RefundV2Request, creds: ProviderCredentials): Promise<RefundV2Result>;
}

/** Docs show some booleans as the strings "true"/"" (flattened examples); accept both. */
const isTrue = (v: unknown): boolean => v === true || v === 'true';

/**
 * UNVERIFIED: which `source_data.type` strings mean "kiosk" (docs say only that Kiosk payments
 * cannot be refunded). Matches `kiosk` and the `aggregator` type third-party code reports.
 */
const KIOSK_SOURCE = /kiosk|aggregator/i;

export function createPaymobProvider(options: PaymobAdapterOptions = {}): PaymobProvider {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const created = new IdempotencyCache<CreatePaymentV2Result>();
  const refunds = new IdempotencyCache<RefundV2Result>();

  const base = (creds: ProviderCredentials) =>
    resolveBaseUrl('PAYMOB_BASE_URL', PAYMOB_BASE_URLS, creds.mode, options.baseUrls);

  const requireSecretKey = (creds: ProviderCredentials): string => {
    if (!creds.apiKey) {
      throw new PaymentProviderError(
        'PROVIDER_MISCONFIGURED',
        'Paymob is not set up: add the Secret key'
      );
    }
    return creds.apiKey;
  };

  const settingsOf = (creds: ProviderCredentials) => {
    const parsed = paymobSettingsBaseSchema.safeParse(creds.settings ?? {});
    if (!parsed.success) {
      throw new PaymentProviderError('PROVIDER_MISCONFIGURED', 'Paymob settings are invalid');
    }
    return parsed.data;
  };

  const checkoutBase = (creds: ProviderCredentials) =>
    resolveBaseUrl(
      'PAYMOB_CHECKOUT_URL',
      PAYMOB_CHECKOUT_URLS,
      creds.mode,
      options.checkoutBaseUrls
    );

  /** POST with the Secret key (`Authorization: Token <secret>`): intention, refund, void. */
  const post = <T>(op: string, creds: ProviderCredentials, path: string, body: unknown) =>
    gatewayRequest<T>(
      op,
      fetchImpl,
      `${base(creds)}${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${requireSecretKey(creds)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      options.timeoutMs
    );

  /** POST /api/auth/tokens {api_key}: no Authorization header (docs). */
  const authTokens = <T>(op: string, creds: ProviderCredentials, apiKey: string) =>
    gatewayRequest<T>(
      op,
      fetchImpl,
      `${base(creds)}/api/auth/tokens`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey }),
      },
      options.timeoutMs
    );

  /** A short-lived auth token from the Paymob API key; used for ONE call, never cached. */
  const authToken = async (creds: ProviderCredentials): Promise<string> => {
    if (!creds.secretKey) {
      throw new PaymentProviderError(
        'PROVIDER_MISCONFIGURED',
        'Paymob is not set up: add the API key'
      );
    }
    const res = await authTokens<{ token?: string }>('paymob.authToken', creds, creds.secretKey);
    if (!res.token) {
      throw new PaymentProviderError(
        'PROVIDER_UNAVAILABLE',
        'Paymob answered without an auth token'
      );
    }
    return res.token;
  };

  /**
   * The LAST transaction of an Accept order (docs: transaction inquiry by order id): auth token
   * first, then POST /api/ecommerce/orders/transaction_inquiry (Bearer token + order_id; see
   * the note on the request below).
   */
  const inquire = async (creds: ProviderCredentials, providerRef: string) => {
    const token = await authToken(creds);
    return gatewayRequest<PaymobTransaction>(
      'paymob.inquiry',
      fetchImpl,
      `${base(creds)}/api/ecommerce/orders/transaction_inquiry`,
      {
        method: 'POST',
        // 2026-10-24: Paymob's Postman collection (Transaction Inquiry API) sends the token as
        // `Authorization: Bearer <token>` with body {order_id}; the 2026-10-07 docs extract had
        // `auth_token` in the body. Both are sent until a live account settles which is current.
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ auth_token: token, order_id: providerRef }),
      },
      options.timeoutMs
    ).catch(err => {
      // UNVERIFIED: how Paymob answers an unknown order id (a 4xx is read as "not found").
      if (err instanceof PaymentProviderError && err.code === 'PROVIDER_REJECTED') {
        throw new PaymentProviderError('PAYMENT_NOT_FOUND', `no Paymob order ${providerRef}`);
      }
      throw err;
    });
  };

  function toStatus(tx: PaymobTransaction): PaymentStatusV2 {
    const amountMinor = integerPiastres(tx.amount_cents ?? tx.order?.amount_cents, 'amount_cents');
    const paid = tx.success === true && tx.pending !== true;
    const voided = tx.is_voided === true;
    const refundedMinor = voided
      ? amountMinor
      : tx.refunded_amount_cents !== undefined
        ? integerPiastres(tx.refunded_amount_cents, 'refunded_amount_cents')
        : 0;
    let status: PaymentStatus;
    if (!paid) status = tx.pending === false && tx.id ? 'failed' : 'pending';
    else if (refundedMinor >= amountMinor && amountMinor > 0) status = 'refunded';
    else if (refundedMinor > 0) status = 'partially_refunded';
    else status = tx.is_auth && !tx.is_capture ? 'processing' : 'completed';
    return {
      status,
      amountMinor,
      capturedMinor: paid ? amountMinor : 0,
      refundedMinor: paid ? Math.min(refundedMinor, amountMinor) : 0,
      currency: 'EGP',
      method: tx.source_data?.sub_type ?? tx.source_data?.type,
      raw: undefined,
    };
  }

  /** Same-day (Cairo) full-amount payments can be voided; anything else is refunded. */
  const sameCairoDay = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return false;
    const day = (ms: number) => new Date(ms + 2 * 3_600_000).toISOString().slice(0, 10);
    // UNVERIFIED: Paymob's void cut-off is "before the daily settlement"; UTC+2 midnight is a
    // conservative stand-in (a void the gateway refuses falls back to a refund below).
    return day(t) === day(Date.now());
  };

  async function doRefund(
    creds: ProviderCredentials,
    providerRef: string,
    wantMinor: number | null,
    opts: { allowVoid: boolean; reason?: string }
  ): Promise<RefundV2Result> {
    const tx = await inquire(creds, providerRef);
    const st = toStatus(tx);
    if (st.capturedMinor <= 0 || tx.id === null || tx.id === undefined) {
      throw new PaymentProviderError('PAYMENT_NOT_CAPTURED', 'cannot refund an uncaptured payment');
    }
    if (KIOSK_SOURCE.test(tx.source_data?.type ?? '')) {
      throw new PaymentProviderError(
        'REFUND_NOT_SUPPORTED',
        'Paymob kiosk payments cannot be refunded'
      );
    }
    const remaining = st.capturedMinor - st.refundedMinor;
    const amount = wantMinor ?? remaining;
    if (amount <= 0 || amount > remaining) {
      throw new PaymentProviderError(
        'REFUND_EXCEEDS_CAPTURED',
        `refund ${amount} exceeds the ${remaining} piastres still refundable`
      );
    }
    const canVoid =
      opts.allowVoid &&
      st.refundedMinor === 0 &&
      amount === st.capturedMinor &&
      // Docs: void is for Card payments only.
      tx.source_data?.type === 'card' &&
      sameCairoDay(tx.created_at);
    let res: PaymobTransaction | null = null;
    if (canVoid) {
      try {
        // Docs: POST api/acceptance/void_refund/void {transaction_id}, secret-key Token auth.
        res = await post<PaymobTransaction>(
          'paymob.void',
          creds,
          '/api/acceptance/void_refund/void',
          { transaction_id: tx.id }
        );
      } catch (err) {
        // The gateway said no to the void (e.g. already settled): refund instead. An outage
        // is NOT swallowed.
        if (!(err instanceof PaymentProviderError) || err.code !== 'PROVIDER_REJECTED') throw err;
      }
    }
    if (!res) {
      try {
        // Docs: POST api/acceptance/void_refund/refund {transaction_id, amount_cents}, secret-key
        // Token auth; the answer is a NEW transaction (is_refund, parent_transaction).
        res = await post<PaymobTransaction>(
          'paymob.refund',
          creds,
          '/api/acceptance/void_refund/refund',
          { transaction_id: tx.id, amount_cents: amount }
        );
      } catch (err) {
        // Docs: 400 "Requested Refund Amount is greater than the maximum refund amount permissible".
        if (
          err instanceof PaymentProviderError &&
          err.code === 'PROVIDER_REJECTED' &&
          /greater than/i.test(err.message)
        ) {
          throw new PaymentProviderError(
            'REFUND_EXCEEDS_CAPTURED',
            'Paymob says the refund exceeds the refundable amount'
          );
        }
        throw err;
      }
    }
    if (!isTrue(res.success) && !isTrue(res.pending)) {
      throw new PaymentProviderError('PROVIDER_REJECTED', 'Paymob did not accept the refund');
    }
    return {
      refundRef: String(res.id ?? `paymob-refund-${tx.id}-${st.refundedMinor + amount}`),
      status: isTrue(res.pending) ? 'pending' : 'completed',
      amountMinor: amount,
      refundedTotalMinor: st.refundedMinor + amount,
    };
  }

  const scope = (c: ProviderCredentials) => credentialScope([c.apiKey, c.mode]);

  return {
    name: 'paymob',
    capabilities,

    /**
     * One call: POST /api/auth/tokens with the API key (creates nothing at Paymob). Prefix
     * checks first (docs: `sk_test_` / `pk_test_` in test, `sk_live_` / `pk_live_` in live).
     * NOTE: this proves the API KEY only; the Secret key (`Token` auth) has no documented
     * side-effect-free call, so a wrong Secret key surfaces on the first real payment.
     * UNVERIFIED: that a wrong api_key answers 400/401/403 (all read as bad_credentials).
     */
    async testConnection(creds: ProviderCredentials): Promise<ConnectionTestResult> {
      const settings = paymobSettingsBaseSchema.safeParse(creds.settings ?? {});
      const hasIntegration =
        settings.success && Object.values(settings.data.integrationIds).some(n => n !== undefined);
      const missing = [
        !creds.apiKey && 'Secret key',
        !creds.secretKey && 'API key',
        !creds.webhookSecret && 'HMAC secret',
        !(settings.success && settings.data.publicKey) && 'Public key',
        !hasIntegration && 'at least one integration ID',
      ].filter(Boolean);
      if (missing.length > 0) {
        return {
          ok: false,
          code: 'incomplete',
          message: `Missing or invalid: ${missing.join(', ')}`,
        };
      }
      const want = creds.mode === 'live' ? 'live' : 'test';
      if (
        !creds.apiKey!.startsWith(`sk_${want}_`) ||
        !(settings.success && settings.data.publicKey!.startsWith(`pk_${want}_`))
      ) {
        return {
          ok: false,
          code: 'wrong_mode',
          message: `The Secret key and Public key must start with sk_${want}_ and pk_${want}_ in ${creds.mode} mode`,
        };
      }
      try {
        const res = await authTokens<{ token?: string; profile?: { id?: number | string } }>(
          'paymob.testConnection',
          creds,
          creds.secretKey!
        );
        if (!res.token) {
          return { ok: false, code: 'unknown', message: 'Paymob answered without an auth token' };
        }
        const id = res.profile && typeof res.profile === 'object' ? res.profile.id : undefined;
        return {
          ok: true,
          code: 'ok',
          message: 'Paymob accepted the API key',
          ...(typeof id === 'number' || typeof id === 'string'
            ? { details: { profileId: id } }
            : {}),
        };
      } catch (err) {
        if (err instanceof PaymentProviderError) {
          if (err.code === 'PROVIDER_MISCONFIGURED' || err.code === 'PROVIDER_REJECTED') {
            return { ok: false, code: 'bad_credentials', message: 'Paymob refused the API key' };
          }
          if (err.isOutage) {
            return { ok: false, code: 'unreachable', message: 'Paymob could not be reached' };
          }
        }
        return { ok: false, code: 'unknown', message: 'Unexpected answer from Paymob' };
      }
    },

    async createPayment(
      req: CreatePaymentV2Request,
      creds: ProviderCredentials
    ): Promise<CreatePaymentV2Result> {
      assertChargeable(req);
      const secret = requireSecretKey(creds);
      const settings = settingsOf(creds);
      void secret;

      const wanted = req.metadata?.method as PaymobMethod | undefined;
      const ids = settings.integrationIds;
      let methodIds: number[];
      if (wanted) {
        const one = (PAYMOB_METHODS as readonly string[]).includes(wanted)
          ? ids[wanted]
          : undefined;
        if (!one) {
          throw new PaymentProviderError(
            'PROVIDER_MISCONFIGURED',
            `Paymob method "${wanted}" is not enabled for this merchant`
          );
        }
        methodIds = [one];
      } else {
        // Ruling SHARIA-GOLD-1: a prepaid-only (gold) order leaves the installment integrations out.
        const skip = req.metadata?.excludeBnpl === 'true' ? ['valu', 'kiosk'] : [];
        methodIds = Object.entries(ids)
          .filter(([m, n]) => typeof n === 'number' && !skip.includes(m))
          .map(([, n]) => n as number);
      }
      if (!settings.publicKey || methodIds.length === 0) {
        throw new PaymentProviderError(
          'PROVIDER_MISCONFIGURED',
          'Paymob is not set up: add the public key and at least one integration id'
        );
      }

      return created.once(scope(creds), req.idempotencyKey, async () => {
        const specialReference = merchantReference(req.orderNumber, req.idempotencyKey);
        // Paymob checks that the items add up to the amount, so the customer's lines are
        // sent only when they do; otherwise (shipping, a coupon, the COD-free fee, the wallet
        // part) one line carries the whole amount.
        // Docs: "Sum of all items[].amount must exactly equal the total amount". Whether `amount`
        // is per unit or per line is not stated (the docs' own example has a quantity-2 line), so
        // only quantity-1 lines are sent as they are: they are valid under both readings.
        const lines = (req.items ?? []).filter(
          i => Number.isSafeInteger(i.unitPrice) && i.quantity === 1
        );
        const linesTotal = lines.reduce((n, i) => n + i.unitPrice * i.quantity, 0);
        const items =
          lines.length > 0 &&
          lines.length === (req.items ?? []).length &&
          linesTotal === req.amountMinor
            ? lines.map(i => ({
                name: i.name.slice(0, 50),
                amount: i.unitPrice,
                description: (i.description ?? i.name).slice(0, 255),
                quantity: i.quantity,
              }))
            : [
                {
                  name: `Order ${req.orderNumber ?? req.orderId}`.slice(0, 50),
                  amount: req.amountMinor,
                  description: `Order ${req.orderNumber ?? req.orderId}`,
                  quantity: 1,
                },
              ];
        const [first = '', ...rest] = req.customer.name.trim().split(/\s+/);
        const body = {
          amount: req.amountMinor,
          currency: 'EGP',
          payment_methods: methodIds,
          items,
          // Docs require first_name, last_name, email, phone_number (a missing phone_number is a
          // 400). UNVERIFIED: that "NA" is accepted as a filler for values the shop did not
          // collect (it is what Paymob itself stores for them in its order records).
          billing_data: {
            // Docs: first_name / last_name are at most 50 characters.
            first_name: (first || 'NA').slice(0, 50),
            last_name: (rest.join(' ') || 'NA').slice(0, 50),
            email: req.customer.email || 'NA',
            phone_number: req.customer.phone || 'NA',
            apartment: 'NA',
            floor: 'NA',
            street: 'NA',
            building: 'NA',
            city: 'NA',
            state: 'NA',
            country: 'EGY', // docs example: 3-letter code
          },
          special_reference: specialReference,
          // Docs (create-intention): notification_url overrides the Transaction Processed Callback
          // URL and is supported with ALL payment methods.
          notification_url: req.webhookUrl,
          redirection_url: req.returnUrls.success,
          extras: { order_id: req.orderId },
          // Docs: `expiration` is in seconds.
          // Docs: maximum (and default) 3110400 seconds.
          ...(req.expiresAt
            ? {
                expiration: Math.min(
                  PAYMOB_MAX_EXPIRATION_SECONDS,
                  Math.max(1, Math.ceil((req.expiresAt.getTime() - Date.now()) / 1000))
                ),
              }
            : {}),
        };
        const res = await post<{
          id?: string;
          client_secret?: string;
          intention_order_id?: number | string;
          intention_detail?: { amount?: number };
        }>('paymob.createPayment', creds, '/v1/intention/', body);
        if (!res.client_secret || res.intention_order_id === undefined) {
          throw new PaymentProviderError(
            'PROVIDER_UNAVAILABLE',
            'Paymob answered without an order id or client secret'
          );
        }
        const recorded =
          typeof res.intention_detail?.amount === 'number'
            ? res.intention_detail.amount
            : req.amountMinor;
        const url = `${checkoutBase(creds)}/?publicKey=${encodeURIComponent(
          settings.publicKey!
        )}&clientSecret=${encodeURIComponent(res.client_secret)}`;
        return {
          providerRef: String(res.intention_order_id),
          invoiceId: specialReference,
          // Docs: unified checkout redirection (publicKey + clientSecret query).
          instruction: { kind: 'redirect', url },
          status: 'pending',
          amountMinor: recorded,
          currency: 'EGP',
          metadata: { specialReference, methods: methodIds.length },
        } satisfies CreatePaymentV2Result;
      });
    },

    verifyWebhook(
      rawBody: string | Buffer,
      hdrs: WebhookHeaders,
      creds: ProviderCredentials
    ): WebhookEventV2 {
      const given = webhookHeader(hdrs, PAYMOB_HMAC_HEADER);
      if (!given || !creds.webhookSecret) {
        throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'missing signature');
      }
      const body = parseJsonBody(rawBody);
      const obj = body.obj;
      if (body.type !== 'TRANSACTION' || !obj || typeof obj !== 'object') {
        // Verify FIRST for everything that looks like a callback, so an unsigned body of
        // another type is still a signature failure, not a hint about our parser.
        const probe = (obj ?? {}) as Record<string, unknown>;
        if (!safeEqual(paymobHmac(probe, creds.webhookSecret), given.toLowerCase())) {
          throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'signature mismatch');
        }
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'not a transaction callback');
      }
      const tx = obj as Record<string, unknown>;
      const badField = paymobNonBooleanField(tx);
      if (badField) {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', `${badField} is not a boolean`);
      }
      if (!safeEqual(paymobHmac(tx, creds.webhookSecret), given.toLowerCase())) {
        throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'signature mismatch');
      }

      const txn = tx as unknown as PaymobTransaction & Record<string, unknown>;
      const order = txn.order;
      if (txn.id === undefined || txn.id === null || !order || order.id === undefined) {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'missing transaction or order id');
      }
      if (txn.currency !== 'EGP') {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'unsupported currency');
      }
      const amountMinor = integerPiastres(txn.amount_cents, 'amount_cents');
      const providerRef = String(order.id);
      // Freshness: the signed created_at bounds how long a captured delivery stays replayable.
      const createdMs = Date.parse(
        typeof txn.created_at === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(txn.created_at)
          ? `${txn.created_at}Z`
          : String(txn.created_at)
      );
      const nowMs = (options.now ?? Date.now)();
      if (
        !Number.isFinite(createdMs) ||
        nowMs - createdMs > PAYMOB_CALLBACK_MAX_AGE_MS ||
        createdMs - nowMs > PAYMOB_CALLBACK_MAX_FUTURE_MS
      ) {
        throw new PaymentProviderError(
          'WEBHOOK_MALFORMED',
          'callback created_at is outside the accepted window'
        );
      }
      const state = paymobCanonicalState(tx);
      const hasParent = state.parent;
      // Identity = txn id + canonical SIGNED state; never an unsigned or attacker-chosen label.
      const eventId = `paymob:${String(txn.id)}:${state.flags}${hasParent ? ':p' : ''}`;

      // A refund / void is its own transaction with a parent: the payment event is about the
      // PARENT, so these are reported as refund events (the refund id is this transaction's).
      // SECURITY: classification uses ONLY HMAC-signed fields (has_parent_transaction,
      // is_capture). `is_refund` / `is_void` are NOT in the HMAC list, so an attacker could flip
      // them on a captured signed payload; they are deliberately ignored. A capture of an auth
      // also has a parent, so it is excluded via the signed is_capture.
      const refundLike = hasParent && txn.is_capture !== true;
      if (refundLike) {
        const status: 'pending' | 'completed' | 'failed' =
          txn.pending === true ? 'pending' : txn.success === true ? 'completed' : 'failed';
        return {
          kind: 'refund',
          eventId,
          providerRef,
          refundRef: String(txn.id),
          status,
          amountMinor,
          currency: 'EGP',
          rawPayload: body,
        };
      }

      let status: PaymentStatus;
      if (txn.pending === true) status = 'pending';
      else if (txn.success === true && tx.error_occured !== true) {
        status = txn.is_auth === true && txn.is_capture !== true ? 'processing' : 'completed';
      } else status = 'failed';
      return {
        kind: 'payment',
        eventId,
        providerRef,
        status,
        amountMinor,
        currency: 'EGP',
        method: txn.source_data?.sub_type ?? txn.source_data?.type,
        paidAt: status === 'completed' && txn.created_at ? new Date(txn.created_at) : undefined,
        rawPayload: body,
      };
    },

    async getStatus(providerRef: string, creds: ProviderCredentials): Promise<PaymentStatusV2> {
      return toStatus(await inquire(creds, providerRef));
    },

    async refund(req: RefundV2Request, creds: ProviderCredentials): Promise<RefundV2Result> {
      return refunds.once(scope(creds), req.idempotencyKey, () =>
        doRefund(creds, req.providerRef, null, { allowVoid: true, reason: req.reason })
      );
    },

    async partialRefund(
      req: PartialRefundV2Request,
      creds: ProviderCredentials
    ): Promise<RefundV2Result> {
      assertRefundAmount(req.amountMinor);
      return refunds.once(scope(creds), req.idempotencyKey, () =>
        // A partial amount is never voided; a "partial" equal to the whole payment may be.
        doRefund(creds, req.providerRef, req.amountMinor, { allowVoid: true, reason: req.reason })
      );
    },

    async voidPayment(req: RefundV2Request, creds: ProviderCredentials): Promise<RefundV2Result> {
      return refunds.once(scope(creds), req.idempotencyKey, async () => {
        const tx = await inquire(creds, req.providerRef);
        const st = toStatus(tx);
        if (st.capturedMinor <= 0 || tx.id === null || tx.id === undefined) {
          throw new PaymentProviderError(
            'PAYMENT_NOT_CAPTURED',
            'cannot void an uncaptured payment'
          );
        }
        if (tx.source_data?.type !== 'card') {
          throw new PaymentProviderError(
            'REFUND_NOT_SUPPORTED',
            'Paymob voids are for card payments only'
          );
        }
        if (st.refundedMinor > 0 || !sameCairoDay(tx.created_at)) {
          throw new PaymentProviderError(
            'REFUND_NOT_SUPPORTED',
            'only a same-day payment with nothing refunded can be voided'
          );
        }
        const res = await post<PaymobTransaction>(
          'paymob.void',
          creds,
          '/api/acceptance/void_refund/void',
          { transaction_id: tx.id }
        );
        if (!isTrue(res.success)) {
          throw new PaymentProviderError('PROVIDER_REJECTED', 'Paymob did not accept the void');
        }
        return {
          refundRef: String(res.id ?? `paymob-void-${tx.id}`),
          status: 'completed',
          amountMinor: st.capturedMinor,
          refundedTotalMinor: st.capturedMinor,
        };
      });
    },
  };
}

/** The adapter the app registers (global `fetch`, env base URL). */
export const paymobProvider: PaymobProvider = createPaymobProvider();
