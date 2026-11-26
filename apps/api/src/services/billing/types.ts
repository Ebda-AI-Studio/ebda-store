/**
 * BillingProvider — the contract Ebda's OWN subscription billing talks to a
 * payment gateway through (SP5 task 3). Ebda runs the engine (invoices,
 * dunning, retries, idempotency); the gateway is only a card-token charger.
 *
 * Rules every adapter must keep:
 *  - Amounts cross this interface as INTEGER minor units (piastres) and are
 *    converted to the gateway's wire format at the adapter edge only
 *    (`gatewayAmount()`); never a float.
 *  - Currency is 'EGP' only.
 *  - `verifyWebhook` verifies the signature over the RAW body BEFORE parsing and
 *    throws `BillingSignatureError` when it does not match.
 *  - Card tokens are returned to the lifecycle service once and must never be
 *    logged or persisted in `raw` payloads (adapters strip them).
 *  - Every provider call is made OUTSIDE any DB transaction (the request
 *    transaction would expire / pin a pooled connection during the call).
 */

export type BillingProviderName = 'kashier' | 'stub';
export type BillingCurrency = 'EGP';

export interface CheckoutRequest {
  /** Our reference for this attempt (the `billing_events.id`). Echoed back by webhooks. */
  merchantOrderId: string;
  amountMinor: number;
  currency: BillingCurrency;
  description: string;
  customer: { reference: string; email: string; name?: string };
  /** Where the hosted page sends the browser afterwards (informational only). */
  returnUrl: string;
  /** Server-to-server confirmation URL (the source of truth). */
  webhookUrl: string;
  locale?: 'ar' | 'en';
}

/**
 * Save a card WITHOUT charging it (signup funnel, Ruling EBDA-FUNNEL-2). Only
 * providers whose `capabilities.cardSetupWithoutCharge` is true implement it;
 * the others throw `BillingProviderError(notCharged: true)`.
 */
export interface CardSetupRequest {
  /** Our reference for this attempt (the `billing_events.id`, type `card_setup`). */
  merchantOrderId: string;
  customer: { reference: string; email: string; name?: string };
  returnUrl: string;
  webhookUrl: string;
  locale?: 'ar' | 'en';
}

export interface BillingProviderCapabilities {
  /** The provider can tokenize a card with NO money moving (no charge, no auth hold). */
  cardSetupWithoutCharge: boolean;
}

export interface CheckoutResult {
  redirectUrl: string;
  providerSessionId: string | null;
}

export interface ChargeRequest {
  /** Saved-card token from a previous checkout. Never log it. */
  token: string;
  amountMinor: number;
  currency: BillingCurrency;
  /** Stable per money attempt; the provider/stub must treat a repeat as the same charge. */
  idempotencyKey: string;
  description: string;
  /** Our reference (the `billing_events.id`); echoed back by webhooks. */
  merchantOrderId?: string;
}

export interface ChargeResult {
  /** `pending` = the gateway will confirm by webhook. */
  status: 'succeeded' | 'failed' | 'pending';
  chargeId: string | null;
  failureReason?: string;
  /** Provider payload with card tokens removed. */
  raw: unknown;
  /**
   * #627: the amount / currency the gateway STATES it charged. Absent on a status answer that does not say: such a
   * success is HELD for a person, never settled (`maySettle`).
   */
  amountMinor?: number | null;
  currency?: string | null;
}

export interface RefundRequest {
  chargeId: string;
  amountMinor: number;
  idempotencyKey: string;
}

export interface RefundResult {
  status: 'succeeded' | 'failed' | 'pending';
  refundId: string | null;
  failureReason?: string;
  raw: unknown;
}

export type BillingWebhookKind =
  | 'charge.succeeded'
  | 'charge.failed'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'card.saved'
  | 'card.failed'
  | 'ignored';

