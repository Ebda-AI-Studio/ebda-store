/**
 * Kashier adapter vs Kashier's OFFICIAL docs (developers.kashier.io, fetched 2026-10-07).
 * Fixtures under tests/contracts/kashier/ are the docs' verbatim JSON (values in the webhook
 * fixture match the docs' worked signature vector). No real Kashier host is ever called: every
 * request goes to an in-process fetch.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createKashierProvider,
  kashierSignature,
  kashierSignaturePayload,
  KASHIER_SIGNATURE_HEADER,
} from '@api/services/payment-providers/kashier.provider';
import type {
  PaymentProviderError,
  ProviderCredentials,
} from '@api/services/payment-providers/types';
import { baseRequest } from '../contract/payment-provider.contract';
import { KashierStub, KASHIER_STUB } from '../stubs/kashier-stub';

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/kashier', name), 'utf8')) as Record<
    string,
    any
  >;

const DOC_KEY = '11111';
const DOC_STRING =
  'amount=1&channel=online%20%7C%20e-commerce&currency=EGP&kashierOrderId=9ad06b17-755b-4e21-9774-aff3e2726ac9&merchantOrderId=1653481557813&method=card&orderReference=TEST-ORD-38855&status=SUCCESS&transactionId=TX-249893963&transactionResponseCode=00';
const DOC_HMAC = '9610477b2255b2a8ef84fd89adfaa5f1305ff9c20324205851890f1ea03109f4';

const creds: ProviderCredentials = {
  mode: 'sandbox',
  merchantId: KASHIER_STUB.merchantId,
  apiKey: KASHIER_STUB.apiKey,
  secretKey: KASHIER_STUB.secretKey,
  settings: { methods: ['card', 'wallet'], display: 'en' },
};
const docCreds: ProviderCredentials = { ...creds, apiKey: DOC_KEY };

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as PaymentProviderError).code;
  }
  return 'resolved';
};
const sync = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as PaymentProviderError).code;
  }
  return 'returned';
};
const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}
/** A canned transport: records every call, answers via `answer`. */
function transport(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetchImpl };
}

const savedEnv = process.env.KASHIER_BASE_URL;
beforeEach(() => {
  delete process.env.KASHIER_BASE_URL;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.KASHIER_BASE_URL;
  else process.env.KASHIER_BASE_URL = savedEnv;
});

// ---------------------------------------------------------------------------------------------
// (a) the docs' worked signature vector
// ---------------------------------------------------------------------------------------------
describe('documented signature vector', () => {
  const official = fixture('webhook-pay.official.json');
  const hdr = fixture('webhook-pay.official.headers.json');

  it('builds the documented string from the documented data and signs it to the documented HMAC', () => {
    const { data } = official;
    expect(kashierSignaturePayload(data, data.signatureKeys)).toBe(DOC_STRING);
    expect(kashierSignature(data, data.signatureKeys, DOC_KEY)).toBe(DOC_HMAC);
    // The fixture header file carries the same documented value.
    expect(hdr['x-kashier-signature']).toBe(DOC_HMAC);
    expect(hdr.key).toBe(DOC_KEY);
    // Independent of our implementation: Node's own HMAC over the documented string.
    expect(crypto.createHmac('sha256', DOC_KEY).update(DOC_STRING).digest('hex')).toBe(DOC_HMAC);
  });

  it('sorts keys ordinally regardless of the order the payload lists them', () => {
    const { data } = official;
    const shuffled = [...data.signatureKeys].reverse();
    expect(kashierSignaturePayload(data, shuffled)).toBe(DOC_STRING);
  });
});

