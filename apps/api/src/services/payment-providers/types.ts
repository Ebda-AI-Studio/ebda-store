// ==========================================
// Payment Provider Types
// Common interfaces for all payment gateways
// ==========================================

/**
 * A payment provider CODE from the catalog (`PROVIDER_CATALOG` in @ebda/shared, kind
 * 'payments'). It used to be a closed union mirrored by a Postgres enum; since 2026-10-07
 * (ruling PROVIDERS-1) the column is TEXT and the catalog is the list, so adding a gateway is a
 * catalog entry + an adapter, never a type edit or a migration.
 */
export type PaymentProvider = string;

/** Customer-facing methods of the Egyptian gateways (a gateway adapter's `capabilities.methods`). */
export type PaymentMethod =
  | 'card'
  | 'meeza'
  | 'wallet'
  | 'valu'
  | 'payatfawry'
  | 'instapay'
  | 'cod';

export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'cancelled'
  | 'expired'
  | 'cod_pending';

export type Currency = 'EGP' | 'USD' | 'EUR' | 'GBP' | 'AED' | 'SAR' | 'BHD' | 'OMR' | 'QAR';

export interface CustomerInfo {
  id?: string;
  name: string;
  email: string;
  phone?: string;
  language?: 'en' | 'ar';
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  country: string;
  postalCode?: string;
}

export interface PaymentItem {
  name: string;
  description?: string;
  quantity: number;
  unitPrice: number; // In piastres (minor units: 1 EGP = 100 piastres)
  sku?: string;
}

export interface CreatePaymentRequest {
  orderId: string;
  orderNumber: string;
  amount: number; // In piastres (minor units: 1 EGP = 100 piastres)
  currency: Currency;
  customer: CustomerInfo;
  items?: PaymentItem[];
  shippingAddress?: Address;
  billingAddress?: Address;
  callbackUrl: string;
  errorUrl: string;
  webhookUrl?: string;
  metadata?: Record<string, string>;
  /**
   * Optional channels the provider should use to notify the customer
   * about the generated payment URL. Defaults to 'link' (just return
   * the URL, no provider-side send). None of the Egyptian gateways sends the
   * customer anything for us, so 'link' is the only channel that is honoured.
   *
   *   - 'link': return URL only, merchant copies/shares manually
   */
  notifyVia?: 'link' | 'email' | 'all';
}

