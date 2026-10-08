/**
 * PROVIDERS-17 — Kashier confirm-before-apply.
 *
 * Kashier's webhook signature covers `data[signatureKeys]` but NOT the top-level `event`, so a
 * genuine signed delivery can be relabelled (`pay` -> `refund`, `authorize` -> `pay`). The
 * adapter asks Kashier's transaction-details API (developers.kashier.io, Transactions ->
 * Get transaction details, fetched 2026-10-08; example in
 * tests/contracts/kashier/transaction-details.official.response.json) and the payment pipeline
 * applies ONLY that answer. No real Kashier host is called.
 *
 * Paymob and FawryPay need no confirmation: every field that decides kind, status and amount
 * is inside their signature (asserted at the bottom, so a future adapter change that starts
 * reading an unsigned field has to touch this file).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createKashierProvider,
  kashierSignature,
  KASHIER_SIGNATURE_HEADER,
} from '@api/services/payment-providers/kashier.provider';
import {
  classifyKashierTransaction,
  KashierUnconfirmedError,
} from '@api/services/payment-providers/kashier-confirm';
import { V2ProviderBridge } from '@api/services/payment-providers/v2-bridge';
import {
  PAYMOB_HMAC_FIELDS,
  paymobProvider,
} from '@api/services/payment-providers/paymob.provider';
import { fawryProvider } from '@api/services/payment-providers/fawry.provider';
import type {
  PaymentProviderError,
  ProviderCredentials,
} from '@api/services/payment-providers/types';

const details = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../contracts/kashier/transaction-details.official.response.json'),
    'utf8'
  )
) as { body: Record<string, any>; message: string };

const creds: ProviderCredentials = {
  mode: 'sandbox',
  merchantId: 'MID-1-1',
  apiKey: 'kashier-payment-api-key',
  secretKey: 'kashier-secret-key',
  settings: { methods: ['card'], display: 'en' },
};

const ORDER = 'ORD-1042-3fa9c1d2b7';
const TXN = 'TX-243585751279';

/** The docs' example re-pointed at our order (`merchantOrderId` is ours) with one operation. */
function detailsFor(over: {
  transactionId?: string;
  merchantOrderId?: unknown;
  trxType?: string;
  operation?: string;
  status?: string;
}): unknown {
  const body = structuredClone(details.body);
  body.transactionId = over.transactionId ?? TXN;
  body.merchantOrderId = 'merchantOrderId' in over ? over.merchantOrderId : ORDER;
  if (over.trxType) body.trxType = over.trxType;
  if (over.status) body.status = over.status;
  body.transactions = [
    {
      ...body.transactions[0],
      transactionId: over.transactionId ?? TXN,
      operation: over.operation ?? 'pay',
      status: over.status ?? 'SUCCESS',
    },
  ];
  return { ...details, body };
}

function signed(event: string, status = 'SUCCESS', txn = TXN) {
  const data: Record<string, unknown> = {
    merchantOrderId: ORDER,
    transactionId: txn,
    status,
    amount: 250,
    currency: 'EGP',
    method: 'card',
    signatureKeys: ['amount', 'currency', 'merchantOrderId', 'method', 'status', 'transactionId'],
  };
  return {
    raw: JSON.stringify({ event, data }),
    headers: {
      [KASHIER_SIGNATURE_HEADER]: kashierSignature(
        data,
        data.signatureKeys as string[],
        creds.apiKey!
      ),
    },
  };
}

function fakeKashier(answer: (url: string) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answer(url);
    return new Response(JSON.stringify(a.body), {
      status: a.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const adapterWith = (answer: Parameters<typeof fakeKashier>[0]) => {
  const fake = fakeKashier(answer);
  return {
    fake,
    adapter: createKashierProvider({
      fetchImpl: fake.fetchImpl,
      baseUrls: { sandbox: 'https://kashier.test' },
    }),
  };
};

const errCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as PaymentProviderError).code;
  }
  return 'resolved';
};

