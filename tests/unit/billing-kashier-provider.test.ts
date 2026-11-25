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
  kashierFepBase,
} from '../../apps/api/src/services/billing/kashier.provider';
import {
  BillingProviderError,
  BillingSignatureError,
} from '../../apps/api/src/services/billing/types';
import {
  assertBillingConfigAtBoot,
  billingProviderUnsetWarning,
  createBillingProvider,
  resolveBillingProviderName,
} from '../../apps/api/src/services/billing';
import { StubBillingProvider } from '../../apps/api/src/services/billing/stub.provider';
import {
  addInterval,
  addIntervalAnchored,
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

  it('refunds via PUT /v3/orders/:id with the partial amount as a JSON number', async () => {
    const f = fakeFetch(200, { status: 'SUCCESS', transactionId: 'R1' });
    await mk(f.impl).refund({ chargeId: 'ORD 1', amountMinor: 5000, idempotencyKey: 'refund:x:1' });
    expect(f.calls[0].url).toBe('https://kashier.test/v3/orders/ORD%201');
    expect((f.calls[0].body.transaction as { amount: number }).amount).toBe(50);
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
    expect(f.calls[0].body.saveCard).toBe('forced');
    // Every field the payment-sessions API requires (CreatePaymentSessionRequest).
    for (const k of [
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
      expect(f.calls[0].body[k], k).toBeDefined();
    }
    expect(f.calls[0].body.order).toBe(ORDER);
    expect(new Date(String(f.calls[0].body.expireAt)).getTime()).toBeGreaterThan(Date.now());
    expect(f.calls[0].body.customer).toEqual({ reference: 'store-1', email: 'a@b.eg' });
  });

  it('parseReturn is a hint only', () => {
    const r = provider().parseReturn({ merchantOrderId: ORDER, paymentStatus: 'SUCCESS' });
    expect(r).toMatchObject({ merchantOrderId: ORDER, outcome: 'success', trusted: false });
  });
});

