/**
 * Paymob (Accept) adapter, Intention API (SP6b).
 *
 * One integration for cards, Meeza, mobile wallets (Vodafone Cash, Orange, e&, WE Pay)
 * and valU (BNPL): each customer-facing method is a Paymob INTEGRATION ID the merchant
 * pastes in settings, and the customer picks among the enabled ones on Paymob's unified
 * checkout page (a redirect). A request may name `metadata.method` to offer just one.
 *
 * Credentials (per merchant, encrypted at rest, see `credentials.ts`):
 *   apiKey        Secret key (`Authorization: Token <secret>` on every server call)
 *   webhookSecret HMAC secret (verifies the transaction callback)
 *   settings      { publicKey, integrationIds: { card, meeza, wallet, valu } } (not secret)
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
 * Every field marked `UNVERIFIED:` below could not be confirmed against Paymob's own
 * documentation (the developer portal was unreachable when this was written; shapes come
 * from the research brief, the official `Paymob-AI-Integration-Skill` repo and
 * third-party integrations) and must be checked in 6c against a real sandbox.
 */
import crypto from 'node:crypto';
import { paymobSettingsBaseSchema, PAYMOB_METHODS, type PaymobMethod } from '@force/shared';
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

export const PAYMOB_BASE_URLS = {
  // UNVERIFIED: Paymob uses one host for both modes and tells them apart by the keys
  // (a test-mode secret key vs a live one); there is no separate sandbox host.
  sandbox: 'https://accept.paymob.com',
  live: 'https://accept.paymob.com',
};

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

export function paymobHmac(obj: Record<string, unknown>, secret: string): string {
  const message = PAYMOB_HMAC_FIELDS.map(f => hmacText(pick(obj, f))).join('');
  return crypto.createHmac('sha512', secret).update(message).digest('hex');
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
  source_data?: { sub_type?: string; type?: string };
  order?: { id?: number | string; amount_cents?: number | string; merchant_order_id?: string };
}

export interface PaymobProvider extends PaymentProviderV2 {
  /** Same-day, full-amount cancellation of a captured payment (Paymob "void"). */
  voidPayment(req: RefundV2Request, creds: ProviderCredentials): Promise<RefundV2Result>;
}

export function createPaymobProvider(options: GatewayAdapterOptions = {}): PaymobProvider {
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

  const headers = (secret: string) => ({
    Authorization: `Token ${secret}`,
    'Content-Type': 'application/json',
  });

  const post = <T>(op: string, creds: ProviderCredentials, path: string, body: unknown) =>
    gatewayRequest<T>(
      op,
      fetchImpl,
      `${base(creds)}${path}`,
      {
        method: 'POST',
        headers: headers(requireSecretKey(creds)),
        body: JSON.stringify(body),
      },
      options.timeoutMs
    );

  /** The payment's transaction as Paymob reports it (by Accept order id). */
  const inquire = (creds: ProviderCredentials, providerRef: string) =>
    post<PaymobTransaction>(
      'paymob.inquiry',
      creds,
      // UNVERIFIED: path, auth scheme and response shape of the order/transaction inquiry.
      // Legacy Accept docs use POST /api/ecommerce/orders/transaction_inquiry with a Bearer
      // auth token from /api/auth/tokens; the Intention-era page was not reachable.
      '/api/ecommerce/orders/transaction_inquiry',
      { order_id: providerRef }
    ).catch(err => {
      if (err instanceof PaymentProviderError && err.code === 'PROVIDER_REJECTED') {
        throw new PaymentProviderError('PAYMENT_NOT_FOUND', `no Paymob order ${providerRef}`);
      }
      throw err;
    });

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
      sameCairoDay(tx.created_at);
    let res: PaymobTransaction | null = null;
    if (canVoid) {
      try {
        // UNVERIFIED: void body/path (`transaction_id` in the body, secret-key Token auth).
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
      res = await post<PaymobTransaction>(
        'paymob.refund',
        creds,
        // UNVERIFIED: refund path, body (`transaction_id`, `amount_cents`) and that the
        // Intention-era secret-key Token is accepted here (legacy used a Bearer auth token).
        '/api/acceptance/void_refund/refund',
        { transaction_id: tx.id, amount_cents: amount }
      );
    }
    if (res.success !== true && res.pending !== true) {
      throw new PaymentProviderError('PROVIDER_REJECTED', 'Paymob did not accept the refund');
    }
    return {
      refundRef: String(res.id ?? `paymob-refund-${tx.id}-${st.refundedMinor + amount}`),
      status: res.pending === true ? 'pending' : 'completed',
      amountMinor: amount,
      refundedTotalMinor: st.refundedMinor + amount,
    };
  }

  const scope = (c: ProviderCredentials) => credentialScope([c.apiKey, c.mode]);

  return {
    name: 'paymob',
    capabilities,

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
        methodIds = Object.values(ids).filter((n): n is number => typeof n === 'number');
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
        const lines = (req.items ?? []).filter(
          i => Number.isSafeInteger(i.unitPrice) && i.quantity > 0
        );
        const linesTotal = lines.reduce((n, i) => n + i.unitPrice * i.quantity, 0);
        const items =
          lines.length > 0 && linesTotal === req.amountMinor
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
          // UNVERIFIED: Paymob requires billing_data and rejects empty values; "NA" is its
          // documented filler for the fields a shop does not collect.
          billing_data: {
            first_name: first || 'NA',
            last_name: rest.join(' ') || 'NA',
            email: req.customer.email || 'NA',
            phone_number: req.customer.phone || 'NA',
            apartment: 'NA',
            floor: 'NA',
            street: 'NA',
            building: 'NA',
            city: 'NA',
            state: 'NA',
            country: 'EG',
            postal_code: 'NA',
          },
          customer: {
            first_name: first || 'NA',
            last_name: rest.join(' ') || 'NA',
            email: req.customer.email || 'NA',
          },
          special_reference: specialReference,
          notification_url: req.webhookUrl,
          redirection_url: req.returnUrls.success,
          extras: { order_id: req.orderId },
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
        const url = `${base(creds)}/unifiedcheckout/?publicKey=${encodeURIComponent(
          settings.publicKey!
        )}&clientSecret=${encodeURIComponent(res.client_secret)}`;
        return {
          providerRef: String(res.intention_order_id),
          invoiceId: specialReference,
          // UNVERIFIED: the unified checkout URL shape (publicKey + clientSecret query).
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
      const flags = [txn.pending, txn.success, txn.is_voided, txn.is_refunded]
        .map(b => (b === true ? 1 : 0))
        .join('');
      const eventId = `paymob:${String(txn.id)}:${flags}`;
      const hasParent =
        (tx as { has_parent_transaction?: unknown }).has_parent_transaction === true;

      // A refund / void is its own transaction with a parent: the payment event is about the
      // PARENT, so these are reported as refund events (the refund id is this transaction's).
      if (hasParent && (txn.is_refunded === true || txn.is_voided === true)) {
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
        if (res.success !== true) {
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
