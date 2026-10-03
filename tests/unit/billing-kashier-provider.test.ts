/**
 * SP5 task 3 — Kashier adapter + provider selection (no network, no DB).
 *
 * Mutation proof (recorded in the commit body): in
 * apps/api/src/services/billing/kashier.provider.ts replace the
 * `safeEqual(expected, provided…)` check with `true` -> the "bad signature"
 * and "tampered body" tests fail (a forged webhook would be accepted).
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  KashierBillingProvider,
  gatewayAmount,
  kashierSignaturePayload,
  parseGatewayAmount,
  stripTokens,
} from '../../apps/api/src/services/billing/kashier.provider';
import {
  BillingProviderError,
  BillingSignatureError,
} from '../../apps/api/src/services/billing/types';
import {
  assertBillingConfigAtBoot,
  createBillingProvider,
  resolveBillingProviderName,
} from '../../apps/api/src/services/billing';
import { StubBillingProvider } from '../../apps/api/src/services/billing/stub.provider';
import {
  addInterval,
  renewalKey,
  DUNNING_RETRY_DAYS,
} from '../../apps/api/src/services/billing/period';

const API_KEY = 'test-payment-api-key';
const ORDER = '3f1c2b7e-0000-4000-8000-000000000001';

function sign(data: Record<string, unknown>, keys: string[], key = API_KEY): string {
  return crypto.createHmac('sha256', key).update(kashierSignaturePayload(data, keys)).digest('hex');
}

function webhook(overrides: Record<string, unknown> = {}, keys?: string[]) {
  const data: Record<string, unknown> = {
    merchantOrderId: ORDER,
    amount: '199.99',
    currency: 'EGP',
    status: 'SUCCESS',
    transactionId: 'TX-1',
    cardDataToken: 'secret-card-token',
    ...overrides,
  };
  const signatureKeys = keys ?? [
    'merchantOrderId',
    'amount',
    'currency',
    'status',
    'transactionId',
  ];
  data.signatureKeys = signatureKeys;
  const body = JSON.stringify({ event: 'pay', data });
  return { body, signature: sign(data, signatureKeys), data };
}

const provider = () =>
  new KashierBillingProvider({
    baseUrl: 'https://kashier.test',
    merchantId: 'MID-1',
    secretKey: 'sk',
    apiKey: API_KEY,
  });

describe('amount formatting (integer piastres only)', () => {
  it('19999 -> "199.99", 5 -> "0.05", 0 -> "0.00", 100 -> "1.00"', () => {
    expect(gatewayAmount(19999)).toBe('199.99');
    expect(gatewayAmount(5)).toBe('0.05');
    expect(gatewayAmount(0)).toBe('0.00');
    expect(gatewayAmount(100)).toBe('1.00');
  });
  it('refuses floats and negatives', () => {
    expect(() => gatewayAmount(199.99)).toThrow(RangeError);
    expect(() => gatewayAmount(-1)).toThrow(RangeError);
    expect(() => gatewayAmount(Number.NaN)).toThrow(RangeError);
  });
  it('parses the gateway string back without floats', () => {
    expect(parseGatewayAmount('199.99')).toBe(19999);
    expect(parseGatewayAmount('0.05')).toBe(5);
    expect(parseGatewayAmount('1.999')).toBeNull();
    expect(parseGatewayAmount('abc')).toBeNull();
  });
});

describe('KashierBillingProvider.verifyWebhook', () => {
  it('accepts a correctly signed webhook and returns a typed event without the token', () => {
    const { body, signature } = webhook();
    const ev = provider().verifyWebhook(body, { 'x-kashier-signature': signature });
    expect(ev.kind).toBe('charge.succeeded');
    expect(ev.merchantOrderId).toBe(ORDER);
    expect(ev.amountMinor).toBe(19999);
    expect(ev.providerRef).toBe('TX-1');
    expect(ev.eventId).toBe('TX-1:SUCCESS');
    expect(ev.card?.token).toBe('secret-card-token');
    expect(JSON.stringify(ev.raw)).not.toContain('secret-card-token');
  });

  it('maps a declined payment to charge.failed', () => {
    const { body, signature } = webhook({ status: 'FAILURE', message: 'Insufficient funds' });
    const ev = provider().verifyWebhook(Buffer.from(body), { 'X-Kashier-Signature': signature });
    expect(ev.kind).toBe('charge.failed');
    expect(ev.eventId).toBe('TX-1:FAILURE');
  });

  it('rejects a bad signature', () => {
    const { body } = webhook();
    expect(() => provider().verifyWebhook(body, { 'x-kashier-signature': 'a'.repeat(64) })).toThrow(
      BillingSignatureError
    );
  });

  it('rejects a signature made with the wrong key', () => {
    const { body, data } = webhook();
    const forged = sign(data, data.signatureKeys as string[], 'attacker-key');
    expect(() => provider().verifyWebhook(body, { 'x-kashier-signature': forged })).toThrow(
      BillingSignatureError
    );
  });

  it('rejects a missing signature header', () => {
    expect(() => provider().verifyWebhook(webhook().body, {})).toThrow(BillingSignatureError);
  });

  it('rejects a tampered body (amount rewritten after signing)', () => {
    const { body, signature } = webhook();
    const tampered = body.replace('"199.99"', '"1.00"');
    expect(tampered).not.toBe(body);
    expect(() => provider().verifyWebhook(tampered, { 'x-kashier-signature': signature })).toThrow(
      BillingSignatureError
    );
  });

  it('rejects a tampered status', () => {
    const { body, signature } = webhook({ status: 'FAILURE' });
    const tampered = body.replace('FAILURE', 'SUCCESS');
    expect(() => provider().verifyWebhook(tampered, { 'x-kashier-signature': signature })).toThrow(
      BillingSignatureError
    );
  });

  it('rejects a validly-signed payload whose signatureKeys omit the amount', () => {
    const { body, signature } = webhook({}, ['merchantOrderId', 'currency', 'status']);
    expect(() => provider().verifyWebhook(body, { 'x-kashier-signature': signature })).toThrow(
      /does not cover "amount"/
    );
  });

  it('rejects non-JSON bodies', () => {
    expect(() => provider().verifyWebhook('nope', { 'x-kashier-signature': 'x' })).toThrow(
      BillingSignatureError
    );
  });
});

describe('Kashier requests', () => {
  function fakeFetch(status: number, json: unknown) {
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        headers: init.headers as Record<string, string>,
      });
      return new Response(JSON.stringify(json), { status });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }
  const mk = (impl: typeof fetch) =>
    new KashierBillingProvider({
      baseUrl: 'https://kashier.test/',
      merchantId: 'MID-1',
      secretKey: 'sk',
      apiKey: API_KEY,
      fetchImpl: impl,
    });

  it('charges a saved card with a 2-decimal string amount and a unique order id', async () => {
    const f = fakeFetch(200, { status: 'SUCCESS', transactionId: 'T9', cardToken: 'leak' });
    const res = await mk(f.impl).chargeSavedCard({
      token: 'tok',
      amountMinor: 19999,
      currency: 'EGP',
      idempotencyKey: 'sub:1:2026',
      description: 'Growth',
      merchantOrderId: ORDER,
    });
    expect(f.calls[0].url).toBe('https://kashier.test/v3/orders');
    expect(f.calls[0].body.amount).toBe('199.99');
    expect(f.calls[0].body.merchantOrderId).toBe(ORDER);
    expect(f.calls[0].headers.authorization).toBe('sk');
    expect(res).toMatchObject({ status: 'succeeded', chargeId: 'T9' });
    expect(JSON.stringify(res.raw)).not.toContain('leak');
  });

  it('a declined card is a failed result, not an exception', async () => {
    const f = fakeFetch(200, { status: 'FAILURE', message: 'Do not honor' });
    const res = await mk(f.impl).chargeSavedCard({
      token: 't',
      amountMinor: 100,
      currency: 'EGP',
      idempotencyKey: 'k',
      description: 'd',
    });
    expect(res).toMatchObject({ status: 'failed', failureReason: 'Do not honor' });
  });

  it('a 5xx means the outcome is unknown (notCharged=false), a 404 means nothing was charged', async () => {
    const unknown = await mk(fakeFetch(502, {}).impl)
      .chargeSavedCard({
        token: 't',
        amountMinor: 100,
        currency: 'EGP',
        idempotencyKey: 'k',
        description: 'd',
      })
      .catch(e => e);
    expect(unknown).toBeInstanceOf(BillingProviderError);
    expect(unknown.notCharged).toBe(false);
    const refused = await mk(
      fakeFetch(404, { message: "This account isn't enabled for recurring agreements" }).impl
    )
      .chargeSavedCard({
        token: 't',
        amountMinor: 100,
        currency: 'EGP',
        idempotencyKey: 'k',
        description: 'd',
      })
      .catch(e => e);
    expect(refused.notCharged).toBe(true);
  });

  it('refunds via PUT /v3/orders/:id with the partial amount as a decimal string', async () => {
    const f = fakeFetch(200, { status: 'SUCCESS', transactionId: 'R1' });
    await mk(f.impl).refund({ chargeId: 'ORD 1', amountMinor: 5000, idempotencyKey: 'refund:x:1' });
    expect(f.calls[0].url).toBe('https://kashier.test/v3/orders/ORD%201');
    expect((f.calls[0].body.transaction as { amount: string }).amount).toBe('50.00');
  });

  it('creates a hosted checkout and returns the redirect URL', async () => {
    const f = fakeFetch(200, { sessionUrl: 'https://checkout.kashier.test/s/1', _id: 'S1' });
    const out = await mk(f.impl).createCheckoutForSubscription({
      merchantOrderId: ORDER,
      amountMinor: 49900,
      currency: 'EGP',
      description: 'Growth',
      customer: { reference: 'store-1', email: 'a@b.eg' },
      returnUrl: 'https://admin.test/r',
      webhookUrl: 'https://api.test/api/v1/webhooks/billing/kashier',
    });
    expect(out.redirectUrl).toBe('https://checkout.kashier.test/s/1');
    expect(f.calls[0].body.amount).toBe('499.00');
    expect(f.calls[0].body.saveCard).toBe('required');
  });

  it('parseReturn is a hint only', () => {
    const r = provider().parseReturn({ merchantOrderId: ORDER, paymentStatus: 'SUCCESS' });
    expect(r).toMatchObject({ merchantOrderId: ORDER, outcome: 'success', trusted: false });
  });
});

describe('stripTokens', () => {
  it('removes any *token* key at any depth', () => {
    expect(
      stripTokens({ a: 1, cardToken: 'x', n: { deep: { Token: 'y', ok: 2 } }, l: [{ t_token: 1 }] })
    ).toEqual({
      a: 1,
      n: { deep: { ok: 2 } },
      l: [{}],
    });
  });
});

describe('provider selection', () => {
  it('stub is forbidden when NODE_ENV=production', () => {
    expect(() =>
      resolveBillingProviderName({ BILLING_PROVIDER: 'stub', NODE_ENV: 'production' })
    ).toThrow(/forbidden/);
    expect(() => createBillingProvider('stub', { NODE_ENV: 'production' })).toThrow(/forbidden/);
    expect(() =>
      assertBillingConfigAtBoot({ BILLING_PROVIDER: 'stub', NODE_ENV: 'production' })
    ).toThrow(/forbidden/);
  });
  it('stub is allowed outside production and is the dev default', () => {
    expect(resolveBillingProviderName({ BILLING_PROVIDER: 'stub', NODE_ENV: 'test' })).toBe('stub');
    expect(resolveBillingProviderName({ NODE_ENV: 'development' })).toBe('stub');
    expect(createBillingProvider('stub', { NODE_ENV: 'test' })).toBeInstanceOf(StubBillingProvider);
  });
  it('production needs an explicit kashier selection; unknown values throw', () => {
    expect(() => resolveBillingProviderName({ NODE_ENV: 'production' })).toThrow(/must be set/);
    expect(
      resolveBillingProviderName({ BILLING_PROVIDER: 'kashier', NODE_ENV: 'production' })
    ).toBe('kashier');
    expect(() => resolveBillingProviderName({ BILLING_PROVIDER: 'paypal' })).toThrow(/Unknown/);
  });
  it('an unset provider does not stop boot in production', () => {
    expect(() => assertBillingConfigAtBoot({ NODE_ENV: 'production' })).not.toThrow();
  });
});

describe('period helpers', () => {
  it('adds a month in UTC with day clamping', () => {
    expect(addInterval(new Date('2026-01-31T10:00:00Z'), 'monthly').toISOString()).toBe(
      '2026-02-28T10:00:00.000Z'
    );
    expect(addInterval(new Date('2028-01-31T00:00:00Z'), 'monthly').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    );
    expect(addInterval(new Date('2026-12-15T00:00:00Z'), 'monthly').toISOString()).toBe(
      '2027-01-15T00:00:00.000Z'
    );
    expect(addInterval(new Date('2028-02-29T00:00:00Z'), 'yearly').toISOString()).toBe(
      '2029-02-28T00:00:00.000Z'
    );
  });
  it('renewal keys are stable per period and attempt', () => {
    const end = new Date('2026-11-03T04:00:00.000Z');
    expect(renewalKey('s1', end, 0)).toBe('sub:s1:2026-11-03T04:00:00.000Z');
    expect(renewalKey('s1', end, 1)).toBe('sub:s1:2026-11-03T04:00:00.000Z:retry1');
    expect(DUNNING_RETRY_DAYS).toEqual([3, 7]);
  });
});