describe('classifyKashierTransaction (the documented details shape)', () => {
  it("reads the docs' own example as a successful PAYMENT", () => {
    const r = classifyKashierTransaction(details, {
      transactionId: 'TX-243585751279',
      // The docs' example sends merchantOrderId as a NUMBER; compared as text.
      merchantOrderId: '71754213106',
    });
    expect(r).toEqual({ kind: 'payment', status: 'SUCCESS', operation: 'pay' });
  });

  it('a refund operation is a refund; authorize is an authorization', () => {
    expect(
      classifyKashierTransaction(detailsFor({ operation: 'refund', trxType: 'refund' }), {
        transactionId: TXN,
        merchantOrderId: ORDER,
      }).kind
    ).toBe('refund');
    expect(
      classifyKashierTransaction(detailsFor({ operation: 'authorize' }), {
        transactionId: TXN,
        merchantOrderId: ORDER,
      }).kind
    ).toBe('authorize');
  });

  it('INITIATED / UNKNOWN fold to PENDING; EXPIRED to FAILURE (docs: TransactionStatus)', () => {
    const at = (status: string) =>
      classifyKashierTransaction(detailsFor({ status }), {
        transactionId: TXN,
        merchantOrderId: ORDER,
      }).status;
    expect(at('INITIATED')).toBe('PENDING');
    expect(at('UNKNOWN')).toBe('PENDING');
    expect(at('EXPIRED')).toBe('FAILURE');
    expect(at('FAILURE')).toBe('FAILURE');
  });

  it('refuses anything that is not a clear match (never a guess)', () => {
    const expectUnconfirmed = (resp: unknown) =>
      expect(() =>
        classifyKashierTransaction(resp, { transactionId: TXN, merchantOrderId: ORDER })
      ).toThrow(KashierUnconfirmedError);
    expectUnconfirmed({});
    expectUnconfirmed({ body: [] });
    expectUnconfirmed(detailsFor({ transactionId: 'TX-other' }));
    expectUnconfirmed(detailsFor({ merchantOrderId: 'ORD-someone-else' }));
    expectUnconfirmed(detailsFor({ operation: 'mystery', trxType: 'mystery' }));
    expectUnconfirmed(detailsFor({ status: 'WHO_KNOWS' }));
  });

  it('a details answer without merchantOrderId is still matched on the signed transaction id', () => {
    expect(
      classifyKashierTransaction(detailsFor({ merchantOrderId: undefined }), {
        transactionId: TXN,
        merchantOrderId: ORDER,
      }).kind
    ).toBe('payment');
  });
});

