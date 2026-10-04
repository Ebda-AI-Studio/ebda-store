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
  BillingSignatureError,
  headerValue,
  type BillingProvider,
  type BillingWebhookEvent,
  type BillingWebhookKind,
  type ChargeRequest,
  type ChargeResult,
  type CheckoutRequest,
  type CheckoutResult,
  type HeaderBag,
  type ParsedReturn,
  type RefundRequest,
  type RefundResult,
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
  occurredAt?: string;
}

function short(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

export class StubBillingProvider implements BillingProvider {
  readonly name = 'stub' as const;
  declineAll = false;
  private failRemaining = 0;
  private pendingRemaining = 0;
  /** Every NEW charge the stub processed (replays of a key are not counted). */
  readonly chargeCalls: ChargeRequest[] = [];
  readonly refundCalls: RefundRequest[] = [];
  readonly checkoutCalls: CheckoutRequest[] = [];
  private readonly charges = new Map<string, ChargeResult>();
  private readonly refunds = new Map<string, RefundResult>();

  constructor(private readonly secret: string = STUB_WEBHOOK_SECRET) {}

  failNextCharges(n: number): void {
    this.failRemaining = n;
  }
  pendingNextCharges(n: number): void {
    this.pendingRemaining = n;
  }
  reset(): void {
    this.declineAll = false;
    this.failRemaining = 0;
    this.pendingRemaining = 0;
    this.chargeCalls.length = 0;
    this.refundCalls.length = 0;
    this.checkoutCalls.length = 0;
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

  async chargeSavedCard(req: ChargeRequest): Promise<ChargeResult> {
    const seen = this.charges.get(req.idempotencyKey);
    if (seen) return seen;
    this.chargeCalls.push(req);
    const chargeId = `stub_ch_${short(req.idempotencyKey)}`;
    let result: ChargeResult;
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
      result = { status: 'succeeded', chargeId, raw: { stub: true, state: 'paid' } };
    }
    this.charges.set(req.idempotencyKey, result);
    return result;
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    const seen = this.refunds.get(req.idempotencyKey);
    if (seen) return seen;
    this.refundCalls.push(req);
    const result: RefundResult = {
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
      card: p.token ? { token: p.token } : undefined,
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