export interface PaymentResponse {
  success: boolean;
  provider: PaymentProvider;
  transactionId: string;
  invoiceId?: string;
  /** Redirect target; '' for a payment the customer completes another way (a Fawry reference code). */
  paymentUrl: string;
  /** What the customer must do next, when it is more than "follow the link" (SP6b). */
  instruction?: PaymentInstruction;
  paymentMethods?: AvailablePaymentMethod[];
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface AvailablePaymentMethod {
  id: string | number;
  code: PaymentMethod | string;
  name: string;
  nameAr?: string;
  logo?: string;
  fee?: number;
  isDirectPayment?: boolean;
}

export interface PaymentStatusResponse {
  success: boolean;
  provider: PaymentProvider;
  transactionId: string;
  invoiceId?: string;
  status: PaymentStatus;
  amount: number;
  currency: Currency;
  paidAmount?: number;
  paidCurrency?: Currency;
  paymentMethod?: string;
  paidAt?: Date;
  failureReason?: string;
  refundedAmount?: number;
  metadata?: Record<string, unknown>;
}

export interface RefundRequest {
  transactionId: string;
  amount?: number; // Partial refund amount in piastres
  reason?: string;
  /**
   * PaymentService.refund only — never sent to a provider. A stable key for
   * the business event this refund settles (ReturnService passes
   * `return:<id>`). A second refund under a key whose earlier refund may have
   * gone out is refused, so a retry after a failed request cannot pay twice.
   */
  refundKey?: string;
  /**
   * PaymentService.refund only — never sent to a provider. The client's request attempt (derived from its
   * Idempotency-Key, #628): a second claim under the same attempt while an earlier one is still open (sent, or
   * indeterminate) is refused REFUND_ALREADY_ISSUED. Unlike `refundKey` it does NOT change how the refund is booked.
   */
  attemptKey?: string;
  /**
   * PaymentService.refund only. The caller applies ITEM-LEVEL effects itself
   * (a partial return), so even a refund that uses up the payment must not
   * flip the order to refunded or run the whole-order reversals: lines the
   * customer kept stay sold.
   */
  itemLevel?: boolean;
}

export interface RefundResponse {
  success: boolean;
  provider: PaymentProvider;
  refundId: string;
  transactionId: string;
  amount: number;
  status: 'pending' | 'completed' | 'failed';
  metadata?: Record<string, unknown>;
  /**
   * Set by PaymentService.refund, not by providers: whether THIS call flipped
   * the order to refunded and dispatched the whole-order effects. Callers read
   * it instead of re-deriving the decision from their own, older read of the
   * payment (#1473).
   */
  wholeOrderEffectsApplied?: boolean;
}

export interface RefundStatusResponse {
  success: boolean;
  provider: PaymentProvider;
  refundId: string;
  /** Normalized status across providers: executed => completed, queued => pending, refused => failed. */
  status: 'pending' | 'completed' | 'failed';
  amount?: number;
  refundedAmount?: number;
  refundReference?: string;
  /** Original provider response for debugging / portal cross-reference. */
  raw?: Record<string, unknown>;
}

export interface WebhookPayload {
  provider: PaymentProvider;
  event: string;
  transactionId: string;
  invoiceId?: string;
  status: PaymentStatus;
  amount: number;
  currency: Currency;
  paymentMethod?: string;
  paidAt?: Date;
  /** Set when the webhook event is a refund status change rather than
   *  a payment status change. handleWebhook routes refund events to a
   *  separate code path that updates Payment.metadata.refundStatus
   *  without re-mutating the order's payment lifecycle. */
  refund?: {
    /** Provider's own refund ID. Maps to the Payment.refundId we saved when the refund call returned. */
    refundId: string;
    refundReference?: string;
    /** Normalized refund status: completed = funds returned to customer's
     *  card; pending = queued at the gateway; failed = canceled. */
    status: 'pending' | 'completed' | 'failed';
    /** Refund amount in piastres. */
    amount?: number;
  };
  rawPayload: unknown;
  /** The typed v2 event this payload was built from (v2 adapters only; never serialised). */
  v2Event?: WebhookEventV2;
}

export interface PaymentProviderConfig {
  apiKey: string;
  secretKey?: string;
  merchantId?: string;
  baseUrl: string;
  isTestMode: boolean;
  webhookSecret?: string;
}

export interface IPaymentProvider {
  readonly name: PaymentProvider;

  /**
   * Initialize the payment provider
   */
  initialize(config: PaymentProviderConfig): void;

  /**
   * Create a new payment
   */
  createPayment(request: CreatePaymentRequest): Promise<PaymentResponse>;

  /**
   * Get payment status
   */
  getPaymentStatus(transactionId: string): Promise<PaymentStatusResponse>;

  /**
   * Process refund
   */
  refund(request: RefundRequest): Promise<RefundResponse>;

  /**
   * Look up refund status (for providers whose refunds are not instant —
   * a gateway may queue refunds for review). Returns the
   * latest status of the refund identified by `refundId` (provider's own
   * refund ID, NOT our internal Payment.id). Optional — providers whose
   * refunds settle synchronously may not implement this.
   */
  getRefundStatus?(refundId: string): Promise<RefundStatusResponse>;

  /**
   * Verify webhook signature
   */
  verifyWebhook(payload: unknown, signature: string): boolean;

  /**
   * v2 adapters: verify the RAW body against the signature the route extracted, and parse it
   * in one step (the signature of some gateways covers parsed fields, not the bytes). Throws
   * `PaymentProviderError('WEBHOOK_BAD_SIGNATURE' | 'WEBHOOK_MALFORMED')`; never returns a
   * payload for a delivery it did not verify. When present, `handleWebhook` uses it instead
   * of `verifyWebhook` + `parseWebhook`.
   */
  verifyAndParseWebhook?(rawBody: string, signature: string): WebhookPayload;

  /**
   * Server-to-server confirmation of a verified webhook (v2 adapters that implement
   * `confirmWebhookEvent`). Absent = the signature covers every money-deciding field.
   * Resolves to the payload to APPLY; rejects when the state could not be confirmed.
   */
  confirmWebhook?(
    payload: WebhookPayload
  ): Promise<{ payload: WebhookPayload; confirmation: WebhookConfirmation }>;

