/**
 * Paymob adapter vs Paymob's OFFICIAL docs (developers.paymob.com, extracted 2026-10-07).
 * Fixtures under tests/contracts/paymob/ are the docs' verbatim JSON examples. Everything the
 * docs do not state stays `UNVERIFIED:` in the adapter and is not asserted here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createPaymobProvider,
  paymobHmac,
  paymobHmacMessage,
  paymobNonBooleanField,
  PAYMOB_HMAC_HEADER,
} from '@api/services/payment-providers/paymob.provider';
import {
  PaymentProviderError,
  type PaymentProviderErrorCode,
  type ProviderCredentials,
} from '@api/services/payment-providers/types';
import { webhookRefs } from '@api/services/payment-providers/webhook-signature';
import { PaymobStub, PAYMOB_STUB } from '../stubs/paymob-stub';
import { baseRequest } from '../contract/payment-provider.contract';

// The docs' callback fixtures are dated 2024-06-13: pin the clock inside the accepted window.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-06-14T00:00:00Z'));
});
afterAll(() => vi.useRealTimers());

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/paymob', name), 'utf8'));

const DOC_MESSAGE =
  '1000002024-06-13T11:33:44.592345EGPfalsefalse1920364654097558truefalsefalsefalsetruefalse217503754302852false2346MasterCardcardtrue';
const SECRET = 'test-hmac-secret';

const creds: ProviderCredentials = {
  mode: 'sandbox',
  apiKey: PAYMOB_STUB.secretKey,
  secretKey: PAYMOB_STUB.apiKey,
  webhookSecret: PAYMOB_STUB.hmacSecret,
  settings: { publicKey: PAYMOB_STUB.publicKey, integrationIds: PAYMOB_STUB.integrationIds },
};

interface Seen {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** The stub behind a recorder that keeps headers too; `override` can answer a path itself. */
function rig(override?: (path: string) => Response | undefined) {
  const stub = new PaymobStub();
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      method: init?.method,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    });
    const forced = override?.(new URL(url).pathname);
    return forced ?? stub.fetch(url, init);
  };
  const provider = createPaymobProvider({
    fetchImpl,
    timeoutMs: 80,
    baseUrls: { sandbox: PAYMOB_STUB.baseUrl },
    checkoutBaseUrls: { sandbox: PAYMOB_STUB.checkoutUrl },
  });
  return { stub, seen, provider };
}

const header = (s: Seen, name: string) =>
  Object.entries(s.headers).find(([k]) => k.toLowerCase() === name)?.[1];

async function code(p: Promise<unknown>): Promise<PaymentProviderErrorCode | 'resolved'> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as PaymentProviderError).code;
  }
}
function sync(fn: () => unknown): PaymentProviderErrorCode | 'returned' {
  try {
    fn();
    return 'returned';
  } catch (e) {
    return (e as PaymentProviderError).code;
  }
}

describe('Paymob official HMAC example', () => {
  const callback = fixture('callback.official.json');

  it("the documented callback obj concatenates to the docs' worked string, exactly", () => {
    expect(paymobHmacMessage(callback.obj)).toBe(DOC_MESSAGE);
  });

  it('paymobHmac is SHA-512 over that string', () => {
    expect(paymobHmac(callback.obj, SECRET)).toBe(
      crypto.createHmac('sha512', SECRET).update(DOC_MESSAGE).digest('hex')
    );
  });

  const verify = (body: unknown, hmac: string) =>
    createPaymobProvider().verifyWebhook(
      JSON.stringify(body),
      { [PAYMOB_HMAC_HEADER]: hmac },
      { ...creds, webhookSecret: SECRET }
    );
  const good = () => paymobHmac(callback.obj, SECRET);
  const clone = () => JSON.parse(JSON.stringify(callback));

  it('accepts the documented callback signed with the secret', () => {
    const ev = verify(callback, good());
    expect(ev).toMatchObject({
      kind: 'payment',
      providerRef: '217503754',
      amountMinor: 100000,
      status: 'completed',
    });
  });

  it.each([
    ['amount_cents', (b: any) => (b.obj.amount_cents = 100001)],
    ['success', (b: any) => (b.obj.success = false)],
    ['order.id', (b: any) => (b.obj.order.id = 217503755)],
  ])('a changed %s -> WEBHOOK_BAD_SIGNATURE', (_n, mutate) => {
    const b = clone();
    mutate(b);
    expect(sync(() => verify(b, good()))).toBe('WEBHOOK_BAD_SIGNATURE');
  });

  it('one changed hex char of the hmac -> WEBHOOK_BAD_SIGNATURE', () => {
    const h = good();
    const flipped = (h[0] === 'a' ? 'b' : 'a') + h.slice(1);
    expect(sync(() => verify(callback, flipped))).toBe('WEBHOOK_BAD_SIGNATURE');
  });
});

