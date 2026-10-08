/**
 * A local Kashier stub shaped by Kashier's OFFICIAL docs (developers.kashier.io): payment
 * sessions (POST /v3/payment/sessions, 201), order search (GET /v3/payment/orders?search=),
 * validate-credentials (POST /v2/merchants/validate-credentials), refund (PUT
 * /v3/orders/:kashierOrderId) and the HMAC-SHA256 `x-kashier-signature` webhook whose
 * `data.signatureKeys` are the documented ten. One base URL serves both the dashboard host and
 * the FEP host (the adapter picks the path). Order search carries the amounts only while
 * `emitAmounts` is true: the documented projection has none (UNVERIFIED in the adapter).
 * Transaction details (GET /v2/aggregator/transactions/:transactionId, PROVIDERS-17) answer
 * from `transactions`, Kashier's own record: a capture records a `pay`, a refund a `refund`,
 * and a webhook built for a transaction id the stub has no record of records one from the
 * delivery (so a FORGED relabel of a recorded transaction does not rewrite the record).
 */
import crypto from 'node:crypto';
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

/** The Kashier order id (a uuid) of a session, derived so a test can predict it. */
export function kashierOrderIdOf(order: string): string {
  const h = crypto.createHash('sha1').update(order).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The ten keys of the documented webhook example. */
export const KASHIER_DOCUMENTED_SIGNATURE_KEYS = [
  'amount',
  'channel',
  'currency',
  'kashierOrderId',
  'merchantOrderId',
  'method',
  'orderReference',
  'status',
  'transactionId',
  'transactionResponseCode',
];

export class KashierStub {
  readonly sessions = new Map<string, Session>();
  readonly requests: Array<{
    method: string;
    path: string;
    search: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }> = [];
  readonly faults = new FaultGate();
  /** Order search carries `amount` / `capturedAmount` / `refundedAmount` (UNVERIFIED: not documented). */
  emitAmounts = true;
  /** Kashier's own record of each transaction (what transaction details report). */
  readonly transactions = new Map<string, { order: string; operation: string; status: string }>();
  private seq = 0;

  get createdCount(): number {
    return this.sessions.size;
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = await readJson(init);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    // Recorded BEFORE the fault gate: a call the gateway "never answers" still reached it.
    this.requests.push({ method, path, search: u.search, body, headers });
    const early = await this.faults.enter();
    if (early) return early;
    if (headerOf(init, 'authorization') !== KASHIER_STUB.secretKey) {
      return json(401, { error: 'Authorization error', message: 'Invalid secret key' });
    }
    if (method === 'POST' && path === '/v3/payment/sessions') return this.createSession(body, init);
    if (method === 'POST' && path === '/v2/merchants/validate-credentials') {
      return this.validateCredentials(body);
    }
    if (method === 'GET' && path === '/v3/payment/orders') {
      return this.searchOrders(u.searchParams.get('search'));
    }
    const t = path.match(/^\/v2\/aggregator\/transactions\/([^/]+)$/);
    if (t && method === 'GET') return this.transactionDetails(decodeURIComponent(t[1]));
    const m = path.match(/^\/v3\/orders\/([^/]+)$/);
    if (m && method === 'PUT') return this.refund(decodeURIComponent(m[1]), body);
    return json(404, { message: 'not found' });
  };

  /** The documented details shape: `{ body: {...}, message }`, stored status vocabulary. */
  private transactionDetails(transactionId: string): Response {
    const rec = this.transactions.get(transactionId);
    if (!rec) return json(404, { message: 'Transaction not found' });
    return json(200, {
      body: {
        transactionId,
        method: 'card',
        currency: 'EGP',
        status: rec.status,
        paymentStatus: rec.status,
        trxType: rec.operation === 'pay' ? 'payment' : rec.operation,
        merchantOrderId: rec.order,
        isReversed: false,
        isVoided: false,
        order: { orderId: kashierOrderIdOf(rec.order) },
        transactions: [
          { status: rec.status, currency: 'EGP', operation: rec.operation, transactionId },
        ],
      },
      message: 'The payment transaction has been retreived successfully',
    });
  }

  private validateCredentials(b: Record<string, unknown>): Response {
    const sk = b.secretKeys as Array<{ mode: string; key: string }> | undefined;
    const ak = b.apiKeys as Array<{ mode: string; key: string }> | undefined;
    const ok =
      sk?.[0]?.mode === 'test' &&
      sk[0].key === KASHIER_STUB.secretKey &&
      ak?.[0]?.mode === 'test' &&
      ak[0].key === KASHIER_STUB.apiKey;
    // UNVERIFIED shape: Kashier publishes no 200 body; a wrong api key is modelled as 401 here.
    return ok ? json(200, {}) : json(401, { message: 'Invalid credentials' });
  }

  private createSession(b: Record<string, unknown>, init?: RequestInit): Response {
    if (headerOf(init, 'api-key') !== KASHIER_STUB.apiKey)
      return json(401, { message: 'bad api key' });
    // Required by the schema: expireAt, maxFailureAttempts, amount, currency, order, merchantId,
    // merchantRedirect, type, display, customer.
    for (const f of [
      'expireAt',
      'maxFailureAttempts',
      'amount',
      'currency',
      'order',
      'merchantId',
      'merchantRedirect',
      'type',
      'display',
      'customer',
    ]) {
      if (b[f] === undefined) return json(400, { message: `${f} is required` });
    }
    if (typeof b.expireAt !== 'string' || !(new Date(b.expireAt).getTime() > Date.now())) {
      return json(400, { message: 'expireAt must be a future ISO date' });
    }
    if (b.merchantId !== KASHIER_STUB.merchantId) return json(400, { message: 'unknown merchant' });
    if (typeof b.amount !== 'string' || !/^\d+\.\d{2}$/.test(b.amount) || Number(b.amount) <= 0) {
      return json(400, { message: 'amount must be a positive decimal with 2 places' });
    }
    if (b.currency !== 'EGP') return json(400, { message: 'unsupported currency' });
    if (typeof b.order !== 'string' || !b.order) return json(400, { message: 'order required' });
    if (this.sessions.has(b.order)) {
      return json(400, { code: 'ERR_ORD_02', message: 'Duplicate order.' });
    }
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
      status: 'CREATED',
      failureAttempts: 0,
      capturedAmount: 0,
      refundedAmount: 0,
      _id: s.id,
      merchantId: b.merchantId,
      expireAt: b.expireAt,
      maxFailureAttempts: b.maxFailureAttempts,
      paymentParams: { ...b, hash: 'stub' },
      history: [{ status: 'CREATED', date: new Date().toISOString() }],
      sessionUrl: `https://payments.kashier.stub/session/${s.id}?mode=test`,
    });
  }

  private refundedMinor(s: Session): number {
    return s.refunds.reduce((n, a) => n + toMinor(a), 0);
  }

  private orderEntry(s: Session): Record<string, unknown> {
    const status = { PENDING: 'INITIATED', PAID: 'CAPTURED', FAILED: 'FAILED', EXPIRED: 'EXPIRED' }[
      s.state
    ];
    return {
      merchantOrderId: s.order,
      orderId: kashierOrderIdOf(s.order),
      status,
      interChangeRate: 'ON_US',
      transactions:
        s.state === 'PAID'
          ? [{ operation: 'pay', status: 'SUCCESS', transactionResponseCode: 'APPROVED' }]
          : [],
      ...(this.emitAmounts
        ? {
            amount: s.amount,
            capturedAmount: s.state === 'PAID' ? s.amount : '0.00',
            refundedAmount: minorToDecimalString(this.refundedMinor(s)),
            method: 'card',
          }
        : {}),
    };
  }

  /** `search` is a partial, case-insensitive match on merchantOrderId (look-alikes are returned too). */
  private searchOrders(search: string | null): Response {
    if (!search) return json(400, { message: 'search is required' });
    const data = [...this.sessions.values()]
      .filter(s => s.order.toLowerCase().includes(search.toLowerCase()))
      .map(s => this.orderEntry(s));
    return json(200, {
      status: 'SUCCESS',
      message: 'Orders retrieved successfully',
      data,
      pagination: { total: data.length, page: 1, limit: 20, pages: 1 },
    });
  }

  private refund(kashierOrderId: string, b: Record<string, unknown>): Response {
    const s = [...this.sessions.values()].find(x => kashierOrderIdOf(x.order) === kashierOrderId);
    if (!s) return json(404, { message: 'order not found' });
    if (s.state !== 'PAID') {
      return json(400, { error: { cause: 'order is not paid' }, status: 'FAILURE' });
    }
    const tx = b.transaction as { amount?: unknown } | undefined;
    if (b.apiOperation !== 'REFUND') return json(400, { message: 'invalid refund request' });
    // `transaction.amount` is a JSON NUMBER; omitted = the whole remaining balance.
    if (tx?.amount !== undefined && (typeof tx.amount !== 'number' || tx.amount <= 0)) {
      return json(400, { message: 'transaction.amount must be a positive number' });
    }
    const refunded = this.refundedMinor(s);
    const remaining = toMinor(s.amount) - refunded;
    let amount: string;
    if (tx?.amount === undefined) {
      amount = minorToDecimalString(remaining);
    } else {
      try {
        amount = minorToDecimalString(toMinor(String(tx.amount)));
      } catch {
        return json(400, { message: 'invalid refund amount' });
      }
    }
    if (toMinor(amount) <= 0 || toMinor(amount) > remaining) {
      return json(200, {
        response: { status: 'FAILURE', gatewayMessage: 'refund exceeds the refundable balance' },
        status: 'FAILURE',
      });
    }
    s.refunds.push(amount);
    const refundTxn = `TX-r${++this.seq}`;
    this.transactions.set(refundTxn, { order: s.order, operation: 'refund', status: 'SUCCESS' });
    const totalRefunded = this.refundedMinor(s);
    const full = totalRefunded >= toMinor(s.amount);
    return json(200, {
      response: {
        status: 'SUCCESS',
        gatewayCode: 'APPROVED',
        transactionId: refundTxn,
        amount: Number(amount),
        currency: 'EGP',
        operation: 'refund',
        payload: {
          order: {
            amount: Number(s.amount),
            currency: 'EGP',
            id: kashierOrderId,
            reference: s.order,
            status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
            totalRefundedAmount: Number(minorToDecimalString(totalRefunded)),
          },
          result: 'SUCCESS',
          transaction: { amount: Number(amount), currency: 'EGP', type: 'REFUND' },
        },
      },
      messages: { en: 'Congratulations! Your refund was successful' },
      status: 'SUCCESS',
    });
  }

  capture(order: string): void {
    const s = this.sessions.get(order);
    if (!s) throw new Error(`no stub kashier order ${order}`);
    s.state = 'PAID';
    s.transactionId = `TX-${++this.seq}`;
    this.transactions.set(s.transactionId, { order, operation: 'pay', status: 'SUCCESS' });
  }

  /**
   * What Kashier POSTs to `serverWebhook`, signed with the Payment API key. `data.amount` is a
   * decimal NUMBER (documented), `data.status` is SUCCESS | FAILURE | PENDING, and the default
   * `signatureKeys` are the documented ten (plus none else: `transactionId` is among them).
   */
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
      kashierOrderId: kashierOrderIdOf(order),
      orderReference: `TEST-ORD-${order.length}`,
      transactionId: o.transactionId,
      status: o.status,
      method: 'card',
      creationDate: '2026-10-07T10:00:00.000Z',
      amount: Number(o.amount),
      currency: 'EGP',
      transactionResponseCode: '00',
      channel: 'online | e-commerce',
      signatureKeys: o.signatureKeys ?? KASHIER_DOCUMENTED_SIGNATURE_KEYS,
      platform: {},
    };
    // Kashier keeps a record of every transaction it delivers; a delivery for one it already
    // has (e.g. a relabelled replay) does not change that record.
    if (!this.transactions.has(o.transactionId)) {
      const ev = (o.event ?? 'pay').toLowerCase();
      this.transactions.set(o.transactionId, {
        order,
        operation: ev === 'pay' ? 'pay' : ev,
        status: o.status,
      });
    }
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
      const status = { paid: 'SUCCESS', pending: 'PENDING', failed: 'FAILURE', expired: 'FAILURE' }[
        state
      ];
      return stub.webhookFor(providerRef, {
        status,
        amount: minorToDecimalString(opts.amountMinor ?? toMinor(s.amount)),
        transactionId: opts.eventId ?? s.transactionId ?? `ktx_pending_${++n}`,
      });
    },
    // A webhook's `data.status` is SUCCESS | FAILURE | PENDING: there is no expired delivery.
    webhookStates: ['pending', 'failed'],
    badSignature: w => ({ ...w, headers: { [KASHIER_SIGNATURE_HEADER]: 'deadbeef' } }),
    noSignature: w => ({ ...w, headers: {} }),
    tamperAmount: (w, amountMinor) =>
      edit(w, d => void (d.amount = Number(minorToDecimalString(amountMinor)))),
    tamperStatus: w => edit(w, d => void (d.status = 'FAILURE')),
    injectNextCall: (fault: StubFault) => stub.faults.injectNextCall(fault),
    providerPaymentCount: () => stub.createdCount,
  };
}