  /**
   * Parse webhook payload
   */
  parseWebhook(payload: unknown): WebhookPayload;

  /**
   * Get available payment methods
   */
  getPaymentMethods(amount: number, currency: Currency): Promise<AvailablePaymentMethod[]>;
}

// ==========================================
// Payment provider v2 (SP6a)
// ==========================================
//
// `PaymentProviderV2` is the successor of `IPaymentProvider` above. It is the
// same system evolved, not a second one: it reuses `Currency`, `CustomerInfo`,
// `PaymentStatus` and the factory (`registerProviderV2`), and 6b moves the Egypt
// gateway adapters (Paymob, Kashier, Fawry) onto it and deletes the legacy ones
// and `IPaymentProvider`.
//
// Differences that matter for money:
//  - amounts are `amountMinor` (integer piastres) at EVERY boundary; an adapter
//    converts to its gateway's unit (Paymob `amount_cents`, Fawry/Kashier 2dp
//    strings) at its own edge only, with `toMinor` / `fromMinor`-style helpers;
//  - `createPayment` and `refund` carry an `idempotencyKey`, and the adapter must
//    return the SAME result for a repeated key without a second provider call;
//  - the webhook is verified over the RAW body before it is parsed, and yields a
//    typed event with a stable `eventId` the inbox dedupes on;
//  - what the customer must do next is a tagged `PaymentInstruction`, so a
//    redirect, an iframe, a Fawry reference code and a manual transfer render
//    from one shape.

/** What the customer has to do to pay (the result of `createPayment`). */
export type PaymentInstruction =
  | { kind: 'redirect'; url: string; expiresAt?: Date }
  | { kind: 'iframe'; url: string; expiresAt?: Date }
  | {
      kind: 'reference-code';
      /** Code the customer quotes at a Fawry outlet / wallet (e.g. Fawry reference number). */
      code: string;
      expiresAt?: Date;
    }
  | {
      kind: 'manual-instructions';
      /** `cod` (pay the courier) or `instapay` (transfer, merchant confirms). */
      method: 'cod' | 'instapay' | (string & {});
      /** Exact amount to hand over / transfer, in piastres. */
      amountMinor: number;
      /** Free-form, provider-specific fields the storefront renders (handle, phone, reference...). */
      details: Record<string, string | number | null>;
      expiresAt?: Date;
    };

export type PaymentInstructionKind = PaymentInstruction['kind'];

/** Whether a method runs against a gateway's sandbox or its live account. */
export type ProviderMode = 'sandbox' | 'live';

/** Per-merchant credentials, DECRYPTED, handed to an adapter for one call. Never logged, never returned by an API. */
export interface ProviderCredentials {
  apiKey?: string;
  secretKey?: string;
  merchantId?: string;
  webhookSecret?: string;
  mode: ProviderMode;
  /** Non-secret per-provider settings (InstaPay handle, COD percentage, ...). */
  settings?: Record<string, unknown>;
}

export interface ProviderCapabilities {
  /** Customer-facing methods this adapter offers: 'card', 'meeza', 'wallet', 'valu', 'instapay', 'cod', ... */
  methods: readonly string[];
  /** The kinds of `PaymentInstruction` `createPayment` can return. */
  instructions: readonly PaymentInstructionKind[];
  currencies: readonly Currency[];
  /** `partialRefund` is supported (several refunds whose sum stays within what was captured). */
  partialRefunds: boolean;
  /** `refund` / `partialRefund` move money through the provider (false: the merchant refunds outside the system). */
  refunds: boolean;
  /** The provider sends signed webhooks (`verifyWebhook` is meaningful). */
  webhooks: boolean;
  /** `getStatus` asks the provider (false for COD / InstaPay: the only truth is the merchant's confirmation). */
  remoteStatus: boolean;
  savedCards: boolean;
}

export interface CreatePaymentV2Request {
  orderId: string;
  /** Human order number, for the provider's reference / the customer's transfer note. */
  orderNumber?: string;
  /** Integer piastres. Never a float, never a string. */
  amountMinor: number;
  currency: 'EGP';
  customer: CustomerInfo;
  returnUrls: { success: string; failure: string };
  webhookUrl?: string;
  /** Stable per (order, attempt). A repeat must not create a second payment at the provider. */
  idempotencyKey: string;
  /** When the payment stops being payable (the InstaPay hold; a gateway invoice expiry). Chosen by the caller so a repeat is identical. */
  expiresAt?: Date;
  items?: PaymentItem[];
  metadata?: Record<string, string>;
}

export interface CreatePaymentV2Result {
  /** The provider's id for this payment (stored as `Payment.transactionId`); for COD/InstaPay the local order reference. */
  providerRef: string;
  /** Provider-side invoice / order id, when distinct from `providerRef`. */
  invoiceId?: string;
  instruction: PaymentInstruction;
  /** `pending` for a gateway payment; `cod_pending` for COD. */
  status: Extract<PaymentStatus, 'pending' | 'processing' | 'cod_pending'>;
  /** What the provider recorded, in piastres (must equal the request). */
  amountMinor: number;
  currency: 'EGP';
  metadata?: Record<string, unknown>;
}

export interface PaymentStatusV2 {
  status: PaymentStatus;
  amountMinor: number;
  /** Captured so far, piastres (0 until paid). */
  capturedMinor: number;
  /** Refunded so far, piastres. Never exceeds `capturedMinor`. */
  refundedMinor: number;
  currency: 'EGP';
  method?: string;
  paidAt?: Date;
  raw?: Record<string, unknown>;
  /**
   * `false` when the provider's answer carried NO amounts (Kashier's order search projection): `amountMinor`,
   * `capturedMinor` and `refundedMinor` are then 0 placeholders and must never be read as money (#625). Absent = known.
   */
  amountsKnown?: boolean;
}

export interface RefundV2Request {
  /** `CreatePaymentV2Result.providerRef` of the payment being refunded. */
  providerRef: string;
  /** Stable per business event. A repeat must not refund twice. */
  idempotencyKey: string;
  reason?: string;
}

export interface PartialRefundV2Request extends RefundV2Request {
  /** Integer piastres, > 0. */
  amountMinor: number;
}

export interface RefundV2Result {
  refundRef: string;
  status: 'pending' | 'completed' | 'failed';
  /** This refund's amount, piastres. */
  amountMinor: number;
  /** All refunds of the payment so far including this one, piastres. */
  refundedTotalMinor: number;
}

/** A webhook event, verified and typed. `eventId` is the dedupe key (same event redelivered = same id). */
export type WebhookEventV2 =
  | {
      kind: 'payment';
      eventId: string;
      providerRef: string;
      status: PaymentStatus;
      amountMinor: number;
      currency: 'EGP';
      method?: string;
      paidAt?: Date;
      /** The gateway's id of THIS transaction, when it differs from `providerRef` (Kashier `TX-…`). */
      transactionRef?: string;
      rawPayload: unknown;
    }
  | {
      kind: 'refund';
      eventId: string;
      providerRef: string;
      refundRef: string;
      status: 'pending' | 'completed' | 'failed';
      amountMinor: number;
      currency: 'EGP';
      rawPayload: unknown;
    };

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export type PaymentProviderErrorCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'AMOUNT_INVALID'
  | 'CURRENCY_UNSUPPORTED'
  | 'REFUND_EXCEEDS_CAPTURED'
  | 'REFUND_NOT_SUPPORTED'
  | 'STATUS_NOT_SUPPORTED'
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_NOT_CAPTURED'
  | 'WEBHOOK_BAD_SIGNATURE'
  | 'WEBHOOK_MALFORMED'
  | 'PROVIDER_MISCONFIGURED';

/**
 * Every adapter failure is one of these, so the circuit breaker and the
 * checkout can tell "the provider is down" (timeout / unavailable: counts
 * against the breaker) from "this request was wrong" (rejected / invalid: does
 * not).
 */
export class PaymentProviderError extends Error {
  constructor(
    public readonly code: PaymentProviderErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }

