/**
 * A local Kashier stub: payment sessions, order retrieval, refunds, and the
 * HMAC-SHA256 `x-kashier-signature` webhook, with DECIMAL string amounts ("123.45") like
 * the real API. It mirrors what the adapter ASSUMES; the unconfirmed parts are
 * `UNVERIFIED:` in the adapter and are checked in 6c.
 */
import { toMinor, minorToDecimalString } from '@force/shared';
import {
  kashierSignature,
  KASHIER_SIGNATURE_HEADER,
} from '@api/services/payment-providers/kashier.provider';
import type { ContractControl, SignedWebhook } from '../contract/payment-provider.contract';
import { FaultGate, headerOf, json, readJson, type StubFault } from './stub-common';

export const KASHIER_STUB = {
  merchantId: 'MID-1-1',
  apiKey: 'kashier-stub-payment-api-key',
  secretKey: 'kashier-stub-secret-key',
  baseUrl: 'https://kashier.stub.test',
} as const;

interface Session {
  id: string;
  order: string;
  amount: string;
  state: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
  refunds: string[];
  transactionId: string | null;
}

export class KashierStub {
  readonly sessions = new Map<string, Session>();
  readonly requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  readonly faults = new FaultGate();
  private seq = 0;

  get createdCount(): number {
    return this.sessions.size;
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const early = await this.faults.enter();
    if (early) return early;
    const path = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = await readJson(init);
    this.requests.push({ method, path, body });
    if (headerOf(init, 'authorization') !== KASHIER_STUB.secretKey) {
      return json(401, { message: 'unauthorized' });
    }
    if (method === 'POST' && path === '/v3/payment/sessions') return this.createSession(body, init);
    const m = path.match(/^\/v3\/orders\/([^/]+)$/);
    if (m && method === 'GET') return this.getOrder(decodeURIComponent(m[1]));
    if (m && method === 'PUT') return this.refund(decodeURIComponent(m[1]), body);
    return json(404, { message: 'not found' });
  };

  private createSession(b: Record<string, unknown>, init?: RequestInit): Response {
    if (headerOf(init, 'api-key') !== KASHIER_STUB.apiKey)
      return json(401, { message: 'bad api key' });
    if (b.merchantId !== KASHIER_STUB.merchantId) return json(400, { message: 'unknown merchant' });
    if (typeof b.amount !== 'string' || !/^\d+\.\d{2}$/.test(b.amount) || Number(b.amount) <= 0) {
      return json(400, { message: 'amount must be a positive decimal with 2 places' });
    }
    if (b.currency !== 'EGP') return json(400, { message: 'unsupported currency' });
    if (typeof b.order !== 'string' || !b.order) return json(400, { message: 'order required' });
    const s: Session = {
      id: `ks_${++this.seq}`,
      order: b.order,
      amount: b.amount,
      state: 'PENDING',
      refunds: [],
      transactionId: null,
    };
    this.sessions.set(s.order, s);
    return json(201, {
      _id: s.id,
      sessionUrl: `https://payments.kashier.stub/session/${s.id}`,
      amount: s.amount,
    });
  }

  private order(s: Session): Record<string, unknown> {
    const refunded = s.refunds.reduce((n, a) => n + toMinor(a), 0);
    return {
      merchantOrderId: s.order,
      status: s.state,
      amount: s.amount,
      currency: 'EGP',
      capturedAmount: s.state === 'PAID' ? s.amount : '0.00',
      refundedAmount: minorToDecimalString(refunded),
      method: 'card',
    };
  }

  private getOrder(id: string): Response {
    const s = this.sessions.get(id);
    return s
      ? json(200, { status: 'SUCCESS', response: this.order(s) })
      : json(404, { message: 'order not found' });
  }

  private refund(id: string, b: Record<string, unknown>): Response {
    const s = this.sessions.get(id);
    if (!s) return json(404, { message: 'order not found' });
    if (s.state !== 'PAID') return json(400, { message: 'order is not paid' });
    const tx = b.transaction as { amount?: string } | undefined;
    if (
      b.apiOperation !== 'REFUND' ||
      typeof tx?.amount !== 'string' ||
      !/^\d+\.\d{2}$/.test(tx.amount)
    ) {
      return json(400, { message: 'invalid refund request' });
    }
    const refunded = s.refunds.reduce((n, a) => n + toMinor(a), 0);
    if (toMinor(tx.amount) <= 0 || toMinor(tx.amount) > toMinor(s.amount) - refunded) {
      return json(400, { message: 'refund exceeds the refundable balance' });
    }
    s.refunds.push(tx.amount);
    return json(200, { status: 'SUCCESS', response: { transactionId: `ktx_r${++this.seq}` } });
  }

  capture(order: string): void {
    const s = this.sessions.get(order);
    if (!s) throw new Error(`no stub kashier order ${order}`);
    s.state = 'PAID';
    s.transactionId = `ktx_${++this.seq}`;
  }

  /** What Kashier POSTs to `serverWebhook`, signed with the Payment API key. */
  webhookFor(
    order: string,
    o: {
      status: string;
      amount: string;
      transactionId: string;
      signatureKeys?: string[];
      event?: string;
    }
  ): SignedWebhook {
    const data: Record<string, unknown> = {
      merchantOrderId: order,
      kashierOrderId: `ko_${order}`,
      transactionId: o.transactionId,
      amount: o.amount,
      currency: 'EGP',
      status: o.status,
      method: 'card',
      signatureKeys: o.signatureKeys ?? [
        'amount',
        'currency',
        'kashierOrderId',
        'merchantOrderId',
        'method',
        'status',
        'transactionId',
      ],
    };
    const signature = kashierSignature(data, data.signatureKeys as string[], KASHIER_STUB.apiKey);
    return {
      rawBody: JSON.stringify({ event: o.event ?? 'pay', data }),
      headers: { [KASHIER_SIGNATURE_HEADER]: signature },
    };
  }
}

export function createKashierControl(stub: KashierStub): ContractControl {
  let n = 0;
  const edit = (w: SignedWebhook, fn: (d: Record<string, unknown>) => void): SignedWebhook => {
    const body = JSON.parse(w.rawBody) as { data: Record<string, unknown> };
    fn(body.data);
    return { ...w, rawBody: JSON.stringify(body) };
  };
  return {
    capture: providerRef => stub.capture(providerRef),
    paymentWebhook: (providerRef, opts = {}) => {
      const s = stub.sessions.get(providerRef)!;
      const state = opts.state ?? (s.state === 'PAID' ? 'paid' : 'pending');
      const status = { paid: 'SUCCESS', pending: 'PENDING', failed: 'FAILED', expired: 'EXPIRED' }[
        state
      ];
      return stub.webhookFor(providerRef, {
        status,
        amount: minorToDecimalString(opts.amountMinor ?? toMinor(s.amount)),
        transactionId: opts.eventId ?? s.transactionId ?? `ktx_pending_${++n}`,
      });
    },
    webhookStates: ['pending', 'failed', 'expired'],
    badSignature: w => ({ ...w, headers: { [KASHIER_SIGNATURE_HEADER]: 'deadbeef' } }),
    noSignature: w => ({ ...w, headers: {} }),
    tamperAmount: (w, amountMinor) =>
      edit(w, d => void (d.amount = minorToDecimalString(amountMinor))),
    tamperStatus: w => edit(w, d => void (d.status = 'FAILED')),
    injectNextCall: (fault: StubFault) => stub.faults.injectNextCall(fault),
    providerPaymentCount: () => stub.createdCount,
  };
}
