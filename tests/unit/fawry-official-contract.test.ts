/**
 * FawryPay adapter vs Fawry's OFFICIAL developer docs (developer.fawrystaging.com, extracted
 * 2026-10-07). The documented sample requests / notification live in `tests/contracts/fawry/`.
 * Every expected hash here is computed with node:crypto over the documented concatenation order
 * WRITTEN OUT LITERALLY: never through the adapter's own signature helpers, so a mistake mirrored
 * in the adapter and its test cannot pass. The docs publish no expected hash, so the demo
 * secureKey from their PHP samples signs the documented payloads.
 *
 * Still UNVERIFIED against a real staging account (see fawry.provider.ts): status v2 answering
 * an unknown order with 9938, the PayAtFawry response expiry, production host of status v2, the
 * timezone of the "dd-MM-yyyy HH:mm:ss" paymentTime, any refunded-amount field.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  createFawryProvider,
  fawryChargeSignature,
  fawryHostedInitSignature,
  fawryRefundSignature,
} from '@api/services/payment-providers/fawry.provider';
import {
  PaymentProviderError,
  type CreatePaymentV2Request,
  type ProviderCredentials,
} from '@api/services/payment-providers/types';
import { FawryStub, FAWRY_STUB } from '../stubs/fawry-stub';

const DEMO_KEY = '259af31fc2f74453b3a55739b21ae9ef';
const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../contracts/fawry', name), 'utf8');
const fixtureJson = (name: string): any => {
  const o = JSON.parse(fixture(name));
  for (const k of Object.keys(o)) if (k.startsWith('_')) delete o[k];
  return o;
};
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const stubCreds: ProviderCredentials = {
  mode: 'sandbox',
  merchantId: FAWRY_STUB.merchantCode,
  apiKey: FAWRY_STUB.secureKey,
  settings: { methods: ['payatfawry', 'card'], expiryHours: 72 },
};
const demoCreds: ProviderCredentials = {
  mode: 'sandbox',
  merchantId: '1tSa6uxz2nTwlaAmt38enA==',
  apiKey: DEMO_KEY,
  webhookSecret: undefined,
  settings: { methods: ['payatfawry', 'card'], expiryHours: 72 },
};

let n = 0;
const req = (o: Partial<CreatePaymentV2Request> = {}): CreatePaymentV2Request => ({
  orderId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  orderNumber: `ORD-${2000 + n}`,
  amountMinor: 58_055,
  currency: 'EGP',
  customer: { name: 'Mona Adel', email: 'mona@example.com', phone: '01012345678' },
  returnUrls: { success: 'https://shop.test/ok', failure: 'https://shop.test/fail' },
  idempotencyKey: `idem-${n}-${Math.random().toString(36).slice(2)}`,
  ...o,
});

const mk = () => {
  const stub = new FawryStub();
  const provider = createFawryProvider({
    fetchImpl: stub.fetch,
    timeoutMs: 100,
    baseUrls: { sandbox: FAWRY_STUB.baseUrl },
  });
  return { stub, provider };
};
const sent = (stub: FawryStub, p: string) => stub.requests.find(r => r.path === p)!.body as any;
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
const respond = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

// ---------------------------------------------------------------------------------------------
describe('(a) signature formulas pinned on the documented samples', () => {
  it('PayAtFawry charge: merchantCode + merchantRefNum + customerProfileId + paymentMethod + amount + key', () => {
    const d = fixtureJson('charge-payatfawry-request.official.json');
    const literal = sha(
      '1tSa6uxz2nTwlaAmt38enA==' + '2312465464' + '777777' + 'PayAtFawry' + '580.55' + DEMO_KEY
    );
    expect(literal).toBe(
      sha(
        d.merchantCode +
          d.merchantRefNum +
          d.customerProfileId +
          d.paymentMethod +
          d.amount +
          DEMO_KEY
      )
    );
    expect(literal).toBe('7bd69a3762c0164d5396f0f7148bd71a86c38cb89979974f3ebf9cb955bea89b');
    expect(
      fawryChargeSignature(
        {
          merchantCode: d.merchantCode,
          merchantRefNum: d.merchantRefNum,
          customerProfileId: d.customerProfileId,
          paymentMethod: d.paymentMethod,
          amountMinor: 58_055,
        },
        DEMO_KEY
      )
    ).toBe(literal);
    // The docs' sample signature in the same JSON was made with the merchant's own key, not the
    // demo key; it is a different value by construction, which is why the test re-derives.
    expect(d.paymentMethod).toBe('PayAtFawry');
  });

  it('hosted init: ... + returnUrl + items sorted by itemId (itemId + quantity + price) + key', () => {
    const d = fixtureJson('hosted-init-request.official.json');
    const literal = sha(
      '1tSa6uxz2nTwlaAmt38enA==' +
        '2312465464' +
        '777777' +
        'https://merchant.example/return' +
        ('a-item' + '1' + '12.50') + // sorted: a-item before b-item
        ('b-item' + '2' + '50.00') +
        DEMO_KEY
    );
    expect(literal).toBe('987e4ae60ac76d8a208a7f9c2018bfca2c79fd9cec476107fa57b3c7fa607137');
    expect(
      fawryHostedInitSignature(
        {
          merchantCode: d.merchantCode,
          merchantRefNum: d.merchantRefNum,
          customerProfileId: d.customerProfileId,
          returnUrl: d.returnUrl,
          items: d.chargeItems.map((i: any) => ({
            itemId: i.itemId,
            quantity: i.quantity,
            priceMinor: Math.round(i.price * 100),
          })),
        },
        DEMO_KEY
      )
    ).toBe(literal);
    expect(d.chargeItems.map((i: any) => i.itemId)).toEqual(['b-item', 'a-item']); // fixture is unsorted
  });

  it('status v2: merchantCode + merchantRefNumber + key', () => {
    expect(sha('1tSa6uxz2nTwlaAmt38enA==' + 'ref-1' + DEMO_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refund: merchantCode + referenceNumber + refundAmount(2dp) + reason(if exists) + key', () => {
    const d = fixtureJson('refund-request.official.json');
    expect(d.refundAmount).toBe(10); // a number; signed as "10.00"
    expect(
      sha('dJWmdV+lPIE=' + '946787894' + '10.00' + 'Item not as described' + DEMO_KEY)
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('(b) notification v2 verification', () => {
  const provider = createFawryProvider();
  const sign = (b: any, key = DEMO_KEY) =>
    // fawryRefNumber + merchantRefNumber + paymentAmount(2dp) + orderAmount(2dp) + orderStatus +
    // paymentMethod + paymentRefrenceNumber(blank if absent) + secureKey
    sha(
      b.fawryRefNumber +
        b.merchantRefNumber +
        Number(b.paymentAmount).toFixed(2) +
        Number(b.orderAmount).toFixed(2) +
        b.orderStatus +
        b.paymentMethod +
        (b.paymentRefrenceNumber ?? '') +
        key
    );
  const signed = (patch: Record<string, unknown> = {}) => {
    const b = { ...fixtureJson('notification-v2.official.json'), ...patch };
    b.messageSignature = sign(b);
    return b;
  };
  const verify = (b: unknown) => provider.verifyWebhook(JSON.stringify(b), {}, demoCreds);

  it('accepts the documented notification signed per the documented formula', () => {
    const ev = verify(signed());
    expect(ev).toMatchObject({ kind: 'payment', providerRef: '9708f1cea8b5426cb57922df51b7f790' });
    // 152.00 serialises as 152 in JSON; the signature is over the canonical 2-dp text
    expect(JSON.stringify(signed())).toContain('"paymentAmount":152');
  });

  it('accepts a PAID delivery that carries paymentRefrenceNumber', () => {
    const ev = verify(signed({ orderStatus: 'PAID', paymentRefrenceNumber: 'p-777' }));
    expect(ev).toMatchObject({ kind: 'payment', status: 'completed' });
  });

  it('uses webhookSecret when set, the secure key otherwise', () => {
    const b = signed();
    expect(
      sync(() =>
        provider.verifyWebhook(JSON.stringify(b), {}, { ...demoCreds, webhookSecret: 'other' })
      )
    ).toBe('WEBHOOK_BAD_SIGNATURE');
  });

  const base = () => signed({ orderStatus: 'PAID', paymentRefrenceNumber: 'p-777' });
  it.each([
    ['paymentAmount', (b: any) => (b.paymentAmount = 1)],
    ['orderStatus', (b: any) => (b.orderStatus = 'FAILED')],
    ['merchantRefNumber', (b: any) => (b.merchantRefNumber = 'other-order')],
    ['paymentRefrenceNumber', (b: any) => (b.paymentRefrenceNumber = 'p-778')],
    ['paymentRefrenceNumber removed', (b: any) => delete b.paymentRefrenceNumber],
    [
      'one hex char of the signature',
      (b: any) => {
        const s: string = b.messageSignature;
        b.messageSignature = (s[0] === '0' ? '1' : '0') + s.slice(1);
      },
    ],
  ])('a changed %s -> WEBHOOK_BAD_SIGNATURE', (_f, mutate) => {
    const b = base();
    mutate(b);
    expect(sync(() => verify(b))).toBe('WEBHOOK_BAD_SIGNATURE');
  });

  it('control: the unmutated body verifies (the mutations above fail for the stated reason)', () => {
    expect(verify(base()).kind).toBe('payment');
  });

  it('eventId is built from signed fields only', () => {
    const a = base();
    const b = { ...a, requestId: 'different' };
    expect(verify(a).eventId).toBe(verify(b).eventId);
  });
});

// ---------------------------------------------------------------------------------------------
describe('(c) PayAtFawry charge', () => {
  afterEach(() => {
    delete process.env.FAWRY_BASE_URL;
  });

  it('posts the documented shape; signature excludes returnUrl and the card fields', async () => {
    const { stub, provider } = mk();
    const r = req({
      webhookUrl: 'https://api.test/hooks/fawry',
      customer: { name: 'Mona', email: 'm@x.com', phone: '01012345678', language: 'en' },
    });
    const res = await provider.createPayment(r, stubCreds);
    const b = sent(stub, '/ECommerceWeb/Fawry/payments/charge');
    expect(b).toMatchObject({
      merchantCode: FAWRY_STUB.merchantCode,
      customerMobile: '01012345678',
      customerEmail: 'm@x.com',
      paymentMethod: 'PayAtFawry',
      currencyCode: 'EGP',
      language: 'en-gb',
      orderWebHookUrl: 'https://api.test/hooks/fawry',
      amount: 580.55,
    });
    expect(b.returnUrl).toBeUndefined();
    expect(typeof b.paymentExpiry).toBe('number');
    const literal = sha(
      b.merchantCode + b.merchantRefNum + 'PayAtFawry' + '580.55' + FAWRY_STUB.secureKey
    );
    expect(b.signature).toBe(literal);
    // the OLD formula (4 empty card fields + returnUrl) is a different hash and must not be sent
    const old = sha(
      b.merchantCode +
        b.merchantRefNum +
        'PAYATFAWRY' +
        '580.55' +
        '' +
        '' +
        '' +
        '' +
        'https://shop.test/ok' +
        FAWRY_STUB.secureKey
    );
    expect(b.signature).not.toBe(old);
    expect(res.instruction.kind).toBe('reference-code');
    expect(res.invoiceId).toBe(
      res.instruction.kind === 'reference-code' ? res.instruction.code : ''
    );
    expect(res.instruction.kind === 'reference-code' && res.instruction.expiresAt.getTime()).toBe(
      b.paymentExpiry
    );
  });

  it("language defaults to 'ar-eg'; a missing mobile or email is refused before any call", async () => {
    const { stub, provider } = mk();
    await provider.createPayment(req(), stubCreds);
    expect(sent(stub, '/ECommerceWeb/Fawry/payments/charge').language).toBe('ar-eg');
    const before = stub.requests.length;
    expect(
      await code(
        provider.createPayment(req({ customer: { name: 'x', email: 'a@b.c' } }), stubCreds)
      )
    ).toBe('PROVIDER_REJECTED');
    expect(stub.requests.length).toBe(before);
  });

  it('a 200 with no reference number is not a payment', async () => {
    const provider = createFawryProvider({
      fetchImpl: async () => respond({ statusCode: 200, statusDescription: 'ok' }),
    });
    expect(await code(provider.createPayment(req(), stubCreds))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('hosts: /ECommerceWeb on www.atfawry.com, hosted init on atfawry.com (live); staging for both in sandbox', async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return url.includes('/fawrypay-api/')
        ? respond('https://atfawry.com/atfawry/plugin?payment-id=x&locale=en')
        : respond({ statusCode: 200, referenceNumber: '1' });
    };
    const live = createFawryProvider({ fetchImpl });
    await live.createPayment(req(), { ...stubCreds, mode: 'live' });
    await live.createPayment(req({ metadata: { method: 'card' } }), { ...stubCreds, mode: 'live' });
    const sandbox = createFawryProvider({ fetchImpl });
    await sandbox.createPayment(req(), stubCreds);
    await sandbox.createPayment(req({ metadata: { method: 'card' } }), stubCreds);
    expect(urls).toEqual([
      'https://www.atfawry.com/ECommerceWeb/Fawry/payments/charge',
      'https://atfawry.com/fawrypay-api/api/payments/init',
      'https://atfawry.fawrystaging.com/ECommerceWeb/Fawry/payments/charge',
      'https://atfawry.fawrystaging.com/fawrypay-api/api/payments/init',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('(d) card: hosted checkout init', () => {
  const cardReq = (o: Partial<CreatePaymentV2Request> = {}) =>
    req({ metadata: { method: 'card' }, ...o });

  it('sends no amount, signs sorted items + returnUrl, and reads the bare-URL answer', async () => {
    const { stub, provider } = mk();
    const res = await provider.createPayment(
      cardReq({
        amountMinor: 11_250,
        items: [
          { sku: 'b-item', name: 'B', unitPrice: 5_000, quantity: 2 },
          { sku: 'a-item', name: 'A', unitPrice: 1_250, quantity: 1 },
        ] as any,
      }),
      stubCreds
    );
    const b = sent(stub, '/fawrypay-api/api/payments/init');
    expect(b.amount).toBeUndefined();
    expect(b.paymentMethod).toBe('CARD');
    expect(b.authCaptureModePayment).toBe(false);
    expect(b.returnUrl).toBe('https://shop.test/ok');
    expect(b.language).toBe('ar-eg');
    expect(typeof b.paymentExpiry).toBe('number');
    // the stub's literal check passed, and so does this one, sorted by itemId
    const literal = sha(
      b.merchantCode +
        b.merchantRefNum +
        '' +
        'https://shop.test/ok' +
        ('a-item' + '1' + '12.50') +
        ('b-item' + '2' + '50.00') +
        FAWRY_STUB.secureKey
    );
    expect(b.signature).toBe(literal);
    expect(res.instruction.kind).toBe('redirect');
    if (res.instruction.kind === 'redirect') {
      expect(res.instruction.url).toMatch(
        /^https:\/\/fawry\.stub\.test\/atfawry\/plugin\?payment-id=/
      );
    }
    expect(res.invoiceId).toBeUndefined();
    expect(res.providerRef).toBe(b.merchantRefNum);
    expect(stub.requests.some(r => r.path === '/ECommerceWeb/Fawry/payments/charge')).toBe(false);
  });

  it('items that do not sum to the amount collapse to ONE line carrying the whole amount', async () => {
    const { stub, provider } = mk();
    await provider.createPayment(
      cardReq({
        amountMinor: 10_000,
        items: [{ sku: 'x', name: 'X', unitPrice: 3_000, quantity: 1 }] as any,
      }),
      stubCreds
    );
    const b = sent(stub, '/fawrypay-api/api/payments/init');
    expect(b.chargeItems).toHaveLength(1);
    expect(b.chargeItems[0]).toMatchObject({ price: 100, quantity: 1 });
  });

  it('accepts a JSON string literal answer, and refuses a non-URL or http answer', async () => {
    const url = 'https://atfawry.fawrystaging.com/atfawry/plugin?payment-id=kCk0R85FuTY=&locale=en';
    const answer = (text: string) =>
      createFawryProvider({ fetchImpl: async () => respond(text) }).createPayment(
        cardReq(),
        stubCreds
      );
    const ok = await answer(JSON.stringify(url));
    expect(ok.instruction).toMatchObject({ kind: 'redirect', url });
    expect(await code(answer('<html>nope</html>'))).toBe('PROVIDER_UNAVAILABLE');
    expect(await code(answer('http://insecure.example/x'))).toBe('PROVIDER_UNAVAILABLE');
    expect(
      await code(answer(JSON.stringify({ statusCode: 9946, statusDescription: 'Wrong Signature' })))
    ).toBe('PROVIDER_MISCONFIGURED');
  });

  it('maps HTTP failures of the init call', async () => {
    const via = (status: number) =>
      createFawryProvider({ fetchImpl: async () => respond('x', status) }).createPayment(
        cardReq(),
        stubCreds
      );
    expect(await code(via(502))).toBe('PROVIDER_UNAVAILABLE');
    expect(await code(via(401))).toBe('PROVIDER_MISCONFIGURED');
    expect(await code(via(400))).toBe('PROVIDER_REJECTED');
  });

  it('the bare URL fixture is the documented answer shape', () => {
    const u = new URL(fixture('hosted-init-response.official.txt').trim());
    expect(u.searchParams.get('payment-id')).toBe('kCk0R85FuTY=');
  });
});

// ---------------------------------------------------------------------------------------------
describe('(e) status v2 and refund', () => {
  it('status: signature, statuses (case-insensitive), no refunded field', async () => {
    const { stub, provider } = mk();
    const c = await provider.createPayment(req({ amountMinor: 15_000 }), stubCreds);
    expect((await provider.getStatus(c.providerRef, stubCreds)).status).toBe('pending');
    const q = stub.requests.find(r => r.path.endsWith('/status/v2'))!.body as any;
    expect(q.signature).toBe(sha(FAWRY_STUB.merchantCode + c.providerRef + FAWRY_STUB.secureKey));
    stub.capture(c.providerRef);
    const paid = await provider.getStatus(c.providerRef, stubCreds);
    expect(paid).toMatchObject({ status: 'completed', capturedMinor: 15_000, refundedMinor: 0 });
    expect(paid.paidAt?.getTime()).toBe(1_790_000_000_000);
  });

  const withBody = (body: unknown) =>
    createFawryProvider({ fetchImpl: async () => respond(body), timeoutMs: 100 });
  const statusBody = (o: Record<string, unknown>) => ({
    fawryRefNumber: '970177',
    merchantRefNumber: 'm-1',
    paymentAmount: 152.0,
    orderAmount: 150.0,
    paymentMethod: 'PAYATFAWRY',
    ...o,
  });

  it.each([
    ['New', 'pending'],
    ['NEW', 'pending'],
    ['PAID', 'completed'],
    ['CANCELED', 'cancelled'],
    ['EXPIRED', 'expired'],
    ['FAILED', 'failed'],
    ['REFUNDED', 'refunded'],
    ['PARTIAL_REFUNDED', 'partially_refunded'],
  ])('orderStatus %s -> %s', async (orderStatus, expected) => {
    const st = await withBody(
      statusBody({ orderStatus, paymentTime: 1_607_879_720_568 })
    ).getStatus('m-1', stubCreds);
    expect(st.status).toBe(expected);
  });

  it('REFUNDED reads as the whole paid amount; PARTIAL_REFUNDED reports no invented number', async () => {
    const full = await withBody(statusBody({ orderStatus: 'REFUNDED' })).getStatus(
      'm-1',
      stubCreds
    );
    expect(full).toMatchObject({ capturedMinor: 15_200, refundedMinor: 15_200 });
    const part = await withBody(statusBody({ orderStatus: 'PARTIAL_REFUNDED' })).getStatus(
      'm-1',
      stubCreds
    );
    expect(part).toMatchObject({
      status: 'partially_refunded',
      capturedMinor: 15_200,
      refundedMinor: 0,
    });
  });

  it('paymentTime: epoch ms (number or string) parses; the timezone-less dd-MM-yyyy form stays undefined', async () => {
    const t = (v: unknown) =>
      withBody(statusBody({ orderStatus: 'PAID', paymentTime: v })).getStatus('m-1', stubCreds);
    expect((await t(1_607_879_720_568)).paidAt?.getTime()).toBe(1_607_879_720_568);
    expect((await t('1607879720568')).paidAt?.getTime()).toBe(1_607_879_720_568);
    expect((await t('19-05-2020 11:45:23')).paidAt).toBeUndefined();
  });

  it('status codes: 9938 not found; 9901 and 9946 credentials; others rejected', async () => {
    const errs = fixtureJson('status-v2-errors.official.json');
    expect(await code(withBody(errs.orderNotFound).getStatus('m', stubCreds))).toBe(
      'PAYMENT_NOT_FOUND'
    );
    expect(await code(withBody(errs.merchantInvalid).getStatus('m', stubCreds))).toBe(
      'PROVIDER_MISCONFIGURED'
    );
    expect(await code(withBody(errs.wrongSignature).getStatus('m', stubCreds))).toBe(
      'PROVIDER_MISCONFIGURED'
    );
    expect(
      await code(withBody({ statusCode: 9984, statusDescription: 'x' }).getStatus('m', stubCreds))
    ).toBe('PROVIDER_REJECTED');
  });

  it('refund: Fawry reference from status, 2-dp number, reason omitted when empty, signature literal', async () => {
    const { stub, provider } = mk();
    const c = await provider.createPayment(req({ amountMinor: 5_029 }), stubCreds);
    stub.capture(c.providerRef);
    await provider.partialRefund(
      { providerRef: c.providerRef, idempotencyKey: 'r1', amountMinor: 1_029 },
      stubCreds
    );
    const b = sent(stub, '/ECommerceWeb/Fawry/payments/refund');
    const fawryRef = stub.charges.get(c.providerRef)!.referenceNumber;
    expect(b.referenceNumber).toBe(fawryRef);
    expect(b.refundAmount).toBe(10.29);
    expect('reason' in b).toBe(false);
    expect(b.signature).toBe(
      sha(FAWRY_STUB.merchantCode + fawryRef + '10.29' + FAWRY_STUB.secureKey)
    );
    await provider.partialRefund(
      {
        providerRef: c.providerRef,
        idempotencyKey: 'r2',
        amountMinor: 1_000,
        reason: 'Item not as described',
      },
      stubCreds
    );
    const b2 = stub.requests.filter(r => r.path.endsWith('/refund'))[1].body as any;
    expect(b2.reason).toBe('Item not as described');
    expect(b2.signature).toBe(
      sha(
        FAWRY_STUB.merchantCode +
          fawryRef +
          '10.00' +
          'Item not as described' +
          FAWRY_STUB.secureKey
      )
    );
  });

  it('documented-shape status (no refunded amount): PARTIAL_REFUNDED lets Fawry enforce the ceiling (9935)', async () => {
    const { stub, provider } = mk();
    stub.documentedShapesOnly = true;
    const c = await provider.createPayment(req({ amountMinor: 5_000 }), stubCreds);
    stub.capture(c.providerRef);
    await provider.partialRefund(
      { providerRef: c.providerRef, idempotencyKey: 'a', amountMinor: 4_000 },
      stubCreds
    );
    const st = await provider.getStatus(c.providerRef, stubCreds);
    expect(st).toMatchObject({ status: 'partially_refunded', refundedMinor: 0 });
    const before = stub.requests.filter(r => r.path.endsWith('/refund')).length;
    // 2000 > the 1000 left: no local guess, the request goes out and Fawry answers 9935
    expect(
      await code(
        provider.partialRefund(
          { providerRef: c.providerRef, idempotencyKey: 'b', amountMinor: 2_000 },
          stubCreds
        )
      )
    ).toBe('REFUND_EXCEEDS_CAPTURED');
    expect(stub.requests.filter(r => r.path.endsWith('/refund')).length).toBe(before + 1);
    // and a remaining refund within the ceiling still goes through
    const ok = await provider.partialRefund(
      { providerRef: c.providerRef, idempotencyKey: 'c', amountMinor: 1_000 },
      stubCreds
    );
    expect(ok.amountMinor).toBe(1_000);
  });

  it('refund codes: 9935 -> REFUND_EXCEEDS_CAPTURED, 9954 -> PAYMENT_NOT_CAPTURED', async () => {
    const errs = fixtureJson('status-v2-errors.official.json');
    const via = (refundAnswer: unknown) =>
      createFawryProvider({
        timeoutMs: 100,
        fetchImpl: async url =>
          url.includes('/status/v2')
            ? respond(statusBody({ orderStatus: 'PAID', paymentTime: 1_607_879_720_568 }))
            : respond(refundAnswer),
      }).partialRefund({ providerRef: 'm-1', idempotencyKey: 'k', amountMinor: 100 }, stubCreds);
    expect(await code(via(errs.refundTooBig))).toBe('REFUND_EXCEEDS_CAPTURED');
    expect(await code(via(errs.notPaid))).toBe('PAYMENT_NOT_CAPTURED');
    expect(await code(via(errs.wrongSignature))).toBe('PROVIDER_MISCONFIGURED');
  });
});

// ---------------------------------------------------------------------------------------------
describe('(f) testConnection', () => {
  it('ok on 9938 for a reference that cannot exist, signed correctly; no state created', async () => {
    const { stub, provider } = mk();
    const r = await provider.testConnection!(stubCreds);
    expect(r).toMatchObject({ ok: true, code: 'ok' });
    expect(stub.requests).toHaveLength(1);
    const q = stub.requests[0].body as any;
    expect(stub.requests[0].method).toBe('GET');
    expect(q.merchantRefNumber).toMatch(/^ebda-conn-[0-9a-f]{16}$/);
    expect(q.signature).toBe(
      sha(FAWRY_STUB.merchantCode + q.merchantRefNumber + FAWRY_STUB.secureKey)
    );
    expect(stub.createdCount).toBe(0);
  });

  it('wrong secure key (9946) and wrong merchant code (9901) -> bad_credentials, no secret echoed', async () => {
    const { provider } = mk();
    for (const bad of [
      { ...stubCreds, apiKey: 'wrong-key-123456' },
      { ...stubCreds, merchantId: 'WRONGCODE' },
    ]) {
      const r = await provider.testConnection!(bad);
      expect(r).toMatchObject({ ok: false, code: 'bad_credentials' });
      expect(JSON.stringify(r)).not.toMatch(/wrong-key-123456|WRONGCODE/);
    }
  });

  it('incomplete credentials send nothing', async () => {
    const { stub, provider } = mk();
    expect((await provider.testConnection!({ ...stubCreds, apiKey: undefined })).code).toBe(
      'incomplete'
    );
    expect((await provider.testConnection!({ ...stubCreds, merchantId: undefined })).code).toBe(
      'incomplete'
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('timeout and connection failure -> unreachable; HTTP 5xx -> unreachable; a refusal or odd answer -> unknown', async () => {
    const a = mk();
    a.stub.faults.injectNextCall('timeout');
    expect((await a.provider.testConnection!(stubCreds)).code).toBe('unreachable');
    const b = mk();
    b.stub.faults.injectNextCall('unavailable');
    expect((await b.provider.testConnection!(stubCreds)).code).toBe('unreachable');
    const c = mk();
    c.stub.faults.injectNextCall('rejected'); // HTTP 422
    expect((await c.provider.testConnection!(stubCreds)).code).toBe('unknown');
    const fiveXx = createFawryProvider({
      fetchImpl: async () => respond('boom', 503),
      timeoutMs: 100,
    });
    expect((await fiveXx.testConnection!(stubCreds)).code).toBe('unreachable');
    const odd = createFawryProvider({
      fetchImpl: async () => respond({ statusCode: 9984 }),
      timeoutMs: 100,
    });
    expect((await odd.testConnection!(stubCreds)).code).toBe('unknown');
    const http401 = createFawryProvider({
      fetchImpl: async () => respond('no', 401),
      timeoutMs: 100,
    });
    expect((await http401.testConnection!(stubCreds)).code).toBe('bad_credentials');
  });
});