describe('Kashier adapter confirmWebhookEvent', () => {
  it('asks GET /v2/aggregator/transactions/:id with the raw secret key, for the SIGNED transaction id', async () => {
    const { adapter, fake } = adapterWith(() => ({ status: 200, body: detailsFor({}) }));
    const w = signed('pay');
    const ev = adapter.verifyWebhook(w.raw, w.headers, creds);
    await adapter.confirmWebhookEvent!(ev, creds);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe(`https://kashier.test/v2/aggregator/transactions/${TXN}`);
    expect(fake.calls[0].init?.method).toBe('GET');
    expect((fake.calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      creds.secretKey
    );
  });

  it('a genuine PAY delivery relabelled REFUND is confirmed as the PAYMENT Kashier records', async () => {
    const { adapter } = adapterWith(() => ({
      status: 200,
      body: detailsFor({ operation: 'pay' }),
    }));
    const w = signed('refund');
    const ev = adapter.verifyWebhook(w.raw, w.headers, creds);
    expect(ev.kind).toBe('refund'); // what the delivery claims
    const c = await adapter.confirmWebhookEvent!(ev, creds);
    expect(c.mismatch).toBe(true);
    expect(c.claimed).toEqual({ kind: 'refund', status: 'completed' });
    expect(c.confirmed).toEqual({ kind: 'payment', status: 'completed' });
    expect(c.event).toMatchObject({
      kind: 'payment',
      status: 'completed',
      providerRef: ORDER,
      amountMinor: 25000, // the SIGNED amount is kept
      eventId: ev.eventId, // same dedupe key: the genuine delivery is a replay of this one
    });
  });

  it('an AUTHORIZE relabelled PAY is applied as processing (funds held), not completed', async () => {
    const { adapter } = adapterWith(() => ({
      status: 200,
      body: detailsFor({ operation: 'authorize' }),
    }));
    const w = signed('pay');
    const c = await adapter.confirmWebhookEvent!(
      adapter.verifyWebhook(w.raw, w.headers, creds),
      creds
    );
    expect(c.event).toMatchObject({ kind: 'payment', status: 'processing' });
    expect(c.mismatch).toBe(true);
  });

  it('a genuine refund is confirmed as a refund, with the stored status', async () => {
    const { adapter } = adapterWith(() => ({
      status: 200,
      body: detailsFor({ operation: 'refund', trxType: 'refund', status: 'PENDING' }),
    }));
    const w = signed('refund');
    const c = await adapter.confirmWebhookEvent!(
      adapter.verifyWebhook(w.raw, w.headers, creds),
      creds
    );
    expect(c.event).toMatchObject({ kind: 'refund', status: 'pending', refundRef: TXN });
    expect(c.mismatch).toBe(true); // the delivery said SUCCESS; Kashier's record is PENDING
  });

  it('cannot confirm -> throws (the caller applies nothing and the queue retries)', async () => {
    const w = signed('refund');
    for (const answer of [
      { status: 404, body: { message: 'not found' } }, // not indexed yet != did not happen
      { status: 503, body: {} },
      { status: 401, body: {} },
      { status: 200, body: detailsFor({ transactionId: 'TX-other' }) },
      { status: 200, body: { message: 'ok' } },
    ]) {
      const { adapter } = adapterWith(() => answer);
      const ev = adapter.verifyWebhook(w.raw, w.headers, creds);
      expect(await errCode(adapter.confirmWebhookEvent!(ev, creds))).not.toBe('resolved');
    }
  });

  it('through the bridge, a corrected delivery reaches the pipeline WITHOUT a refund field', async () => {
    const { adapter } = adapterWith(() => ({
      status: 200,
      body: detailsFor({ operation: 'pay' }),
    }));
    const bridge = new V2ProviderBridge(adapter, creds);
    const w = signed('refund');
    const claimed = bridge.verifyAndParseWebhook(w.raw, w.headers[KASHIER_SIGNATURE_HEADER]);
    expect(claimed.refund).toBeDefined();
    const out = await bridge.confirmWebhook!(claimed);
    expect(out.payload.refund).toBeUndefined();
    expect(out.payload.status).toBe('completed');
    expect(out.payload.transactionId).toBe(ORDER);
    expect(out.confirmation.mismatch).toBe(true);
  });
});

describe('Kashier payment session: customer.reference (required by the real API)', () => {
  const sessionBody = async (customer: {
    id?: string;
    name: string;
    email: string;
    phone?: string;
  }) => {
    const { adapter, fake } = adapterWith(() => ({
      status: 201,
      body: { _id: 'ks_1', sessionUrl: 'https://payments.kashier.test/s/1' },
    }));
    await adapter.createPayment(
      {
        orderId: '11111111-2222-4333-8444-555555555555',
        orderNumber: 'ORD-1042',
        amountMinor: 100,
        currency: 'EGP',
        customer,
        returnUrls: { success: 'https://shop.test/ok', failure: 'https://shop.test/fail' },
        idempotencyKey: `k-${Math.random()}`,
      },
      creds
    );
    return JSON.parse(String(fake.calls[0].init?.body)) as { customer: Record<string, unknown> };
  };

  it('a GUEST checkout (no customer id) sends a stable guest reference derived from the order, never PII', async () => {
    const body = await sessionBody({
      name: 'Mona Adel',
      email: 'mona@example.com',
      phone: '+201012345678',
    });
    expect(body.customer.reference).toBe('guest-11111111-2222-4333-8444-555555555555');
    expect(String(body.customer.reference)).not.toContain('mona');
    expect(String(body.customer.reference)).not.toContain('2010');
  });

  it('a signed-in customer sends their customer id', async () => {
    const body = await sessionBody({ id: 'cust-42', name: 'Mona', email: 'mona@example.com' });
    expect(body.customer.reference).toBe('cust-42');
  });
});

describe('Paymob and FawryPay: every money-deciding field is signed (no confirmation needed)', () => {
  it('Paymob HMAC covers the refund/void/success/pending/auth/capture flags, the amount and the order', () => {
    for (const f of [
      'amount_cents',
      'currency',
      'error_occured',
      'has_parent_transaction',
      'id',
      'is_auth',
      'is_capture',
      'is_refunded',
      'is_voided',
      'order.id',
      'pending',
      'success',
    ]) {
      expect(PAYMOB_HMAC_FIELDS).toContain(f);
    }
  });

  it('neither adapter implements confirmWebhookEvent; a Kashier bridge does', () => {
    expect(paymobProvider.confirmWebhookEvent).toBeUndefined();
    expect(fawryProvider.confirmWebhookEvent).toBeUndefined();
    expect(new V2ProviderBridge(paymobProvider, creds).confirmWebhook).toBeUndefined();
    expect(new V2ProviderBridge(createKashierProvider(), creds).confirmWebhook).toBeTypeOf(
      'function'
    );
  });
});
