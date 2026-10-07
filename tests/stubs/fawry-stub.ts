/**
 * A local FawryPay stub speaking the shapes in Fawry's official developer docs: PayAtFawry
 * charge (a reference number), the hosted-checkout init (answers a BARE URL string, not JSON),
 * status v2 (9938 / 9901 / 9946), refund (9935 / 9954) and the v2 server notification with its
 * body `messageSignature`. Amounts are 2-decimal numbers like the real API. Every request
 * signature is verified with a formula written out HERE, not by the adapter's helpers, so a
 * mirrored mistake in the adapter cannot pass. What the docs do not say stays `UNVERIFIED:`
 * in the adapter.
 */
import crypto from 'node:crypto';
import { toMinor, minorToDecimalString } from '@force/shared';
import type { ContractControl, SignedWebhook } from '../contract/payment-provider.contract';
import { FaultGate, json, readJson, type StubFault } from './stub-common';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const two = (minor: number) => minorToDecimalString(minor);

export const FAWRY_STUB = {
  merchantCode: 'FAWRYSTUBMERCH',
  secureKey: 'fawry-stub-secure-key',
  baseUrl: 'https://fawry.stub.test',
} as const;

interface Charge {
  merchantRef: string;
  referenceNumber: string;
  method: 'PAYATFAWRY' | 'CARD';
  amountMinor: number;
  state: 'UNPAID' | 'PAID' | 'FAILED' | 'EXPIRED' | 'CANCELED';
  refundedMinor: number;
  paymentRef?: string;
}

const okBody = (extra: Record<string, unknown> = {}) => ({
  type: 'ChargeResponse',
  statusCode: 200,
  statusDescription: 'Operation done successfully',
  ...extra,
});

export class FawryStub {
  readonly charges = new Map<string, Charge>();
  readonly requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  readonly faults = new FaultGate();
  /**
   * `refundedAmount` is NOT in Fawry's documented status v2 payload. It is emitted by default so
   * the shared contract suite (which asserts exact refund tracking) can run; set true to speak
   * the documented shape only (REFUNDED / PARTIAL_REFUNDED with no amount).
   */
  documentedShapesOnly = false;
  private seq = 0;
  private notificationSeq = 0;

  get createdCount(): number {
    return this.charges.size;
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = method === 'GET' ? Object.fromEntries(u.searchParams) : await readJson(init);
    // Recorded BEFORE the fault gate: a call the gateway "never answers" still reached it.
    this.requests.push({ method, path: u.pathname, body });
    const early = await this.faults.enter();
    if (early) return early;
    if (method === 'POST' && u.pathname === '/ECommerceWeb/Fawry/payments/charge')
      return this.charge(body);
    if (method === 'POST' && u.pathname === '/fawrypay-api/api/payments/init')
      return this.init(body);
    if (method === 'GET' && u.pathname === '/ECommerceWeb/Fawry/payments/status/v2')
      return this.status(body);
    if (method === 'POST' && u.pathname === '/ECommerceWeb/Fawry/payments/refund')
      return this.refund(body);
    return json(404, { message: 'not found' });
  };

  private bad = (code: number, description: string) =>
    json(200, { type: 'ChargeResponse', statusCode: code, statusDescription: description });

  private checkItems(b: Record<string, unknown>): number | null {
    const items = (b.chargeItems as Array<{ price: number; quantity: number }> | undefined) ?? [];
    if (items.length === 0) return null;
    return items.reduce((n, i) => n + toMinor(String(i.price)) * Number(i.quantity), 0);
  }

  private open(
    b: Record<string, unknown>,
    method: 'PAYATFAWRY' | 'CARD',
    amountMinor: number
  ): Charge {
    const c: Charge = {
      merchantRef: String(b.merchantRefNum),
      referenceNumber: String(9_310_000_000 + ++this.seq),
      method,
      amountMinor,
      state: 'UNPAID',
      refundedMinor: 0,
    };
    this.charges.set(c.merchantRef, c);
    return c;
  }

