/**
 * An in-memory payment gateway and the v2 adapter in front of it.
 *
 * The gateway speaks like the real Egyptian ones: amounts are DECIMAL STRINGS
 * with two places ("123.45", Fawry/Kashier style), so the adapter must convert
 * integer piastres at its edge without a float (the classic 0.29 * 100 = 28.999
 * defect). The webhook is signed `HMAC-SHA256(rawBody, webhookSecret)` in the
 * `x-stub-signature` header. This is the reference adapter the contract suite
 * (`payment-provider.contract.ts`) runs against; 6b's real adapters run the same
 * suite against their own stubs.
 */
import crypto from 'node:crypto';
import { minorToDecimalString, toMinor } from '@force/shared';
import {
  assertChargeable,
  assertRefundAmount,
  callProvider,
} from '@api/services/payment-providers/provider-call';
import {
  PaymentProviderError,
  type CreatePaymentV2Request,
  type CreatePaymentV2Result,
  type PartialRefundV2Request,
  type PaymentProviderV2,
  type PaymentStatus,
  type PaymentStatusV2,
  type ProviderCredentials,
  type RefundV2Request,
  type RefundV2Result,
  type WebhookEventV2,
  type WebhookHeaders,
} from '@api/services/payment-providers/types';
import type { ContractControl } from './payment-provider.contract';

type GatewayState = 'pending' | 'paid' | 'failed' | 'expired';

interface GatewayPayment {
  id: string;
  amount: string; // "123.45"
  state: GatewayState;
  refunds: Array<{ id: string; amount: string }>;
}

export type StubFault = 'timeout' | 'unavailable' | 'rejected';

export class StubGateway {
  readonly payments = new Map<string, GatewayPayment>();
  private byKey = new Map<string, string>();
  private refundByKey = new Map<string, { id: string; amount: string; total: string }>();
  private nextFault: StubFault | null = null;
  private seq = 0;
  /** Provider-side payments ever created (the "no state change" probe). */
  get createdCount(): number {
    return this.payments.size;
  }

  injectNextCall(fault: StubFault): void {
    this.nextFault = fault;
  }

  /** Consumed by every gateway call: a timeout never answers, so the adapter's own timer must fire. */
  async gate(): Promise<void> {
    const f = this.nextFault;
    this.nextFault = null;
    if (f === 'timeout') await new Promise(() => undefined); // hangs; the adapter aborts it
    if (f === 'unavailable') throw new Error('ECONNREFUSED');
    if (f === 'rejected') throw new PaymentProviderError('PROVIDER_REJECTED', 'gateway said no');
  }

  create(key: string, amount: string): GatewayPayment {
    const existing = this.byKey.get(key);
    if (existing) return this.payments.get(existing)!;
    const p: GatewayPayment = { id: `stub_${++this.seq}`, amount, state: 'pending', refunds: [] };
    this.payments.set(p.id, p);
    this.byKey.set(key, p.id);
    return p;
  }

  capture(id: string): void {
    const p = this.payments.get(id);
    if (!p) throw new Error(`no stub payment ${id}`);
    p.state = 'paid';
  }

  get(id: string): GatewayPayment | undefined {
    return this.payments.get(id);
  }

  refund(
    id: string,
    key: string,
    amount: string | null
  ): { id: string; amount: string; total: string } {
    const prior = this.refundByKey.get(key);
    if (prior) return prior;
    const p = this.payments.get(id);
    if (!p) throw new PaymentProviderError('PAYMENT_NOT_FOUND', `unknown payment ${id}`);
    if (p.state !== 'paid') {
      throw new PaymentProviderError('PAYMENT_NOT_CAPTURED', 'cannot refund an uncaptured payment');
    }
    const refundedMinor = p.refunds.reduce((n, r) => n + toMinor(r.amount), 0);
    const remaining = toMinor(p.amount) - refundedMinor;
    const wantMinor = amount === null ? remaining : toMinor(amount);
    if (wantMinor > remaining) {
      throw new PaymentProviderError(
        'REFUND_EXCEEDS_CAPTURED',
        `refund ${wantMinor} exceeds the ${remaining} piastres still refundable`
      );
    }
    const r = { id: `stubref_${++this.seq}`, amount: minorToDecimalString(wantMinor) };
    p.refunds.push(r);
    const out = { ...r, total: minorToDecimalString(refundedMinor + wantMinor) };
    this.refundByKey.set(key, out);
    return out;
  }
}

const STATE_TO_STATUS: Record<GatewayState, PaymentStatus> = {
  pending: 'pending',
  paid: 'completed',
  failed: 'failed',
  expired: 'expired',
};

const sign = (rawBody: string, secret: string) =>
  crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

