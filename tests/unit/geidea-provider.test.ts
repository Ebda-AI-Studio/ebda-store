/**
 * Geidea adapter, creation only (PLANS-ALL-1, PROVIDERS-3). The request signature is Geidea's
 * published sample (docs.geidea.net/docs/geidea-checkout-v2); everything Geidea does not publish
 * (callback, status, refund) fails closed.
 */
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGeideaProvider,
  geideaSessionSignature,
  geideaTimestamp,
} from '@api/services/payment-providers/geidea.provider';
import {
  PaymentProviderError,
  type ProviderCredentials,
} from '@api/services/payment-providers/types';
import {
  extractWebhookSignature,
  GATEWAY_WEBHOOK_PROVIDERS,
} from '@api/services/payment-providers/webhook-signature';

const creds: ProviderCredentials = { mode: 'sandbox', merchantId: 'pubkey-1', apiKey: 'apipass-1' };
const req = {
  orderId: 'o1',
  orderNumber: 'EB-100',
  amountMinor: 150_00,
  currency: 'EGP' as const,
  customer: { name: 'Mona', email: 'm@example.test', language: 'ar' as const },
  returnUrls: { success: 'https://shop.example/ok', failure: 'https://shop.example/no' },
  webhookUrl: 'https://api.example/webhooks/geidea/s1',
  idempotencyKey: 'o1:geidea:1',
};

afterEach(() => {
  delete process.env.GEIDEA_HPP_BASE_URL;
  vi.restoreAllMocks();
});

describe('geidea request signature (the documented sample)', () => {
  it('is base64(HMAC-SHA256(apiPassword, publicKey+amount+currency+ref+timestamp))', () => {
    const want = crypto
      .createHmac('sha256', 'pw')
      .update('PK150.00EGPREF2026/10/26 10:00:00')
      .digest('base64');
    expect(geideaSessionSignature('PK', '150.00', 'EGP', 'REF', '2026/10/26 10:00:00', 'pw')).toBe(
      want
    );
  });
  it('timestamp is Y/m/d H:i:s', () => {
    expect(geideaTimestamp(new Date(Date.UTC(2026, 9, 6, 4, 5, 7)))).toBe('2026/10/06 04:05:07');
  });
});

describe('geidea createPayment', () => {
  it('fails closed when the Egypt hosted-page address is not configured, before any session', async () => {
    const fetchImpl = vi.fn();
    const p = createGeideaProvider({ fetchImpl });
    await expect(p.createPayment(req, creds)).rejects.toMatchObject({
      code: 'PROVIDER_MISCONFIGURED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('creates a signed session with Basic auth and returns the hosted redirect', async () => {
    process.env.GEIDEA_HPP_BASE_URL = 'https://hpp.example.test';
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const sig = geideaSessionSignature(
        'pubkey-1',
        '150.00',
        'EGP',
        body.merchantReferenceId,
        body.timestamp,
        'apipass-1'
      );
      expect(body.signature).toBe(sig);
      expect(body.amount).toBe(150);
      expect(body.callbackUrl).toBe(req.webhookUrl);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from('pubkey-1:apipass-1').toString('base64')}`
      );
      return new Response(JSON.stringify({ responseCode: '000', session: { id: 'sess-9' } }), {
        status: 200,
      });
    });
    const p = createGeideaProvider({ fetchImpl });
    const r = await p.createPayment(req, creds);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.merchant.geidea.net/payment-intent/api/v2/direct/session'
    );
    expect(r.instruction).toMatchObject({
      kind: 'redirect',
      url: 'https://hpp.example.test/hpp/checkout/?sess-9',
    });
    expect(r.amountMinor).toBe(150_00);
    expect(JSON.stringify(r)).not.toContain('apipass-1');
    // same key again: no second session
    await p.createPayment(req, creds);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-000 response and a non-https callback', async () => {
    process.env.GEIDEA_HPP_BASE_URL = 'https://hpp.example.test';
    const p = createGeideaProvider({
      fetchImpl: async () => new Response(JSON.stringify({ responseCode: '100' }), { status: 200 }),
    });
    await expect(p.createPayment(req, creds)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    await expect(
      p.createPayment({ ...req, idempotencyKey: 'k2', webhookUrl: 'http://x' }, creds)
    ).rejects.toMatchObject({ code: 'PROVIDER_MISCONFIGURED' });
  });
});

describe('geidea fail-closed surface', () => {
  const p = createGeideaProvider();
  it('refuses every webhook delivery, whatever it carries', () => {
    expect(() => p.verifyWebhook('{"signature":"x"}', {}, creds)).toThrow(PaymentProviderError);
    try {
      p.verifyWebhook('{}', {}, creds);
    } catch (e) {
      expect((e as PaymentProviderError).code).toBe('WEBHOOK_BAD_SIGNATURE');
    }
  });
  it('has no signature extractor, so the route answers 401 before the adapter', () => {
    expect(GATEWAY_WEBHOOK_PROVIDERS).toContain('geidea');
    expect(extractWebhookSignature('geidea', { query: {}, headers: {} }, { signature: 'x' })).toBe(
      ''
    );
  });
  it('has no remote status, refund or partial refund', async () => {
    await expect(p.getStatus('r', creds)).rejects.toMatchObject({ code: 'STATUS_NOT_SUPPORTED' });
    await expect(p.refund({} as never, creds)).rejects.toMatchObject({
      code: 'REFUND_NOT_SUPPORTED',
    });
    await expect(p.partialRefund({} as never, creds)).rejects.toMatchObject({
      code: 'REFUND_NOT_SUPPORTED',
    });
    expect(p.testConnection).toBeUndefined();
  });
});