/** A verified, typed provider event. */
export interface BillingWebhookEvent {
  /** Unique per provider delivery semantic (`<transaction>:<status>`); dedupe key. */
  eventId: string;
  kind: BillingWebhookKind;
  /** Our `billing_events.id`, when the provider echoed it. */
  merchantOrderId: string | null;
  /** The provider's charge/transaction id. */
  providerRef: string | null;
  amountMinor: number | null;
  currency: string | null;
  failureReason?: string;
  /** Present on a successful card-saving checkout. */
  card?: { token: string; last4?: string; brand?: string };
  customerRef?: string;
  occurredAt: Date;
  /** Payload with card tokens removed — safe to persist. */
  raw: unknown;
}

export interface ParsedReturn {
  merchantOrderId: string | null;
  providerRef: string | null;
  /** Browser-reported hint only. NEVER activate a subscription from this. */
  outcome: 'success' | 'failure' | 'unknown';
  trusted: false;
}

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface BillingProvider {
  readonly name: BillingProviderName;
  readonly capabilities: BillingProviderCapabilities;
  /** Hosted page that ONLY saves a card (nothing charged). See `CardSetupRequest`. */
  createCardSetupSession(req: CardSetupRequest): Promise<CheckoutResult>;
  /** Hosted page that saves a card and takes the first charge. */
  createCheckoutForSubscription(req: CheckoutRequest): Promise<CheckoutResult>;
  chargeSavedCard(req: ChargeRequest): Promise<ChargeResult>;
  /**
   * Ask the gateway what became of a charge whose answer never reached us (timeout / 5xx). `null` = the gateway
   * does not know it. Optional: a provider without a status lookup leaves the stuck-charge sweep to alert and,
   * after the give-up window, hand the row to dunning (M-023).
   */
  getChargeStatus?(req: {
    idempotencyKey: string;
    merchantOrderId: string;
    chargeId: string | null;
  }): Promise<ChargeResult | null>;
  refund(req: RefundRequest): Promise<RefundResult>;
  /**
   * What the gateway's own record says was taken BACK from a succeeded charge (refunds made outside Ebda, e.g. from
   * the gateway dashboard, reversals, chargebacks). Read by the daily reversal reconcile (#837), because a gateway may
   * not deliver every reversal as a webhook. Optional: a provider without it is skipped. Throws when the gateway
   * cannot answer clearly (the reconcile then alerts and retries tomorrow; it never guesses "nothing happened").
   */
  listReversals?(req: { chargeId: string; merchantOrderId: string }): Promise<GatewayReversals>;
  verifyWebhook(rawBody: Buffer | string, headers: HeaderBag): BillingWebhookEvent;
  /** False when the credentials this provider needs are missing (its webhooks then answer 503). */
  isConfigured?(): boolean;
  /**
   * Server-to-server confirmation of a verified webhook before it is applied (PROVIDERS-17),
   * for a gateway whose signature leaves the event kind unsigned (Kashier). Throws when the
   * gateway cannot confirm: the caller must apply nothing and let the gateway redeliver.
   */
  confirmWebhookEvent?(event: BillingWebhookEvent): Promise<BillingWebhookConfirmation>;
  parseReturn(query: Record<string, unknown>): ParsedReturn;
}

export interface GatewayReversals {
  /** Successful take-backs on the charge, each with the gateway's own transaction id. Amount null = not stated. */
  reversals: Array<{ ref: string; operation: string; amountMinor: number | null }>;
  /** Operations on the charge's record this code does not know: never ignored, they page a person. */
  unknownOperations: string[];
}

export interface BillingWebhookConfirmation {
  /** The event to APPLY: the delivery with the gateway's own kind. */
  event: BillingWebhookEvent;
  claimed: BillingWebhookKind;
  confirmed: BillingWebhookKind;
  mismatch: boolean;
  source: string;
}

export class BillingSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'BillingSignatureError';
  }
}

/**
 * The provider call did not produce an answer. `notCharged` is true only when
 * we KNOW no money moved (bad config, auth rejected, request refused before
 * processing); a timeout / 5xx / dropped connection is `notCharged: false` —
 * the outcome is unknown, so the ledger row stays `pending` for the webhook (or
 * an operator) to settle and is never blindly re-sent.
 */
export class BillingProviderError extends Error {
  constructor(
    message: string,
    public readonly notCharged: boolean
  ) {
    super(message);
    this.name = 'BillingProviderError';
  }
}

export function headerValue(headers: HeaderBag, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}