  /** POST /ECommerceWeb/Fawry/payments/charge, PayAtFawry only (card is the hosted init). */
  private charge(b: Record<string, unknown>): Response {
    if (b.merchantCode !== FAWRY_STUB.merchantCode)
      return this.bad(9901, 'merchant code is blank or invalid.');
    if (b.paymentMethod !== 'PayAtFawry') return this.bad(9900, 'Invalid payment method');
    if (typeof b.amount !== 'number' || b.amount <= 0) return this.bad(9900, 'Invalid amount');
    if (!b.customerMobile || !b.customerEmail || !b.description || !b.language) {
      return this.bad(9900, 'Missing required field');
    }
    const amountMinor = toMinor(String(b.amount));
    // merchantCode + merchantRefNum + customerProfileId(if any) + paymentMethod + amount(2dp) + secureKey
    const expected = sha(
      FAWRY_STUB.merchantCode +
        String(b.merchantRefNum) +
        String(b.customerProfileId ?? '') +
        'PayAtFawry' +
        two(amountMinor) +
        FAWRY_STUB.secureKey
    );
    if (b.signature !== expected) return this.bad(9946, 'Blank or invalid signature');
    if (this.checkItems(b) !== amountMinor) {
      return this.bad(9900, 'Charge items do not add up to the amount');
    }
    const c = this.open(b, 'PAYATFAWRY', amountMinor);
    return json(
      200,
      okBody({
        referenceNumber: c.referenceNumber,
        merchantRefNumber: c.merchantRef,
        orderAmount: Number(two(amountMinor)),
        paymentAmount: Number(two(amountMinor)),
        fawryFees: 0,
        paymentMethod: 'PayAtFawry',
        orderStatus: 'NEW',
      })
    );
  }

  /** POST /fawrypay-api/api/payments/init: NO amount field; answers a bare URL string. */
  private init(b: Record<string, unknown>): Response {
    if (b.merchantCode !== FAWRY_STUB.merchantCode)
      return this.bad(9901, 'merchant code is blank or invalid.');
    if (!b.returnUrl || !b.language || !b.customerMobile || !b.customerEmail) {
      return this.bad(9900, 'Missing required field');
    }
    if ('amount' in b) return this.bad(9900, 'amount is not a field of the hosted init');
    const items =
      (b.chargeItems as Array<{ itemId: string; quantity: number; price: number }>) ?? [];
    if (items.length === 0) return this.bad(9900, 'chargeItems required');
    // merchantCode + merchantRefNum + customerProfileId("") + returnUrl + sorted(itemId+quantity+price(2dp)) + key
    const sorted = [...items].sort((x, y) =>
      x.itemId < y.itemId ? -1 : x.itemId > y.itemId ? 1 : 0
    );
    const expected = sha(
      FAWRY_STUB.merchantCode +
        String(b.merchantRefNum) +
        String(b.customerProfileId ?? '') +
        String(b.returnUrl) +
        sorted.map(i => i.itemId + String(i.quantity) + two(toMinor(String(i.price)))).join('') +
        FAWRY_STUB.secureKey
    );
    if (b.signature !== expected) return this.bad(9946, 'Blank or invalid signature');
    const total = this.checkItems(b)!;
    const c = this.open(b, b.paymentMethod === 'CARD' ? 'CARD' : 'PAYATFAWRY', total);
    return new Response(
      `https://fawry.stub.test/atfawry/plugin?payment-id=${c.referenceNumber}&locale=en`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }
    );
  }

  private status(q: Record<string, unknown>): Response {
    if (q.merchantCode !== FAWRY_STUB.merchantCode)
      return this.bad(9901, 'merchant code is blank or invalid.');
    // merchantCode + merchantRefNumber + secureKey
    if (
      q.signature !==
      sha(FAWRY_STUB.merchantCode + String(q.merchantRefNumber) + FAWRY_STUB.secureKey)
    ) {
      return json(200, {
        type: 'PaymentStatusResponse',
        statusCode: 9946,
        statusDescription: 'Wrong Signature',
      });
    }
    const c = this.charges.get(String(q.merchantRefNumber));
    if (!c) return this.bad(9938, 'Order not found.');
    const orderStatus =
      c.state === 'PAID'
        ? c.refundedMinor === 0
          ? 'PAID'
          : c.refundedMinor >= c.amountMinor
            ? 'REFUNDED'
            : 'PARTIAL_REFUNDED'
        : c.state === 'UNPAID'
          ? 'NEW'
          : c.state;
    return json(200, {
      requestId: `req_${++this.notificationSeq}`,
      fawryRefNumber: c.referenceNumber,
      merchantRefNumber: c.merchantRef,
      orderAmount: Number(two(c.amountMinor)),
      paymentAmount: c.state === 'PAID' ? Number(two(c.amountMinor)) : 0,
      fawryFees: 0,
      shippingFees: null,
      paymentMethod: c.method,
      orderStatus,
      ...(c.state === 'PAID' ? { paymentTime: 1_790_000_000_000 } : {}),
      ...(this.documentedShapesOnly ? {} : { refundedAmount: Number(two(c.refundedMinor)) }),
    });
  }

  private refund(b: Record<string, unknown>): Response {
    if (b.merchantCode !== FAWRY_STUB.merchantCode)
      return this.bad(9901, 'merchant code is blank or invalid.');
    if (typeof b.refundAmount !== 'number' || b.refundAmount <= 0)
      return this.bad(9900, 'Invalid refund amount');
    const amount = toMinor(String(b.refundAmount));
    // merchantCode + referenceNumber + refundAmount(2dp) + reason(if exists) + secureKey
    const sig = sha(
      FAWRY_STUB.merchantCode +
        String(b.referenceNumber) +
        two(amount) +
        (typeof b.reason === 'string' ? b.reason : '') +
        FAWRY_STUB.secureKey
    );
    if (b.signature !== sig) return this.bad(9946, 'Blank or invalid signature');
    const c = [...this.charges.values()].find(x => x.referenceNumber === String(b.referenceNumber));
    if (!c) return this.bad(9938, 'Order not found.');
    if (c.state !== 'PAID') return this.bad(9954, 'Order is not paid');
    if (amount > c.amountMinor - c.refundedMinor)
      return this.bad(9935, 'Refunded amount greater than paid amount');
    c.refundedMinor += amount;
    return json(200, okBody());
  }

  capture(merchantRef: string): void {
    const c = this.charges.get(merchantRef);
    if (!c) throw new Error(`no stub fawry charge ${merchantRef}`);
    c.state = 'PAID';
    c.paymentRef = `fpay_${++this.seq}`;
  }

  /** The v2 notification Fawry POSTs to the merchant's callback. */
  notificationFor(
    merchantRef: string,
    o: {
      orderStatus: string;
      paymentAmountMinor: number;
      orderAmountMinor?: number;
      paymentRef?: string;
    }
  ): SignedWebhook {
    const c = this.charges.get(merchantRef)!;
    const orderAmountMinor = o.orderAmountMinor ?? c.amountMinor;
    // fawryRefNumber + merchantRefNumber + paymentAmount(2dp) + orderAmount(2dp) + orderStatus +
    // paymentMethod + paymentRefrenceNumber(blank if absent) + secureKey
    const sig = sha(
      c.referenceNumber +
        c.merchantRef +
        two(o.paymentAmountMinor) +
        two(orderAmountMinor) +
        o.orderStatus +
        c.method +
        (o.paymentRef ?? '') +
        FAWRY_STUB.secureKey
    );
    return {
      rawBody: JSON.stringify({
        requestId: `req_${++this.notificationSeq}`,
        fawryRefNumber: c.referenceNumber,
        merchantRefNumber: c.merchantRef,
        customerMobile: '01012345678',
        paymentAmount: Number(minorToDecimalString(o.paymentAmountMinor)),
        orderAmount: Number(minorToDecimalString(orderAmountMinor)),
        fawryFees: 0,
        orderStatus: o.orderStatus,
        paymentMethod: c.method,
        ...(o.paymentRef ? { paymentRefrenceNumber: o.paymentRef } : {}),
        messageSignature: sig,
      }),
      headers: {},
    };
  }
}

