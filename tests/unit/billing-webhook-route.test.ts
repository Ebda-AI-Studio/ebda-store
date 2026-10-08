/**
 * PROVIDERS-20 — `POST /api/v1/webhooks/billing/:provider` never answers 500.
 *
 * Production had no `BILLING_PROVIDER` (InstaPay-only funnel), so `getBillingProvider` threw
 * "BILLING_PROVIDER must be set ..." and every delivery became a 500. Now: billing not set up
 * (or Kashier without its keys) = 503 BILLING_NOT_CONFIGURED; a missing or wrong signature on
 * a configured provider = 401; an unknown provider = 404. No database, no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import billingWebhookRoutes from '@api/routes/billing-webhook.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { setBillingProviderForTests } from '@api/services/billing';
import { kashierSignaturePayload } from '@api/services/billing/kashier.provider';

const KEYS = [
  'NODE_ENV',
  'BILLING_PROVIDER',
  'KASHIER_MERCHANT_ID',
  'KASHIER_API_KEY',
  'KASHIER_SECRET_KEY',
];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));

function app() {
  const a = express();
  a.use('/api/v1/webhooks/billing', express.raw({ type: () => true }), billingWebhookRoutes);
  a.use(errorHandler);
  return a;
}
/** Production with the given billing env; the provider cache is rebuilt from it. */
function env(vars: Record<string, string | undefined>) {
  process.env.NODE_ENV = 'production';
  for (const k of KEYS.slice(1)) delete process.env[k];
  Object.assign(process.env, vars);
  setBillingProviderForTests(null);
}
const post = (body: string, headers: Record<string, string> = {}, provider = 'kashier') =>
  request(app())
    .post(`/api/v1/webhooks/billing/${provider}`)
    .set({ 'content-type': 'application/json', ...headers })
    .send(body);

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setBillingProviderForTests(null);
});

describe('billing webhook route: never a 500', () => {
  it('billing not configured in production (no BILLING_PROVIDER) -> 503 BILLING_NOT_CONFIGURED', async () => {
    env({});
    const res = await post('{}');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('BILLING_NOT_CONFIGURED');
  });

  it('BILLING_PROVIDER=kashier without its keys -> 503 BILLING_NOT_CONFIGURED', async () => {
    env({ BILLING_PROVIDER: 'kashier', KASHIER_MERCHANT_ID: 'MID-1-1' });
    const res = await post('{}', { 'x-kashier-signature': 'a'.repeat(64) });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('BILLING_NOT_CONFIGURED');
  });

  describe('configured Kashier', () => {
    const configured = () =>
      env({
        BILLING_PROVIDER: 'kashier',
        KASHIER_MERCHANT_ID: 'MID-1-1',
        KASHIER_API_KEY: 'billing-api-key',
        KASHIER_SECRET_KEY: 'billing-secret-key',
      });

    it('an empty body with no signature -> 401', async () => {
      configured();
      const res = await post('{}');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    });

    it('a wrong signature -> 401; one signed with another key -> 401', async () => {
      configured();
      const data: Record<string, unknown> = {
        merchantOrderId: 'x',
        transactionId: 'TX-1',
        status: 'SUCCESS',
        amount: '1.00',
        currency: 'EGP',
        signatureKeys: ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'],
      };
      const body = JSON.stringify({ event: 'pay', data });
      expect((await post(body, { 'x-kashier-signature': 'f'.repeat(64) })).status).toBe(401);
      const forged = crypto
        .createHmac('sha256', 'not-the-key')
        .update(kashierSignaturePayload(data, data.signatureKeys as string[]))
        .digest('hex');
      expect((await post(body, { 'x-kashier-signature': forged })).status).toBe(401);
    });

    it('a provider this deployment does not serve -> 404', async () => {
      configured();
      expect((await post('{}', {}, 'stub')).status).toBe(404);
      expect((await post('{}', {}, 'paypal')).status).toBe(404);
    });
  });
});
