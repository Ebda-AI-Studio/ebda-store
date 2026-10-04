/**
 * A local FawryPay stub: PayAtFawry reference numbers, hosted card redirect, status v2,
 * refund, and the v2 server notification with its body `messageSignature`. Amounts are
 * 2-decimal numbers like the real API, and the stub VERIFIES the SHA-256 request
 * signatures the adapter computes. It mirrors what the adapter ASSUMES; the unconfirmed
 * parts are `UNVERIFIED:` in the adapter and are checked against staging in 6c.
 */
import { toMinor, minorToDecimalString } from '@force/shared';
import {
  fawryChargeSignature,
  fawryNotificationSignature,
  fawryRefundSignature,
  fawryStatusSignature,
} from '@api/services/payment-providers/fawry.provider';
import type { ContractControl, SignedWebhook } from '../contract/payment-provider.contract';
import { FaultGate, json, readJson, type StubFault } from './stub-common';

export const FAWRY_STUB = {
  merchantCode: 'FAWRYSTUBMERCH',
  secureKey: 'fawry-stub-secure-key',
  baseUrl: 'https://fawry.stub.test',
} as const;

interface Charge {
  merchantRef: string;
  referenceNumber: string;
  method: string;
  amountMinor: number;
  state: 'UNPAID' | 'PAID' | 'FAILED' | 'EXPIRED' | 'CANCELED';
  refundedMinor: number;
  paymentRef?: string;
}

const okBody = (extra: Record<string, unknown> = {}) => ({
  type: 'ResponseDataModel',
  statusCode: 200,
  statusDescription: 'Operation done successfully',
  ...extra,
});

export class FawryStub {
  readonly charges = new Map<string, Charge>();
  readonly requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  readonly faults = new FaultGate();
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
    if (method === 'GET' && u.pathname === '/ECommerceWeb/Fawry/payments/status/v2')
      return this.status(body);
    if (method === 'POST' && u.pathname === '/ECommerceWeb/Fawry/payments/refund')
      return this.refund(body);
    return json(404, { message: 'not found' });
  };

  private bad = (description: string) =>
    json(200, { type: 'ResponseDataModel', statusCode: 9901, statusDescription: description });

  private charge(b: Record<string, unknown>): Response {
    if (b.merchantCode !== FAWRY_STUB.merchantCode) return this.bad('Invalid merchant code');
    const method = String(b.paymentMethod);
    if (method !== 'PAYATFAWRY' && method !== 'CARD') return this.bad('Invalid payment method');
    if (typeof b.amount !== 'number' || b.amount <= 0 || b.currencyCode !== 'EGP') {
      return this.bad('Invalid amount');
    }
    const amountMinor = toMinor(String(b.amount));
    const expected = fawryChargeSignature(
      {
        merchantCode: FAWRY_STUB.merchantCode,
        merchantRefNum: String(b.merchantRefNum),
        paymentMethod: method,
        amountMinor,
        returnUrl: String(b.returnUrl ?? ''),
      },
      FAWRY_STUB.secureKey
    );
    if (b.signature !== expected) return this.bad('Invalid signature');
    const items = (b.chargeItems as Array<{ price: number; quantity: number }> | undefined) ?? [];
    const total = items.reduce((n, i) => n + toMinor(String(i.price)) * i.quantity, 0);
    if (total !== amountMinor) return this.bad('Charge items do not add up to the amount');
    const c: Charge = {
      merchantRef: String(b.merchantRefNum),
      referenceNumber: String(9_310_000_000 + ++this.seq),
      method,
      amountMinor,
      state: 'UNPAID',
      refundedMinor: 0,
    };
    this.charges.set(c.merchantRef, c);
    return json(
      200,
      okBody({
        type: 'ChargeResponse',
        referenceNumber: c.referenceNumber,
        merchantRefNumber: c.merchantRef,
        expirationTime: Number(b.paymentExpiry),
        paymentStatus: 'UNPAID',
        paymentMethod: method,
        amount: b.amount,
        ...(method === 'CARD'
          ? { nextAction: { redirectUrl: `https://fawry.stub.test/3ds/${c.referenceNumber}` } }
          : {}),
      })
    );
  }

  private status(q: Record<string, unknown>): Response {
    if (q.merchantCode !== FAWRY_STUB.merchantCode) return this.bad('Invalid merchant code');
    if (
      q.signature !==
      fawryStatusSignature(
        FAWRY_STUB.merchantCode,
        String(q.merchantRefNumber),
        FAWRY_STUB.secureKey
      )
    ) {
      return this.bad('Invalid signature');
    }
    const c = this.charges.get(String(q.merchantRefNumber));
    if (!c) return this.bad('Order not found');
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
    return json(
      200,
      okBody({
        type: 'PaymentStatusResponse',
        referenceNumber: c.referenceNumber,
        merchantRefNumber: c.merchantRef,
        orderAmount: Number(minorToDecimalString(c.amountMinor)),
        paymentAmount: c.state === 'PAID' ? Number(minorToDecimalString(c.amountMinor)) : 0,
        refundedAmount: Number(minorToDecimalString(c.refundedMinor)),
        paymentMethod: c.method,
        orderStatus,
        paymentTime: c.state === 'PAID' ? 1_790_000_000_000 : undefined,
      })
    );
  }

  private refund(b: Record<string, unknown>): Response {
    if (b.merchantCode !== FAWRY_STUB.merchantCode) return this.bad('Invalid merchant code');
    const c = [...this.charges.values()].find(x => x.referenceNumber === String(b.referenceNumber));
    if (!c) return this.bad('Order not found');
    if (typeof b.refundAmount !== 'number' || b.refundAmount <= 0)
      return this.bad('Invalid refund amount');
    const amount = toMinor(String(b.refundAmount));
    const sig = fawryRefundSignature(
      FAWRY_STUB.merchantCode,
      c.referenceNumber,
      amount,
      String(b.reason ?? ''),
      FAWRY_STUB.secureKey
    );
    if (b.signature !== sig) return this.bad('Invalid signature');
    if (c.state !== 'PAID') return this.bad('Order is not paid');
    if (amount > c.amountMinor - c.refundedMinor)
      return this.bad('Refund amount exceeds the paid amount');
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
    const sig = fawryNotificationSignature(
      {
        fawryRefNumber: c.referenceNumber,
        merchantRefNumber: c.merchantRef,
        orderStatus: o.orderStatus,
        paymentMethod: c.method,
        paymentAmountMinor: o.paymentAmountMinor,
        orderAmountMinor,
        paymentRefrenceNumber: o.paymentRef,
      },
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