  /** True for the codes that mean the provider itself is unhealthy. */
  get isOutage(): boolean {
    return this.code === 'PROVIDER_TIMEOUT' || this.code === 'PROVIDER_UNAVAILABLE';
  }
}

/** Outcome of `testConnection`: what the merchant sees next to the Test connection button. */
export type ConnectionTestCode =
  /** The provider accepted the credentials. */
  | 'ok'
  /** The provider refused them (wrong key, wrong merchant id, wrong signature key). */
  | 'bad_credentials'
  /** A sandbox key in live mode or the reverse. */
  | 'wrong_mode'
  /** Required fields are missing or malformed: nothing was sent. */
  | 'incomplete'
  /** Timeout / 5xx / network: try again later. Says nothing about the credentials. */
  | 'unreachable'
  /** The provider answered something the adapter does not recognise. */
  | 'unknown'
  /** The provider has no safe read-only call: nothing was sent, the connection is UNVERIFIED (PROVIDERS-3). */
  | 'no_check';

export interface ConnectionTestResult {
  ok: boolean;
  code: ConnectionTestCode;
  /** Short English reason for logs / the admin; NEVER a secret or a raw provider body. */
  message: string;
  /** Non-secret facts learned (merchant name, entitled methods), shown back to the merchant. */
  details?: Record<string, string | number | boolean>;
}

export interface PaymentProviderV2 {
  readonly name: PaymentProvider;
  readonly capabilities: ProviderCapabilities;