// ---------------------------------------------------------------------------------------------
// (b) verifyWebhook on the documented payload + mutations
// ---------------------------------------------------------------------------------------------
describe('verifyWebhook: documented payload', () => {
  const p = createKashierProvider();
  const raw = () =>
    fs.readFileSync(path.join(__dirname, '../contracts/kashier/webhook-pay.official.json'), 'utf8');
  const headers = { [KASHIER_SIGNATURE_HEADER]: DOC_HMAC };
  const mutated = (
    fn: (d: Record<string, any>) => void,
    hdrs: Record<string, string> = headers
  ) => {
    const body = JSON.parse(raw());
    fn(body.data);
    return sync(() => p.verifyWebhook(JSON.stringify(body), hdrs, docCreds));
  };

  it('accepts it: payment, completed, 1.00 EGP -> 100 piastres, id bound to transaction + status', () => {
    const ev = p.verifyWebhook(raw(), headers, docCreds);
    expect(ev.kind).toBe('payment');
    if (ev.kind !== 'payment') return;
    expect(ev.status).toBe('completed');
    expect(ev.amountMinor).toBe(100);
    expect(ev.providerRef).toBe('1653481557813');
    expect(ev.eventId).toBe('kashier:TX-249893963:SUCCESS');
    expect(ev.method).toBe('card');
  });

  it('is case-insensitive on the hex and tolerates the upper-case header name', () => {
    const ev = p.verifyWebhook(raw(), { 'X-Kashier-Signature': DOC_HMAC.toUpperCase() }, docCreds);
    expect(ev.kind).toBe('payment');
  });

  it('MUTATION: a changed amount, status, merchantOrderId or transactionId is WEBHOOK_BAD_SIGNATURE', () => {
    expect(mutated(d => (d.amount = 2))).toBe('WEBHOOK_BAD_SIGNATURE');
    expect(mutated(d => (d.status = 'FAILURE'))).toBe('WEBHOOK_BAD_SIGNATURE');
    expect(mutated(d => (d.merchantOrderId = '1653481557814'))).toBe('WEBHOOK_BAD_SIGNATURE');
    expect(mutated(d => (d.transactionId = 'TX-249893964'))).toBe('WEBHOOK_BAD_SIGNATURE');
  });

  it.each(['merchantOrderId', 'amount', 'currency', 'status', 'transactionId'])(
    'MUTATION: dropping %s from signatureKeys is refused even when re-signed with the right key',
    key => {
      const body = JSON.parse(raw());
      body.data.signatureKeys = body.data.signatureKeys.filter((k: string) => k !== key);
      const sig = kashierSignature(body.data, body.data.signatureKeys, DOC_KEY);
      expect(
        sync(() =>
          p.verifyWebhook(JSON.stringify(body), { [KASHIER_SIGNATURE_HEADER]: sig }, docCreds)
        )
      ).toBe('WEBHOOK_BAD_SIGNATURE');
    }
  );

  it('MUTATION: one flipped hex character is WEBHOOK_BAD_SIGNATURE', () => {
    const flipped = (DOC_HMAC[0] === 'a' ? 'b' : 'a') + DOC_HMAC.slice(1);
    expect(
      sync(() => p.verifyWebhook(raw(), { [KASHIER_SIGNATURE_HEADER]: flipped }, docCreds))
    ).toBe('WEBHOOK_BAD_SIGNATURE');
  });

  it('a different Payment API key does not verify (the key is the Payment API key, not the secret)', () => {
    expect(sync(() => p.verifyWebhook(raw(), headers, { ...docCreds, apiKey: 'other' }))).toBe(
      'WEBHOOK_BAD_SIGNATURE'
    );
    expect(sync(() => p.verifyWebhook(raw(), headers, { ...creds, apiKey: undefined }))).toBe(
      'WEBHOOK_BAD_SIGNATURE'
    );
  });

  it("RFC 3986 encoding matters: ( ) ! * ' and | and space are percent-encoded", () => {
    const data = { v: "a (b)|c d!e*f'g" };
    // encodeURIComponent alone would leave ( ) ! * ' raw.
    expect(kashierSignaturePayload(data, ['v'])).toBe('v=a%20%28b%29%7Cc%20d%21e%2Af%27g');

    // A delivery signed with the NAIVE encoding (encodeURIComponent only) is refused, the
    // RFC 3986 one is accepted: the difference is observable end to end.
    const body = JSON.parse(raw());
    body.data.method = 'card (visa)';
    const naive = crypto
      .createHmac('sha256', DOC_KEY)
      .update(
        [...body.data.signatureKeys]
          .sort()
          .map((k: string) => `${k}=${encodeURIComponent(String(body.data[k]))}`)
          .join('&')
      )
      .digest('hex');
    const rfc = kashierSignature(body.data, body.data.signatureKeys, DOC_KEY);
    expect(naive).not.toBe(rfc);
    const send = (sig: string) =>
      sync(() =>
        p.verifyWebhook(JSON.stringify(body), { [KASHIER_SIGNATURE_HEADER]: sig }, docCreds)
      );
    expect(send(naive)).toBe('WEBHOOK_BAD_SIGNATURE');
    expect(send(rfc)).toBe('returned');
  });

  it('a refund event on a signed delivery is a refund; the id ignores `event` so a relabel dedupes', () => {
    const body = JSON.parse(raw());
    body.event = 'partial_refund';
    const ev = p.verifyWebhook(JSON.stringify(body), headers, docCreds);
    expect(ev.kind).toBe('refund');
    if (ev.kind !== 'refund') return;
    expect(ev.refundRef).toBe('TX-249893963');
    expect(ev.amountMinor).toBe(100);
    expect(ev.eventId).toBe('kashier:TX-249893963:SUCCESS');
  });

  it('maps transaction status SUCCESS|FAILURE|PENDING; an unknown status is malformed', () => {
    const run = (status: string) => {
      const body = JSON.parse(raw());
      body.data.status = status;
      const sig = kashierSignature(body.data, body.data.signatureKeys, DOC_KEY);
      return () =>
        p.verifyWebhook(JSON.stringify(body), { [KASHIER_SIGNATURE_HEADER]: sig }, docCreds);
    };
    expect((run('FAILURE')() as any).status).toBe('failed');
    expect((run('PENDING')() as any).status).toBe('pending');
    expect(sync(run('PAID'))).toBe('WEBHOOK_MALFORMED');
  });
});

