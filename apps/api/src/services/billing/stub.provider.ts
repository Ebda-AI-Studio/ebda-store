/**
 * StubBillingProvider — local, deterministic stand-in for a real gateway
 * (SP5 task 3). Forbidden in production (see `resolveBillingProviderName`).
 *
 * Deterministic: ids derive from a hash of the idempotency key / order id. It
 * honours idempotency like a real gateway should (a repeated key returns the
 * SAME charge and does not count as a second call), and can be told to fail:
 *   - `failNextCharges(n)`  — the next n NEW charges decline
 *   - `declineAll = true`   — every new charge declines
 *   - a token starting `tok_decline` always declines
 *   - `pendingNextCharges(n)` — the next n charges answer `pending` (webhook settles)
 *
 * Webhooks are signed `x-stub-signature = hex(HMAC-SHA256(secret, rawBody))`;
 * `StubBillingProvider.signedWebhook()` builds a delivery for tests / the dev
 * "confirm checkout" endpoint.
 */
import crypto from 'crypto';
import {
  BillingProviderError,
  BillingSignatureError,
  headerValue,
  type BillingProvider,
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

export const STUB_WEBHOOK_SECRET = 'stub-billing-webhook-secret';

export interface StubWebhookPayload {
  id: string;
  type: BillingWebhookKind;
  merchantOrderId: string | null;
  chargeId: string | null;
  amountMinor: number | null;
  currency?: string;
  failureReason?: string;
  token?: string;
  /** Card display details on a `card.saved` delivery. */
  last4?: string;
  brand?: string;
  occurredAt?: string;
}

function short(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

export class StubBillingProvider implements BillingProvider {
  readonly name = 'stub' as const;
  readonly capabilities = { cardSetupWithoutCharge: true };
  declineAll = false;
  private failRemaining = 0;
  private pendingRemaining = 0;
  private refundFailRemaining = 0;
  private timeoutRemaining = 0;
  private timeoutCharged = false;
  /** Every NEW charge the stub processed (replays of a key are not counted). */
  readonly chargeCalls: ChargeRequest[] = [];
  /**
   * EVERY charge request, replays included. A real gateway (Kashier has no
   * idempotency header) would charge a replayed request again, so tests that
   * prove "never sent twice" must count these, not `chargeCalls`.
   */
  readonly chargeRequests: ChargeRequest[] = [];
  readonly refundCalls: RefundRequest[] = [];
  readonly checkoutCalls: CheckoutRequest[] = [];
  readonly cardSetupCalls: CardSetupRequest[] = [];
  private readonly charges = new Map<string, ChargeResult>();
  private readonly refunds = new Map<string, RefundResult>();

  constructor(private readonly secret: string = STUB_WEBHOOK_SECRET) {}

  failNextCharges(n: number): void {
    this.failRemaining = n;
  }
  /** The next `n` NEW refund requests come back rejected by the gateway. */
  failNextRefunds(n: number): void {
    this.refundFailRemaining = n;
  }
  /**
   * The next `n` charges TIME OUT (outcome unknown to the caller). `charged` = the gateway really took the money
   * (the answer was lost), which `getChargeStatus` then reveals.
   */
  timeoutNextCharges(n: number, charged: boolean): void {
    this.timeoutRemaining = n;
    this.timeoutCharged = charged;
  }
  pendingNextCharges(n: number): void {
    this.pendingRemaining = n;
  }
  reset(): void {
    this.declineAll = false;
    this.failRemaining = 0;
    this.pendingRemaining = 0;
    this.refundFailRemaining = 0;
    this.timeoutRemaining = 0;
    this.timeoutCharged = false;
    this.chargeCalls.length = 0;
    this.chargeRequests.length = 0;
    this.refundCalls.length = 0;
    this.checkoutCalls.length = 0;
    this.cardSetupCalls.length = 0;
    this.charges.clear();
    this.refunds.clear();
  }

  async createCheckoutForSubscription(req: CheckoutRequest): Promise<CheckoutResult> {
    this.checkoutCalls.push(req);
    const sep = req.returnUrl.includes('?') ? '&' : '?';
    return {
      redirectUrl: `${req.returnUrl}${sep}stub=1&merchantOrderId=${encodeURIComponent(req.merchantOrderId)}`,
      providerSessionId: `stub_sess_${short(req.merchantOrderId)}`,
    };
  }

  async createCardSetupSession(req: CardSetupRequest): Promise<CheckoutResult> {
    this.cardSetupCalls.push(req);
    const sep = req.returnUrl.includes('?') ? '&' : '?';
    return {
      redirectUrl: `${req.returnUrl}${sep}stub=1&merchantOrderId=${encodeURIComponent(req.merchantOrderId)}`,
      providerSessionId: `stub_setup_${short(req.merchantOrderId)}`,
    };
  }

  async chargeSavedCard(req: ChargeRequest): Promise<ChargeResult> {
    this.chargeRequests.push(req);
    const seen = this.charges.get(req.idempotencyKey);
    if (seen) return seen;
    this.chargeCalls.push(req);
    const chargeId = `stub_ch_${short(req.idempotencyKey)}`;
    let result: ChargeResult;
    if (this.timeoutRemaining > 0) {
      this.timeoutRemaining--;
      // the gateway processed it (or declined it) but the answer was lost on the way back
      this.charges.set(req.idempotencyKey, {
        status: this.timeoutCharged ? 'succeeded' : 'failed',
        chargeId,
        ...(this.timeoutCharged ? {} : { failureReason: 'stub: declined (answer lost)' }),
        raw: { stub: true, state: 'answer_lost' },
        // the later status lookup states what was charged, like a gateway's transaction details
        amountMinor: req.amountMinor,
        currency: req.currency,
      });
      throw new BillingProviderError('stub: timeout', false);
    }
    if (this.pendingRemaining > 0) {
      this.pendingRemaining--;
      result = { status: 'pending', chargeId, raw: { stub: true, state: 'pending' } };
    } else if (this.declineAll || req.token.startsWith('tok_decline') || this.failRemaining > 0) {
      if (this.failRemaining > 0) this.failRemaining--;
      result = {
        status: 'failed',
        chargeId,
        failureReason: 'stub: card declined',
        raw: { stub: true, state: 'declined' },
      };
    } else {
      result = {
        status: 'succeeded',
        chargeId,
        raw: { stub: true, state: 'paid' },
        amountMinor: req.amountMinor,
        currency: req.currency,
      };
    }
    this.charges.set(req.idempotencyKey, result);
    return result;
  }

  async getChargeStatus(req: {
    idempotencyKey: string;
    merchantOrderId: string;
    chargeId: string | null;
  }): Promise<ChargeResult | null> {
    return this.charges.get(req.idempotencyKey) ?? null;
  }

  /** Reversals the gateway "made outside Ebda", by charge id (tests set it; the reversal reconcile reads it, #837). */
  outOfBandReversals = new Map<string, GatewayReversals>();

  async listReversals(req: { chargeId: string }): Promise<GatewayReversals> {
    return this.outOfBandReversals.get(req.chargeId) ?? { reversals: [], unknownOperations: [] };
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    const seen = this.refunds.get(req.idempotencyKey);
    if (seen) return seen;
    this.refundCalls.push(req);
    const rejected = this.refundFailRemaining > 0;
    if (rejected) this.refundFailRemaining--;
    const result: RefundResult = rejected
      ? {
          status: 'failed',
          refundId: `stub_rf_${short(req.idempotencyKey)}`,
          failureReason: 'stub: refund rejected',
          raw: { stub: true, state: 'rejected' },
        }
      : {
          status: 'succeeded',
          refundId: `stub_rf_${short(req.idempotencyKey)}`,
          raw: { stub: true },
        };
    this.refunds.set(req.idempotencyKey, result);
    return result;
  }

  static signedWebhook(
    payload: StubWebhookPayload,
    secret: string = STUB_WEBHOOK_SECRET
  ): { rawBody: string; headers: Record<string, string> } {
    const rawBody = JSON.stringify(payload);
    return { rawBody, headers: { 'x-stub-signature': hmacSha256Hex(secret, rawBody) } };
  }

  verifyWebhook(rawBody: Buffer | string, headers: HeaderBag): BillingWebhookEvent {
    const provided = headerValue(headers, 'x-stub-signature');
    if (!provided) throw new BillingSignatureError('Missing x-stub-signature');
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    if (!safeEqual(hmacSha256Hex(this.secret, text), provided.trim().toLowerCase())) {
      throw new BillingSignatureError();
    }
    let p: StubWebhookPayload;
    try {
      p = JSON.parse(text) as StubWebhookPayload;
    } catch {
      throw new BillingSignatureError('Unparseable webhook body');
    }
    return {
      eventId: p.id,
      kind: p.type,
      merchantOrderId: p.merchantOrderId ?? null,
      providerRef: p.chargeId ?? null,
      amountMinor: p.amountMinor ?? null,
      currency: p.currency ?? 'EGP',
      failureReason: p.failureReason,
      card: p.token ? { token: p.token, last4: p.last4, brand: p.brand } : undefined,
      occurredAt: p.occurredAt ? new Date(p.occurredAt) : new Date(),
      raw: { ...p, token: undefined },
    };
  }

  parseReturn(query: Record<string, unknown>): ParsedReturn {
    const id = typeof query.merchantOrderId === 'string' ? query.merchantOrderId : null;
    const outcome =
      query.outcome === 'failure' ? 'failure' : query.outcome === 'success' ? 'success' : 'unknown';
    return { merchantOrderId: id, providerRef: null, outcome, trusted: false };
  }
}