  /**
   * ONE harmless authenticated call proving the credentials of `creds.mode` are accepted
   * (auth token, account info, a status lookup of a reference that cannot exist). It must not
   * create, move or reserve anything at the provider. Never throws: every failure is a code.
   * Gateways implement it; manual providers (COD, InstaPay) have nothing to test.
   */
  testConnection?(creds: ProviderCredentials): Promise<ConnectionTestResult>;

  /**
   * Start a payment. Idempotent on `idempotencyKey`. Rejects with
   * `PaymentProviderError` (`PROVIDER_TIMEOUT` leaves NO state at the provider
   * the adapter knows of: a timed-out attempt must be retried with the same key).
   */
  createPayment(
    req: CreatePaymentV2Request,
    creds: ProviderCredentials
  ): Promise<CreatePaymentV2Result>;

  /**
   * Verify the webhook over the RAW body + headers, then parse it. Throws
   * `PaymentProviderError('WEBHOOK_BAD_SIGNATURE' | 'WEBHOOK_MALFORMED')`; never
   * returns an event for a body it did not verify. Replays return the same
   * `eventId`, so the inbox dedupes them.
   */
  verifyWebhook(
    rawBody: string | Buffer,
    headers: WebhookHeaders,
    creds: ProviderCredentials
  ): WebhookEventV2;

  getStatus(providerRef: string, creds: ProviderCredentials): Promise<PaymentStatusV2>;

  /** Refund whatever has not been refunded yet. Idempotent on the key. */
  refund(req: RefundV2Request, creds: ProviderCredentials): Promise<RefundV2Result>;

  /**
   * Refund `amountMinor`. The sum of all refunds of a payment may never exceed
   * what was captured (`REFUND_EXCEEDS_CAPTURED`). Idempotent on the key.
   * `REFUND_NOT_SUPPORTED` when `capabilities.partialRefunds` is false.
   */
  partialRefund(req: PartialRefundV2Request, creds: ProviderCredentials): Promise<RefundV2Result>;

  /**
   * Confirm a VERIFIED webhook server-to-server before it is applied. Implemented by a gateway
   * whose signature leaves a money-deciding field unsigned (Kashier: `event`, i.e. refund vs
   * payment). Returns the event as the gateway's own query reports it: the CONFIRMED kind and
   * status replace the delivery's, the signed amount and references are kept. Throws
   * `PaymentProviderError` when the gateway cannot be asked or does not answer clearly; the
   * caller must then NOT apply the event (it retries through the webhook queue).
   */
  confirmWebhookEvent?(
    ev: WebhookEventV2,
    creds: ProviderCredentials
  ): Promise<WebhookConfirmation>;
}

/** What `confirmWebhookEvent` found: the event to apply, and how it compares to the delivery. */
export interface WebhookConfirmation {
  event: WebhookEventV2;
  claimed: { kind: WebhookEventV2['kind']; status: string };
  confirmed: { kind: WebhookEventV2['kind']; status: string };
  /** The delivery's kind or status disagreed with the gateway's own record. */
  mismatch: boolean;
  /** The gateway call that answered (for the audit row), e.g. `kashier GET /v2/aggregator/transactions/:id`. */
  source: string;
}