describe('Paymob create-intention matches the documented request/response', () => {
  const doc = fixture('intention-request.official.json');
  const response = fixture('intention-201.official.json');

  it('sends the documented fields with integer cents, Token auth and /v1/intention/', async () => {
    const seen: Seen[] = [];
    const provider = createPaymobProvider({
      baseUrls: { sandbox: PAYMOB_STUB.baseUrl },
      checkoutBaseUrls: { sandbox: 'https://eg.checkout.paymob.com' },
      fetchImpl: async (url, init) => {
        seen.push({
          url,
          method: init?.method,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify(response), { status: 201 });
      },
    });
    const res = await provider.createPayment(
      baseRequest({
        amountMinor: 2000,
        orderNumber: 'ORD-1',
        webhookUrl: 'https://hooks.test/paymob',
        expiresAt: new Date(Date.now() + 3_600_000),
        items: [
          { name: 'Item name', description: 'Item description', quantity: 1, unitPrice: 2000 },
        ],
      }),
      { ...creds, settings: { publicKey: 'pk_test_x1234567', integrationIds: { card: 158 } } }
    );
    const s = seen[0];
    expect(s.url).toBe(`${PAYMOB_STUB.baseUrl}/v1/intention/`);
    expect(s.method).toBe('POST');
    expect(header(s, 'authorization')).toBe(`Token ${PAYMOB_STUB.secretKey}`);
    expect(header(s, 'content-type')).toBe('application/json');
    const b = s.body as Record<string, any>;
    // every top-level key is a documented one, and the documented required ones are present
    for (const k of Object.keys(b)) expect(Object.keys(doc)).toContain(k);
    for (const k of ['amount', 'currency', 'payment_methods', 'items', 'billing_data']) {
      expect(b).toHaveProperty(k);
    }
    expect(b.amount).toBe(2000);
    expect(Number.isInteger(b.amount)).toBe(true);
    expect(b.currency).toBe('EGP');
    expect(b.payment_methods).toEqual([158]);
    expect(b.items).toEqual([
      { name: 'Item name', amount: 2000, description: 'Item description', quantity: 1 },
    ]);
    for (const i of b.items) expect(Number.isInteger(i.amount)).toBe(true);
    for (const k of ['first_name', 'last_name', 'email', 'phone_number']) {
      expect(typeof b.billing_data[k]).toBe('string');
      expect(b.billing_data[k].length).toBeGreaterThan(0);
    }
    for (const k of Object.keys(b.billing_data)) expect(Object.keys(doc.billing_data)).toContain(k);
    expect(b.special_reference).toMatch(/^ORD-1-/);
    expect(b.notification_url).toBe('https://hooks.test/paymob');
    expect(b.redirection_url).toBe('https://shop.test/ok');
    expect(b.expiration).toBeGreaterThan(3500);
    expect(b.expiration).toBeLessThanOrEqual(3600);

    // documented 201 response parsed
    expect(res.providerRef).toBe('265715202');
    expect(res.invoiceId).toBe(b.special_reference);
    expect(res.instruction).toEqual({
      kind: 'redirect',
      url: 'https://eg.checkout.paymob.com/?publicKey=pk_test_x1234567&clientSecret=egy_csk_test_94042f793419c5a0f14a4cadfda9d626',
    });
  });

  it('the redirect goes to the checkout host, not the API host', async () => {
    const { provider } = rig();
    const res = await provider.createPayment(baseRequest(), creds);
    if (res.instruction.kind !== 'redirect') throw new Error('expected redirect');
    expect(res.instruction.url.startsWith(`${PAYMOB_STUB.checkoutUrl}/?publicKey=`)).toBe(true);
    expect(res.instruction.url).toContain('&clientSecret=egy_csk_test_');
  });
});

describe('Paymob inquiry and refund follow the documented flow', () => {
  async function paid(over?: Parameters<typeof rig>[0], sourceType = 'card', amount = 8_000) {
    const r = rig(over);
    const a = await r.provider.createPayment(baseRequest({ amountMinor: amount }), creds);
    r.stub.capture(Number(a.providerRef), sourceType);
    r.seen.length = 0;
    return { ...r, ref: a.providerRef };
  }

  it('status: POST auth/tokens {api_key} then transaction_inquiry {auth_token, order_id}, no Authorization header', async () => {
    const { provider, seen, ref } = await paid();
    const st = await provider.getStatus(ref, creds);
    expect(st.status).toBe('completed');
    expect(seen.map(s => new URL(s.url).pathname)).toEqual([
      '/api/auth/tokens',
      '/api/ecommerce/orders/transaction_inquiry',
    ]);
    expect(seen[0].body).toEqual({ api_key: PAYMOB_STUB.apiKey });
    expect(header(seen[0], 'authorization')).toBeUndefined();
    // 2026-10-24: Paymob's Postman collection (PaymobAccept/API-Postman-Collections, Transaction
    // Inquiry API) sends the token as a Bearer header with body {order_id}; the 2026-10-07 docs
    // extract had it in the body. Both are sent until a live account settles which is current.
    expect(seen[1].body).toEqual({ auth_token: PAYMOB_STUB.authToken, order_id: ref });
    expect(header(seen[1], 'authorization')).toBe(`Bearer ${PAYMOB_STUB.authToken}`);
  });

  it('status without the API key is PROVIDER_MISCONFIGURED and nothing is sent', async () => {
    const { provider, seen, ref } = await paid();
    expect(await code(provider.getStatus(ref, { ...creds, secretKey: undefined }))).toBe(
      'PROVIDER_MISCONFIGURED'
    );
    expect(seen).toHaveLength(0);
  });

  it('refund: POST void_refund/refund {transaction_id, amount_cents} with Token auth', async () => {
    const { provider, seen, ref, stub } = await paid();
    const txnId = stub.orders.get(Number(ref))!.txnId!;
    const r = await provider.partialRefund(
      { providerRef: ref, idempotencyKey: 'r1', amountMinor: 1_500 },
      creds
    );
    expect(r).toMatchObject({ amountMinor: 1_500, refundedTotalMinor: 1_500, status: 'completed' });
    const call = seen.find(s => s.url.endsWith('/api/acceptance/void_refund/refund'))!;
    expect(call.body).toEqual({ transaction_id: txnId, amount_cents: 1_500 });
    expect(header(call, 'authorization')).toBe(`Token ${PAYMOB_STUB.secretKey}`);
  });

  it('a 400 "greater than the maximum refund amount" is REFUND_EXCEEDS_CAPTURED', async () => {
    const { provider, ref } = await paid(p =>
      p.endsWith('/refund')
        ? new Response(
            JSON.stringify({
              message:
                'Requested Refund Amount is greater than the maximum refund amount permissible. Maximum Refund Amount is EGP 100.0',
            }),
            { status: 400 }
          )
        : undefined
    );
    expect(
      await code(
        provider.partialRefund({ providerRef: ref, idempotencyKey: 'x', amountMinor: 100 }, creds)
      )
    ).toBe('REFUND_EXCEEDS_CAPTURED');
  });

  it('void: POST void_refund/void {transaction_id} only for a same-day full card refund', async () => {
    const { provider, seen, ref, stub } = await paid();
    await provider.refund({ providerRef: ref, idempotencyKey: 'v' }, creds);
    const call = seen.find(s => s.url.endsWith('/void'))!;
    expect(call.body).toEqual({ transaction_id: stub.orders.get(Number(ref))!.txnId });
    expect(header(call, 'authorization')).toBe(`Token ${PAYMOB_STUB.secretKey}`);
  });

  it('a non-card payment is never voided: the refund endpoint is used', async () => {
    const { provider, seen, ref } = await paid(undefined, 'wallet');
    await provider.refund({ providerRef: ref, idempotencyKey: 'w' }, creds);
    expect(seen.some(s => s.url.endsWith('/void'))).toBe(false);
    expect(seen.some(s => s.url.endsWith('/refund'))).toBe(true);
    expect(
      await code(provider.voidPayment({ providerRef: ref, idempotencyKey: 'w2' }, creds))
    ).toBe('REFUND_NOT_SUPPORTED');
  });

  it('a kiosk payment cannot be refunded (docs): REFUND_NOT_SUPPORTED, no refund call', async () => {
    const { provider, seen, ref } = await paid(undefined, 'aggregator');
    expect(await code(provider.refund({ providerRef: ref, idempotencyKey: 'k' }, creds))).toBe(
      'REFUND_NOT_SUPPORTED'
    );
    expect(seen.some(s => s.url.includes('void_refund'))).toBe(false);
  });
});

describe('Paymob testConnection', () => {
  it('ok: one POST /api/auth/tokens with the API key; reports the (non-secret) profile id', async () => {
    const { provider, seen } = rig();
    const r = await provider.testConnection!(creds);
    expect(r).toMatchObject({ ok: true, code: 'ok', details: { profileId: 106 } });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${PAYMOB_STUB.baseUrl}/api/auth/tokens`);
    expect(seen[0].body).toEqual({ api_key: PAYMOB_STUB.apiKey });
    expect(JSON.stringify(r)).not.toContain(PAYMOB_STUB.apiKey);
    expect(JSON.stringify(r)).not.toContain(PAYMOB_STUB.authToken);
  });

  it('bad_credentials: Paymob refuses the API key', async () => {
    const { provider } = rig();
    const r = await provider.testConnection!({ ...creds, secretKey: 'WRONG_api_key_value' });
    expect(r).toMatchObject({ ok: false, code: 'bad_credentials' });
    expect(r.message).not.toContain('WRONG_api_key_value');
  });

  it.each([
    ['Secret key', { apiKey: undefined }],
    ['API key', { secretKey: undefined }],
    ['HMAC secret', { webhookSecret: undefined }],
    ['Public key', { settings: { integrationIds: { card: 1 } } }],
    ['integration', { settings: { publicKey: 'pk_test_abcdefgh', integrationIds: {} } }],
  ])('incomplete: missing %s, nothing is sent', async (_n, patch) => {
    const { provider, seen } = rig();
    const r = await provider.testConnection!({ ...creds, ...patch } as ProviderCredentials);
    expect(r).toMatchObject({ ok: false, code: 'incomplete' });
    expect(seen).toHaveLength(0);
  });

  it('wrong_mode: live keys in sandbox, test keys in live; nothing is sent', async () => {
    const { provider, seen } = rig();
    const live = {
      ...creds,
      apiKey: 'sk_live_abc',
      settings: { ...creds.settings, publicKey: 'pk_live_abcdefgh' },
    };
    expect(await provider.testConnection!(live)).toMatchObject({ code: 'wrong_mode' });
    expect(await provider.testConnection!({ ...creds, mode: 'live' })).toMatchObject({
      code: 'wrong_mode',
    });
    // a half-mismatched pair (secret ok, public key of the other mode) is wrong too
    expect(
      await provider.testConnection!({
        ...creds,
        settings: { ...creds.settings, publicKey: 'pk_live_abcdefgh' },
      })
    ).toMatchObject({ code: 'wrong_mode' });
    expect(seen).toHaveLength(0);
  });

  it('mutation: the mode-prefix check is what stops a wrong-mode call (same credentials, only the prefix differs)', async () => {
    const { provider, seen } = rig();
    const wrong = { ...creds, apiKey: 'sk_live_paymob_stub' };
    expect((await provider.testConnection!(wrong)).code).toBe('wrong_mode');
    expect(seen).toHaveLength(0);
    // restore the prefix: the identical credentials now reach Paymob and succeed
    expect((await provider.testConnection!({ ...wrong, apiKey: 'sk_test_paymob_stub' })).code).toBe(
      'ok'
    );
    expect(seen).toHaveLength(1);
  });

  it('unreachable: a down gateway or a timeout says nothing about the credentials', async () => {
    const down = rig();
    down.stub.faults.injectNextCall('unavailable');
    expect(await down.provider.testConnection!(creds)).toMatchObject({
      ok: false,
      code: 'unreachable',
    });
    const slow = rig();
    slow.stub.faults.injectNextCall('timeout');
    expect(await slow.provider.testConnection!(creds)).toMatchObject({ code: 'unreachable' });
    const fiveHundred = rig(() => new Response('{}', { status: 503 }));
    expect(await fiveHundred.provider.testConnection!(creds)).toMatchObject({
      code: 'unreachable',
    });
  });
});

describe('Paymob re-verification 2026-10-24 (docs: create-intention, Postman collections)', () => {
  const intentionBody = async (over: Parameters<typeof baseRequest>[0], credsOver = creds) => {
    const { provider, seen } = rig();
    await provider.createPayment(baseRequest(over), credsOver);
    return seen.find(s => s.url.endsWith('/v1/intention/'))!.body as Record<string, any>;
  };

  it('billing_data.country is the 3-letter ISO code the docs show (EGY)', async () => {
    const b = await intentionBody({});
    expect(b.billing_data.country).toBe('EGY');
  });

  it('expiration never exceeds the documented maximum of 3110400 seconds', async () => {
    const b = await intentionBody({ expiresAt: new Date(Date.now() + 90 * 86_400_000) });
    expect(b.expiration).toBe(3_110_400);
  });

  it('items: docs say sum(items[].amount) must equal amount, so a quantity > 1 line is not sent per unit', async () => {
    const b = await intentionBody({
      amountMinor: 15_000,
      items: [
        { name: 'A', quantity: 1, unitPrice: 5_000 },
        { name: 'B', quantity: 2, unitPrice: 5_000 },
      ],
    });
    const sum = b.items.reduce((n: number, i: any) => n + i.amount, 0);
    expect(sum).toBe(b.amount);
  });

  it('billing_data names are capped at the documented 50 characters', async () => {
    const long = 'x'.repeat(80);
    const b = await intentionBody({
      customer: { name: `${long} ${long}`, email: 'a@b.co', phone: '+201012345678' },
    });
    expect(b.billing_data.first_name.length).toBeLessThanOrEqual(50);
    expect(b.billing_data.last_name.length).toBeLessThanOrEqual(50);
  });

  const verify = (obj: Record<string, unknown>, signedObj: Record<string, unknown>) => {
    const callback = fixture('callback.official.json');
    return createPaymobProvider().verifyWebhook(
      JSON.stringify({ ...callback, obj }),
      { [PAYMOB_HMAC_HEADER]: paymobHmac(signedObj, SECRET) },
      { ...creds, webhookSecret: SECRET }
    );
  };

  it('a refund transaction (signed has_parent_transaction) is a refund even when is_refunded is false', () => {
    const obj = {
      ...fixture('callback.official.json').obj,
      has_parent_transaction: true,
      parent_transaction: 192036465,
      is_refunded: false,
      is_voided: false,
    };
    expect(verify(obj, obj).kind).toBe('refund');
  });

  it('a tampered UNSIGNED is_refund / is_void on a signed payment does not make it a refund', () => {
    const signed = { ...fixture('callback.official.json').obj, has_parent_transaction: false };
    const tampered = { ...signed, is_refund: true, is_void: true };
    const ev = verify(tampered, signed); // HMAC computed over signed fields only: still valid
    expect(ev.kind).toBe('payment');
  });

  it('a replay classified differently gets a different eventId (cannot collide with the original)', () => {
    const base = { ...fixture('callback.official.json').obj, has_parent_transaction: false };
    const asRefund = { ...base, has_parent_transaction: true };
    expect(verify(base, base).eventId).not.toBe(verify(asRefund, asRefund).eventId);
  });

  it('a signed callback with a string/number where a boolean belongs is refused as malformed', () => {
    const base = { ...fixture('callback.official.json').obj };
    for (const [f, v] of [
      ['has_parent_transaction', 'true'],
      ['is_capture', 1],
      ['success', 'true'],
    ] as const) {
      const obj = { ...base, [f]: v }; // HMAC over hmacText() still verifies
      expect(paymobNonBooleanField(obj)).toBe(f);
      expect(() => verify(obj, obj)).toThrowError(/not a boolean/);
    }
  });

  it('a type-flipped replay maps to the same dedupe key (route + adapter)', () => {
    const real = { ...fixture('callback.official.json').obj, has_parent_transaction: true };
    const flipped = { ...real, has_parent_transaction: 'true' };
    expect(webhookRefs('paymob', { type: 'TRANSACTION', obj: flipped }).idempotencyKey).toBe(
      webhookRefs('paymob', { type: 'TRANSACTION', obj: real }).idempotencyKey
    );
  });

  it('a child (refund/void) delivery also offers the legacy key shape for dedupe', () => {
    const obj = { ...fixture('callback.official.json').obj, has_parent_transaction: true };
    const refs = webhookRefs('paymob', { type: 'TRANSACTION', obj });
    const flags = [obj.pending, obj.success, obj.is_voided, obj.is_refunded]
      .map(b => (b === true ? 1 : 0))
      .join('');
    expect(refs.legacyIdempotencyKeys).toEqual([`paymob_${obj.id}_${flags}`]);
    // a parent-less payment keeps EXACTLY the legacy key, so stored rows already match
    const plain = webhookRefs('paymob', {
      type: 'TRANSACTION',
      obj: { ...obj, has_parent_transaction: false },
    });
    expect(plain.idempotencyKey).toBe(`paymob_${obj.id}_${flags}`);
  });

  it('a callback whose signed created_at is outside the window is rejected', () => {
    const old = {
      ...fixture('callback.official.json').obj,
      created_at: '2024-03-01T00:00:00.000000',
    };
    expect(() => verify(old, old)).toThrowError(/created_at/);
    const future = {
      ...fixture('callback.official.json').obj,
      created_at: '2024-07-01T00:00:00.000000',
    };
    expect(() => verify(future, future)).toThrowError(/created_at/);
  });

  it('a child transaction that is a capture (signed is_capture) stays a payment', () => {
    const obj = {
      ...fixture('callback.official.json').obj,
      has_parent_transaction: true,
      is_capture: true,
    };
    expect(verify(obj, obj).kind).toBe('payment');
  });

  it('a kiosk payment completed 20 days after creation is still accepted', () => {
    const obj = {
      ...fixture('callback.official.json').obj,
      created_at: '2024-05-25T00:00:00.000000',
    };
    expect(verify(obj, obj).kind).toBe('payment');
  });
});