describe('kashierFepBase', () => {
  it('maps the dashboard API host to the FEP host (sandbox and live); leaves other hosts alone', () => {
    expect(kashierFepBase('https://test-api.kashier.io')).toBe('https://test-fep.kashier.io');
    expect(kashierFepBase('https://api.kashier.io')).toBe('https://fep.kashier.io');
    expect(kashierFepBase('https://kashier.test')).toBe('https://kashier.test');
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
  it('an unset provider in production is LOUD (P1 text) but BILLING_PROVIDER=none / kashier / non-production are not (M-032)', () => {
    expect(billingProviderUnsetWarning({ NODE_ENV: 'production' })).toMatch(
      /BILLING_PROVIDER is not set/
    );
    expect(
      billingProviderUnsetWarning({ NODE_ENV: 'production', BILLING_PROVIDER: '  ' })
    ).not.toBeNull();
    expect(
      billingProviderUnsetWarning({ NODE_ENV: 'production', BILLING_PROVIDER: 'none' })
    ).toBeNull();
    expect(
      billingProviderUnsetWarning({ NODE_ENV: 'production', BILLING_PROVIDER: 'kashier' })
    ).toBeNull();
    expect(billingProviderUnsetWarning({ NODE_ENV: 'development' })).toBeNull();
  });
  it('BILLING_PROVIDER=none is the explicit InstaPay-only choice: card billing refuses cleanly', () => {
    expect(() =>
      resolveBillingProviderName({ NODE_ENV: 'production', BILLING_PROVIDER: 'none' })
    ).toThrow(/Card billing is disabled/);
    expect(() =>
      assertBillingConfigAtBoot({ NODE_ENV: 'production', BILLING_PROVIDER: 'none' })
    ).not.toThrow();
    expect(() =>
      assertBillingConfigAtBoot({
        NODE_ENV: 'production',
        BILLING_PROVIDER: 'none',
        BILLING_TRIAL_CARD_MODE: 'pay_at_trial_end',
      })
    ).not.toThrow();
    expect(() =>
      assertBillingConfigAtBoot({
        NODE_ENV: 'production',
        BILLING_PROVIDER: 'none',
        BILLING_TRIAL_CARD_MODE: 'card_on_file',
      })
    ).toThrow(/needs a card provider/);
  });
});

describe('Kashier getChargeStatus (M-023 stuck-charge lookup)', () => {
  const mkGet = (status: number, json: unknown) => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(json), { status });
    }) as unknown as typeof fetch;
    return {
      calls,
      p: new KashierBillingProvider({
        baseUrl: 'https://kashier.test/',
        merchantId: 'MID-1',
        secretKey: 'sk',
        apiKey: API_KEY,
        fetchImpl: impl,
      }),
    };
  };
  const details = (over: Record<string, unknown> = {}) => ({
    body: {
      transactionId: 'TX-1',
      merchantOrderId: ORDER,
      trxType: 'pay',
      status: 'SUCCESS',
      ...over,
    },
  });
  const ask = (p: KashierBillingProvider, chargeId: string | null) =>
    p.getChargeStatus({ idempotencyKey: 'k', merchantOrderId: ORDER, chargeId });

  it('reads the gateway record for the transaction id: success, failure, pending', async () => {
    const ok = mkGet(200, details());
    expect(await ask(ok.p, 'TX-1')).toMatchObject({ status: 'succeeded', chargeId: 'TX-1' });
    expect(ok.calls[0]).toBe('https://kashier.test/v2/aggregator/transactions/TX-1');
    expect(await ask(mkGet(200, details({ status: 'FAILURE' })).p, 'TX-1')).toMatchObject({
      status: 'failed',
    });
    expect(await ask(mkGet(200, details({ status: 'PENDING' })).p, 'TX-1')).toMatchObject({
      status: 'pending',
    });
  });

  it('review of #687: the gateway amount is read as DECIMAL EGP and returned as integer PIASTRES (the ledger unit), with its currency', async () => {
    // 199.99 EGP = 19999 piastres, the same unit the ledger and the webhook compare in: no false amount_mismatch hold
    expect(
      await ask(mkGet(200, details({ amount: '199.99', currency: 'EGP' })).p, 'TX-1')
    ).toMatchObject({
      status: 'succeeded',
      amountMinor: 19999,
      currency: 'EGP',
    });
    expect(
      await ask(mkGet(200, details({ amount: 1000, currency: 'EGP' })).p, 'TX-1')
    ).toMatchObject({
      amountMinor: 100000,
    });
    // an amount on the matching transaction entry wins over the body's, and a body with none states none (the sweep then HOLDS it)
    const entry = mkGet(
      200,
      details({
        amount: '5.00',
        transactions: [{ transactionId: 'TX-1', amount: '12.50', currency: 'EGP' }],
      })
    );
    expect(await ask(entry.p, 'TX-1')).toMatchObject({ amountMinor: 1250 });
    expect(await ask(mkGet(200, details()).p, 'TX-1')).toMatchObject({
      status: 'succeeded',
      amountMinor: null,
      currency: null,
    });
  });

  it('with NO transaction id it throws (cannot tell) and never claims "not found"; so does anything unclear', async () => {
    const f = mkGet(200, details());
    await expect(ask(f.p, null)).rejects.toThrow(/without a transaction id/);
    expect(f.calls).toHaveLength(0); // no network call, no guess
    await expect(ask(mkGet(200, details({ transactionId: 'OTHER' })).p, 'TX-1')).rejects.toThrow(
      /did not answer clearly/
    );
    await expect(ask(mkGet(200, details({ trxType: 'refund' })).p, 'TX-1')).rejects.toThrow(
      /not a charge/
    );
    await expect(ask(mkGet(500, {}).p, 'TX-1')).rejects.toThrow();
  });
});

describe('period helpers', () => {
  it('M-125: the anchor day survives short months (Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31) and leap years', () => {
    let d = new Date('2027-01-31T10:00:00Z');
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      d = addIntervalAnchored(d, 'monthly', 31);
      seen.push(d.toISOString().slice(0, 10));
    }
    expect(seen).toEqual(['2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
    // without an anchor the old clamp-from-previous behaviour is unchanged
    expect(
      addIntervalAnchored(new Date('2027-02-28T10:00:00Z'), 'monthly').toISOString().slice(0, 10)
    ).toBe('2027-03-28');
    // yearly from Feb 29 and back to Feb 29 on the next leap year
    expect(
      addIntervalAnchored(new Date('2028-02-29T00:00:00Z'), 'yearly', 29).toISOString().slice(0, 10)
    ).toBe('2029-02-28');
    expect(
      addIntervalAnchored(new Date('2031-02-28T00:00:00Z'), 'yearly', 29).toISOString().slice(0, 10)
    ).toBe('2032-02-29');
    // an invalid anchor falls back to the day of `from`
    expect(
      addIntervalAnchored(new Date('2027-01-15T00:00:00Z'), 'monthly', 99)
        .toISOString()
        .slice(0, 10)
    ).toBe('2027-02-15');
  });

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