// ---------------------------------------------------------------------------------------------
// (c) create session
// ---------------------------------------------------------------------------------------------
describe('create session vs the documented example', () => {
  const documented = fixture('session-create.official.request.json');
  const REQUIRED = [
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
  ];

  it('POSTs the documented shape: required fields, string amount, Authorization + api-key', async () => {
    const stub = new KashierStub();
    const p = createKashierProvider({
      fetchImpl: stub.fetch,
      baseUrls: { sandbox: KASHIER_STUB.baseUrl },
    });
    const res = await p.createPayment(
      baseRequest({ amountMinor: 10_000, webhookUrl: 'https://api.example/hook' }),
      creds
    );
    const sent = stub.requests.find(r => r.path === '/v3/payment/sessions')!;
    expect(sent.method).toBe('POST');
    for (const f of REQUIRED) expect(sent.body, f).toHaveProperty(f);
    // every field we send is a documented request field
    for (const f of Object.keys(sent.body)) expect(Object.keys(documented), f).toContain(f);
    expect(sent.body.amount).toBe('100.00');
    expect(typeof sent.body.amount).toBe('string');
    expect(sent.body.currency).toBe('EGP');
    expect(sent.body.type).toBe('one-time');
    expect(sent.body.maxFailureAttempts).toBe(3);
    expect(sent.body.allowedMethods).toBe('card,wallet');
    expect(sent.body.failureRedirect).toBe(false);
    expect(sent.body.serverWebhook).toBe('https://api.example/hook');
    expect(sent.body.merchantId).toBe(KASHIER_STUB.merchantId);
    expect(sent.body.order).toBe(res.providerRef);
    expect(new Date(sent.body.expireAt).toISOString()).toBe(sent.body.expireAt);
    expect(new Date(sent.body.expireAt).getTime()).toBeGreaterThan(Date.now());
    expect(sent.headers.authorization).toBe(KASHIER_STUB.secretKey); // raw, no Bearer
    expect(sent.headers['api-key']).toBe(KASHIER_STUB.apiKey);
  });

  it('uses req.expiresAt as expireAt when given', async () => {
    const stub = new KashierStub();
    const p = createKashierProvider({
      fetchImpl: stub.fetch,
      baseUrls: { sandbox: KASHIER_STUB.baseUrl },
    });
    const at = new Date(Date.now() + 5 * 3_600_000);
    await p.createPayment(baseRequest({ expiresAt: at }), creds);
    expect(stub.requests[0].body.expireAt).toBe(at.toISOString());
  });

  it('parses the documented response: session _id -> invoiceId, our order -> providerRef, sessionUrl -> redirect', async () => {
    const t = transport(() => jsonRes(201, fixture('session-create.official.response.json')));
    const p = createKashierProvider({ fetchImpl: t.fetchImpl });
    const res = await p.createPayment(baseRequest({ amountMinor: 10_000 }), creds);
    expect(res.invoiceId).toBe('67adc07584f10c00121f6739');
    expect(res.instruction).toMatchObject({
      kind: 'redirect',
      url: 'https://payments.kashier.io/session/67adc07584f10c00121f6739?mode=test',
    });
    expect(res.providerRef).toBe(JSON.parse(JSON.stringify(t.calls[0].body.order)));
    expect(res.amountMinor).toBe(10_000);
    expect(res.status).toBe('pending');
  });

  it('the api-key header matters: a wrong one is refused (PROVIDER_MISCONFIGURED)', async () => {
    const stub = new KashierStub();
    const p = createKashierProvider({
      fetchImpl: stub.fetch,
      baseUrls: { sandbox: KASHIER_STUB.baseUrl },
    });
    expect(await code(p.createPayment(baseRequest(), { ...creds, apiKey: 'wrong' }))).toBe(
      'PROVIDER_MISCONFIGURED'
    );
  });

  it('hosts: sessions on the dashboard host (test- vs live), never the FEP host', async () => {
    const t = transport(() => jsonRes(201, fixture('session-create.official.response.json')));
    const p = createKashierProvider({ fetchImpl: t.fetchImpl });
    await p.createPayment(baseRequest({ idempotencyKey: 'h1' }), creds);
    await p.createPayment(baseRequest({ idempotencyKey: 'h2' }), { ...creds, mode: 'live' });
    expect(t.calls[0].url).toBe('https://test-api.kashier.io/v3/payment/sessions');
    expect(t.calls[1].url).toBe('https://api.kashier.io/v3/payment/sessions');
  });
});