function header(headers: WebhookHeaders, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function createStubProvider(gateway: StubGateway, timeoutMs = 50): PaymentProviderV2 {
  return {
    name: 'tap', // any member of the PaymentProvider union: the stub is not registered anywhere
    capabilities: {
      methods: ['card', 'meeza', 'wallet'],
      instructions: ['redirect', 'iframe', 'reference-code'],
      currencies: ['EGP'],
      partialRefunds: true,
      refunds: true,
      webhooks: true,
      remoteStatus: true,
      savedCards: false,
    },

    async createPayment(req: CreatePaymentV2Request): Promise<CreatePaymentV2Result> {
      assertChargeable(req);
      const p = await callProvider(
        'stub.createPayment',
        async () => {
          await gateway.gate();
          return gateway.create(req.idempotencyKey, minorToDecimalString(req.amountMinor));
        },
        timeoutMs
      );
      return {
        providerRef: p.id,
        instruction: { kind: 'redirect', url: `https://pay.stub.test/${p.id}` },
        status: 'pending',
        amountMinor: toMinor(p.amount),
        currency: 'EGP',
      };
    },

    verifyWebhook(rawBody, headers, creds: ProviderCredentials): WebhookEventV2 {
      const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      const given = header(headers, 'x-stub-signature');
      if (!given || !creds.webhookSecret) {
        throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'missing signature');
      }
      const expected = sign(body, creds.webhookSecret);
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'signature mismatch');
      }
      let parsed: {
        id?: string;
        type?: string;
        paymentId?: string;
        state?: GatewayState;
        amount?: string;
        refundId?: string;
        refundState?: 'pending' | 'completed' | 'failed';
      };
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'not json');
      }
      if (!parsed.id || !parsed.paymentId || typeof parsed.amount !== 'string') {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'missing fields');
      }
      if (parsed.type === 'refund') {
        return {
          kind: 'refund',
          eventId: parsed.id,
          providerRef: parsed.paymentId,
          refundRef: parsed.refundId ?? parsed.id,
          status: parsed.refundState ?? 'completed',
          amountMinor: toMinor(parsed.amount),
          currency: 'EGP',
          rawPayload: parsed,
        };
      }
      if (!parsed.state || !(parsed.state in STATE_TO_STATUS)) {
        throw new PaymentProviderError('WEBHOOK_MALFORMED', 'unknown state');
      }
      return {
        kind: 'payment',
        eventId: parsed.id,
        providerRef: parsed.paymentId,
        status: STATE_TO_STATUS[parsed.state],
        amountMinor: toMinor(parsed.amount),
        currency: 'EGP',
        rawPayload: parsed,
      };
    },

    async getStatus(providerRef: string): Promise<PaymentStatusV2> {
      const p = await callProvider(
        'stub.getStatus',
        async () => {
          await gateway.gate();
          return gateway.get(providerRef);
        },
        timeoutMs
      );
      if (!p) throw new PaymentProviderError('PAYMENT_NOT_FOUND', providerRef);
      const amountMinor = toMinor(p.amount);
      const refundedMinor = p.refunds.reduce((n, r) => n + toMinor(r.amount), 0);
      return {
        status:
          p.state === 'paid' && refundedMinor > 0
            ? refundedMinor >= amountMinor
              ? 'refunded'
              : 'partially_refunded'
            : STATE_TO_STATUS[p.state],
        amountMinor,
        capturedMinor: p.state === 'paid' ? amountMinor : 0,
        refundedMinor,
        currency: 'EGP',
      };
    },

    async refund(req: RefundV2Request): Promise<RefundV2Result> {
      const r = await callProvider(
        'stub.refund',
        async () => {
          await gateway.gate();
          return gateway.refund(req.providerRef, req.idempotencyKey, null);
        },
        timeoutMs
      );
      return {
        refundRef: r.id,
        status: 'completed',
        amountMinor: toMinor(r.amount),
        refundedTotalMinor: toMinor(r.total),
      };
    },

    async partialRefund(req: PartialRefundV2Request): Promise<RefundV2Result> {
      assertRefundAmount(req.amountMinor);
      const r = await callProvider(
        'stub.partialRefund',
        async () => {
          await gateway.gate();
          return gateway.refund(
            req.providerRef,
            req.idempotencyKey,
            minorToDecimalString(req.amountMinor)
          );
        },
        timeoutMs
      );
      return {
        refundRef: r.id,
        status: 'completed',
        amountMinor: toMinor(r.amount),
        refundedTotalMinor: toMinor(r.total),
      };
    },
  };
}

export const STUB_WEBHOOK_SECRET = 'stub-webhook-secret';

/** The test-side controls the contract suite drives the stub with. */
export function createStubControl(gateway: StubGateway): ContractControl {
  let seq = 0;
  const signed = (payload: Record<string, unknown>) => {
    const rawBody = JSON.stringify(payload);
    return { rawBody, headers: { 'x-stub-signature': sign(rawBody, STUB_WEBHOOK_SECRET) } };
  };
  return {
    capture: async providerRef => gateway.capture(providerRef),
    paymentWebhook: (providerRef, opts = {}) => {
      const p = gateway.get(providerRef)!;
      return signed({
        id: opts.eventId ?? `evt_${++seq}`,
        type: 'payment',
        paymentId: providerRef,
        state: opts.state ?? p.state,
        amount: minorToDecimalString(opts.amountMinor ?? toMinor(p.amount)),
      });
    },
    injectNextCall: fault => gateway.injectNextCall(fault),
    providerPaymentCount: () => gateway.createdCount,
  };
}