export function createFawryControl(stub: FawryStub): ContractControl {
  const edit = (w: SignedWebhook, fn: (b: Record<string, unknown>) => void): SignedWebhook => {
    const body = JSON.parse(w.rawBody) as Record<string, unknown>;
    fn(body);
    return { ...w, rawBody: JSON.stringify(body) };
  };
  return {
    capture: providerRef => stub.capture(providerRef),
    paymentWebhook: (providerRef, opts = {}) => {
      const c = stub.charges.get(providerRef)!;
      const state = opts.state ?? (c.state === 'PAID' ? 'paid' : 'pending');
      const orderStatus = { paid: 'PAID', pending: 'NEW', failed: 'FAILED', expired: 'EXPIRED' }[
        state
      ];
      const amount = opts.amountMinor ?? c.amountMinor;
      return stub.notificationFor(providerRef, {
        orderStatus,
        paymentAmountMinor: state === 'paid' ? amount : 0,
        orderAmountMinor: amount,
        // An explicit delivery id changes a SIGNED field (the payment reference), as a genuinely
        // different Fawry delivery would.
        paymentRef: opts.eventId ?? c.paymentRef,
      });
    },
    webhookStates: ['pending', 'failed', 'expired'],
    badSignature: w => edit(w, b => void (b.messageSignature = 'deadbeef')),
    noSignature: w => edit(w, b => void delete b.messageSignature),
    tamperAmount: (w, amountMinor) =>
      edit(w, b => {
        b.paymentAmount = Number(minorToDecimalString(amountMinor));
        b.orderAmount = Number(minorToDecimalString(amountMinor));
      }),
    tamperStatus: w => edit(w, b => void (b.orderStatus = 'FAILED')),
    injectNextCall: (fault: StubFault) => stub.faults.injectNextCall(fault),
    providerPaymentCount: () => stub.createdCount,
  };
}