// ---------------------------------------------------------------------------------------------
// getStatus: order search
// ---------------------------------------------------------------------------------------------
describe('getStatus: GET /v3/payment/orders?search=', () => {
  const entry = (merchantOrderId: string, status = 'CAPTURED') => ({
    merchantOrderId,
    orderId: crypto.randomUUID(),
    status,
  });
  const search = (data: unknown[]) =>
    transport(() => jsonRes(200, { status: 'SUCCESS', data, pagination: { page: 1, pages: 1 } }));

  it('searches the dashboard host with Authorization only and picks the EXACT merchantOrderId', async () => {
    const t = search([entry('ORD-1-aaaaaaaaaa9', 'FAILED'), entry('ORD-1-aaaaaaaaaa', 'CAPTURED')]);
    const p = createKashierProvider({ fetchImpl: t.fetchImpl });
    const st = await p.getStatus('ORD-1-aaaaaaaaaa', creds);
    expect(st.status).toBe('completed'); // not the look-alike's FAILED
    expect(t.calls[0].method).toBe('GET');
    expect(t.calls[0].url).toBe(
      'https://test-api.kashier.io/v3/payment/orders?search=ORD-1-aaaaaaaaaa&page=1'
    );
    expect(t.calls[0].headers.authorization).toBe(KASHIER_STUB.secretKey);
    expect(t.calls[0].headers['api-key']).toBeUndefined();
  });

  it('no exact match (only look-alikes) or an empty list is PAYMENT_NOT_FOUND', async () => {
    const p1 = createKashierProvider({ fetchImpl: search([entry('ORD-1-aaaaaaaaaa9')]).fetchImpl });
    expect(await code(p1.getStatus('ORD-1-aaaaaaaaaa', creds))).toBe('PAYMENT_NOT_FOUND');
    const p2 = createKashierProvider({ fetchImpl: search([]).fetchImpl });
    expect(await code(p2.getStatus('ORD-1-aaaaaaaaaa', creds))).toBe('PAYMENT_NOT_FOUND');
  });

  it.each([
    ['INITIATED', 'pending'],
    ['CAPTURED', 'completed'],
    ['AUTHORIZED', 'processing'],
    ['FAILED', 'failed'],
    ['REJECTED', 'failed'],
    ['CANCELLED', 'cancelled'],
    ['REVERSED', 'cancelled'],
    ['EXPIRED', 'expired'],
  ])('OrderStatus %s -> %s', async (status, expected) => {
    const p = createKashierProvider({ fetchImpl: search([entry('X-1', status)]).fetchImpl });
    expect((await p.getStatus('X-1', creds)).status).toBe(expected);
  });

  it('the documented projection has NO amounts: they are reported as 0, never invented', async () => {
    const t = transport(() => jsonRes(200, fixture('order-search.official.response.json')));
    const p = createKashierProvider({ fetchImpl: t.fetchImpl });
    const st = await p.getStatus('ORDER-12345', creds);
    expect(st).toMatchObject({
      status: 'completed',
      amountMinor: 0,
      capturedMinor: 0,
      refundedMinor: 0,
      amountsKnown: false, // #625: the zeros are placeholders, flagged so no caller reads them as money
    });
  });
});

// ---------------------------------------------------------------------------------------------
// (d) refund
// ---------------------------------------------------------------------------------------------
describe('refund: PUT /v3/orders/:kashierOrderId on the FEP host', () => {
  const KASHIER_ORDER = '00916dc7-7a3a-4875-af44-118bc678378b';
  const docTransport = (
    refundResponse: () => Response = () => jsonRes(200, fixture('refund.official.response.json'))
  ) =>
    transport(c =>
      c.method === 'GET'
        ? jsonRes(200, fixture('order-search.official.response.json'))
        : refundResponse()
    );

  it('partial: sends REFUND with a JSON NUMBER amount, Authorization only, to the order uuid', async () => {
    const t = docTransport();
    const p = createKashierProvider({ fetchImpl: t.fetchImpl });
    const r = await p.partialRefund(
      { providerRef: 'ORDER-12345', idempotencyKey: 'r1', amountMinor: 1_000, reason: 'damaged' },
      creds
    );
    const put = t.calls.find(c => c.method === 'PUT')!;
    expect(put.url).toBe(`https://test-fep.kashier.io/v3/orders/${KASHIER_ORDER}`);
    expect(put.headers.authorization).toBe(KASHIER_STUB.secretKey);
    expect(put.headers['api-key']).toBeUndefined();
    expect(put.body).toEqual({
      apiOperation: 'REFUND',
      reason: 'damaged',
      transaction: { amount: 10 },
    });
    expect(typeof put.body.transaction.amount).toBe('number');
    expect(r).toEqual({
      refundRef: 'TX-69827599',
      status: 'completed',
      amountMinor: 1_000,
      refundedTotalMinor: 1_000, // response.payload.order.totalRefundedAmount (10)
    });
  });

  it('a decimal partial amount is exact: 1029 piastres -> 10.29 (no float drift)', async () => {
    const t = docTransport();
    const p = createKashierProvider({ fetchImpl: t.fetchImpl });
    await p.partialRefund(
      { providerRef: 'ORDER-12345', idempotencyKey: 'r2', amountMinor: 1_029 },
      creds
    );
    expect(t.calls.find(c => c.method === 'PUT')!.body.transaction.amount).toBe(10.29);
  });

  it('full refund with unknown remainder omits transaction.amount and reads the amount from the response', async () => {
    const t = docTransport();
    const p = createKashierProvider({ fetchImpl: t.fetchImpl });
    const r = await p.refund({ providerRef: 'ORDER-12345', idempotencyKey: 'r3' }, creds);
    const put = t.calls.find(c => c.method === 'PUT')!;
    expect(put.body).toEqual({ apiOperation: 'REFUND', reason: 'refund' });
    expect(r.amountMinor).toBe(1_000);
    expect(r.refundedTotalMinor).toBe(1_000);
  });

  it('PENDING is a pending refund; FAILURE is PROVIDER_REJECTED', async () => {
    const mk = (status: string) =>
      createKashierProvider({
        fetchImpl: docTransport(() =>
          jsonRes(200, { ...fixture('refund.official.response.json'), status })
        ).fetchImpl,
      });
    const pending = await mk('PENDING').partialRefund(
      { providerRef: 'ORDER-12345', idempotencyKey: 'r4', amountMinor: 500 },
      creds
    );
    expect(pending.status).toBe('pending');
    expect(
      await code(
        mk('FAILURE').partialRefund(
          { providerRef: 'ORDER-12345', idempotencyKey: 'r5', amountMinor: 500 },
          creds
        )
      )
    ).toBe('PROVIDER_REJECTED');
  });

  it('an order that is not captured cannot be refunded; an unknown order is PAYMENT_NOT_FOUND', async () => {
    const pending = createKashierProvider({
      fetchImpl: transport(() =>
        jsonRes(200, {
          data: [{ merchantOrderId: 'A-1', orderId: KASHIER_ORDER, status: 'INITIATED' }],
        })
      ).fetchImpl,
    });
    expect(await code(pending.refund({ providerRef: 'A-1', idempotencyKey: 'r6' }, creds))).toBe(
      'PAYMENT_NOT_CAPTURED'
    );
    const none = createKashierProvider({
      fetchImpl: transport(() => jsonRes(200, { data: [] })).fetchImpl,
    });
    expect(await code(none.refund({ providerRef: 'A-2', idempotencyKey: 'r7' }, creds))).toBe(
      'PAYMENT_NOT_FOUND'
    );
  });

  it('live mode refunds on fep.kashier.io', async () => {
    const t = docTransport();
    const p = createKashierProvider({ fetchImpl: t.fetchImpl });
    await p.partialRefund(
      { providerRef: 'ORDER-12345', idempotencyKey: 'r8', amountMinor: 100 },
      { ...creds, mode: 'live' }
    );
    expect(t.calls.find(c => c.method === 'PUT')!.url).toBe(
      `https://fep.kashier.io/v3/orders/${KASHIER_ORDER}`
    );
    expect(t.calls[0].url.startsWith('https://api.kashier.io/v3/payment/orders?search=')).toBe(
      true
    );
  });

  it('end to end on the stub: partial then full, running total from Kashier', async () => {
    const stub = new KashierStub();
    const p = createKashierProvider({
      fetchImpl: stub.fetch,
      baseUrls: { sandbox: KASHIER_STUB.baseUrl },
    });
    const c = await p.createPayment(baseRequest({ amountMinor: 9_000 }), creds);
    stub.capture(c.providerRef);
    const a = await p.partialRefund(
      { providerRef: c.providerRef, idempotencyKey: 'e1', amountMinor: 2_500 },
      creds
    );
    expect(a.refundedTotalMinor).toBe(2_500);
    const b = await p.refund({ providerRef: c.providerRef, idempotencyKey: 'e2' }, creds);
    expect(b.amountMinor).toBe(6_500);
    expect(b.refundedTotalMinor).toBe(9_000);
  });

  it('stub without amounts in the search: a partial still goes through (Kashier enforces the bound)', async () => {
    const stub = new KashierStub();
    stub.emitAmounts = false;
    const p = createKashierProvider({
      fetchImpl: stub.fetch,
      baseUrls: { sandbox: KASHIER_STUB.baseUrl },
    });
    const c = await p.createPayment(baseRequest({ amountMinor: 5_000 }), creds);
    stub.capture(c.providerRef);
    const st = await p.getStatus(c.providerRef, creds);
    expect(st).toMatchObject({ status: 'completed', capturedMinor: 0 });
    const full = await p.refund({ providerRef: c.providerRef, idempotencyKey: 'u1' }, creds);
    expect(full.amountMinor).toBe(5_000);
    expect(stub.requests.find(r => r.method === 'PUT')!.body.transaction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// (e) testConnection
// ---------------------------------------------------------------------------------------------
describe('testConnection: POST /v2/merchants/validate-credentials', () => {
  const ok = () => transport(() => jsonRes(200, {}));

  it('sends ONE call with Authorization: <secret> and the mode-tagged key lists', async () => {
    const t = ok();
    const p = createKashierProvider({ fetchImpl: t.fetchImpl });
    const r = await p.testConnection!(creds);
    expect(r).toMatchObject({ ok: true, code: 'ok' });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe('https://test-api.kashier.io/v2/merchants/validate-credentials');
    expect(t.calls[0].method).toBe('POST');
    expect(t.calls[0].headers.authorization).toBe(KASHIER_STUB.secretKey);
    expect(t.calls[0].body).toEqual({
      secretKeys: [{ mode: 'test', key: KASHIER_STUB.secretKey }],
      apiKeys: [{ mode: 'test', key: KASHIER_STUB.apiKey }],
    });
    const live = ok();
    await createKashierProvider({ fetchImpl: live.fetchImpl }).testConnection!({
      ...creds,
      mode: 'live',
    });
    expect(live.calls[0].url).toBe('https://api.kashier.io/v2/merchants/validate-credentials');
    expect(live.calls[0].body.secretKeys[0].mode).toBe('live');
    expect(live.calls[0].body.apiKeys[0].mode).toBe('live');
  });

  it('incomplete: any missing credential sends nothing', async () => {
    for (const miss of ['merchantId', 'secretKey', 'apiKey'] as const) {
      const t = ok();
      const r = await createKashierProvider({ fetchImpl: t.fetchImpl }).testConnection!({
        ...creds,
        [miss]: undefined,
      });
      expect(r).toMatchObject({ ok: false, code: 'incomplete' });
      expect(t.calls).toHaveLength(0);
    }
  });

  it('MUTATION: the MID pattern decides whether anything is sent', async () => {
    const bad = [
      'MID-12',
      'mid-1-2',
      'MID-1-a',
      'MID--1',
      'MID-1-2-3',
      ' MID-1-2',
      '1-2',
      'MID-1-2\n',
    ];
    for (const merchantId of bad) {
      const t = ok();
      const r = await createKashierProvider({ fetchImpl: t.fetchImpl }).testConnection!({
        ...creds,
        merchantId,
      });
      expect(r.code, merchantId).toBe('incomplete');
      expect(t.calls, merchantId).toHaveLength(0);
    }
    for (const merchantId of ['MID-1-1', 'MID-1007-931', 'MID-12345-6']) {
      const t = ok();
      const r = await createKashierProvider({ fetchImpl: t.fetchImpl }).testConnection!({
        ...creds,
        merchantId,
      });
      expect(r.code, merchantId).toBe('ok');
      expect(t.calls, merchantId).toHaveLength(1);
    }
  });

  it('401 / 403 are bad_credentials; 5xx, timeout and a dead network are unreachable; other 4xx unknown', async () => {
    for (const status of [401, 403]) {
      const p = createKashierProvider({
        fetchImpl: transport(() => jsonRes(status, { message: 'no' })).fetchImpl,
      });
      expect((await p.testConnection!(creds)).code).toBe('bad_credentials');
    }
    const p5 = createKashierProvider({ fetchImpl: transport(() => jsonRes(503, {})).fetchImpl });
    expect((await p5.testConnection!(creds)).code).toBe('unreachable');
    const p4 = createKashierProvider({
      fetchImpl: transport(() => jsonRes(400, { message: 'x' })).fetchImpl,
    });
    expect((await p4.testConnection!(creds)).code).toBe('unknown');
    const stub = new KashierStub();
    stub.faults.injectNextCall('timeout');
    const pt = createKashierProvider({
      fetchImpl: stub.fetch,
      timeoutMs: 30,
      baseUrls: { sandbox: KASHIER_STUB.baseUrl },
    });
    expect((await pt.testConnection!(creds)).code).toBe('unreachable');
    stub.faults.injectNextCall('unavailable');
    expect((await pt.testConnection!(creds)).code).toBe('unreachable');
  });

  it('UNVERIFIED body shape: an explicit invalid flag is bad_credentials; an unknown body is still ok on 2xx', async () => {
    const bad = createKashierProvider({
      fetchImpl: transport(() => jsonRes(200, { apiKeys: [{ mode: 'test', valid: false }] }))
        .fetchImpl,
    });
    expect((await bad.testConnection!(creds)).code).toBe('bad_credentials');
    const odd = createKashierProvider({
      fetchImpl: transport(() => jsonRes(200, { whatever: 1 })).fetchImpl,
    });
    expect((await odd.testConnection!(creds)).code).toBe('ok');
  });

  it('never throws and never leaks a secret or a raw body into the message', async () => {
    const secretish = `leak-${KASHIER_STUB.secretKey}-${KASHIER_STUB.apiKey}`;
    const outcomes = [
      transport(() => jsonRes(401, { message: secretish })),
      transport(() => jsonRes(500, { message: secretish })),
      transport(() => jsonRes(400, { message: secretish })),
      transport(() => jsonRes(200, { valid: false, echo: secretish })),
    ];
    for (const t of outcomes) {
      const r = await createKashierProvider({ fetchImpl: t.fetchImpl }).testConnection!(creds);
      expect(JSON.stringify(r)).not.toContain(KASHIER_STUB.secretKey);
      expect(JSON.stringify(r)).not.toContain(KASHIER_STUB.apiKey);
      expect(JSON.stringify(r)).not.toContain('leak-');
    }
    const throwing = createKashierProvider({
      fetchImpl: async () => {
        throw new Error(`boom ${KASHIER_STUB.secretKey}`);
      },
    });
    const r = await throwing.testConnection!(creds);
    expect(r.code).toBe('unreachable');
    expect(JSON.stringify(r)).not.toContain(KASHIER_STUB.secretKey);
  });

  it('against the stub: right keys ok, wrong secret bad_credentials', async () => {
    const stub = new KashierStub();
    const p = createKashierProvider({
      fetchImpl: stub.fetch,
      baseUrls: { sandbox: KASHIER_STUB.baseUrl },
    });
    expect((await p.testConnection!(creds)).code).toBe('ok');
    expect((await p.testConnection!({ ...creds, secretKey: 'nope' })).code).toBe('bad_credentials');
    expect((await p.testConnection!({ ...creds, apiKey: 'nope' })).code).toBe('bad_credentials');
  });
});
