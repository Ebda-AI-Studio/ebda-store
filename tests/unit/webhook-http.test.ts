/**
 * Outgoing webhook transport: HMAC signature + replay window, and the SSRF guard that is
 * re-checked at SEND time (not only at registration).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setHostResolver, type HostResolver } from '@api/lib/safe-fetch';
import {
  signWebhook,
  verifyWebhookSignature,
  postWebhook,
  assertWebhookUrl,
} from '@api/lib/webhook-http';

const pub: HostResolver = async () => [{ address: '93.184.216.34' }];
let restore: HostResolver | null = null;
const useResolver = (r: HostResolver) => {
  const prev = setHostResolver(r);
  restore ??= prev;
};
afterEach(() => {
  if (restore) setHostResolver(restore);
  restore = null;
  vi.restoreAllMocks();
});

const SECRET = 'whsec_test_secret';
const base = {
  url: 'https://hooks.example.com/in',
  secret: SECRET,
  body: '{"a":1}',
  eventId: 'evt_1',
  deliveryId: 'dl_1',
  eventType: 'order.created' as const,
};

describe('signature', () => {
  it('signs "<t>.<body>" with HMAC-SHA256 and verifies', () => {
    const h = signWebhook(SECRET, '{"a":1}', 1_700_000_000);
    expect(h).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(SECRET, '{"a":1}', h, { nowSec: 1_700_000_100 })).toBe(true);
  });
  it('rejects a tampered body, a wrong secret, and a stale or future timestamp', () => {
    const h = signWebhook(SECRET, '{"a":1}', 1_700_000_000);
    expect(verifyWebhookSignature(SECRET, '{"a":2}', h, { nowSec: 1_700_000_000 })).toBe(false);
    expect(verifyWebhookSignature('whsec_other', '{"a":1}', h, { nowSec: 1_700_000_000 })).toBe(
      false
    );
    expect(verifyWebhookSignature(SECRET, '{"a":1}', h, { nowSec: 1_700_000_000 + 301 })).toBe(
      false
    );
    expect(verifyWebhookSignature(SECRET, '{"a":1}', h, { nowSec: 1_700_000_000 - 301 })).toBe(
      false
    );
    expect(verifyWebhookSignature(SECRET, '{"a":1}', 'garbage', { nowSec: 1_700_000_000 })).toBe(
      false
    );
  });
});

describe('SSRF guard (registration and send time)', () => {
  it.each([
    ['http://hooks.example.com/x', 'https'],
    ['https://127.0.0.1/x', 'IP'],
    ['https://[::1]/x', 'IP'],
    ['https://169.254.169.254/latest/meta-data', 'IP'],
  ])('refuses %s', async url => {
    useResolver(pub);
    await expect(assertWebhookUrl(url)).rejects.toThrow(/WEBHOOK_URL_BLOCKED|SSRF_BLOCKED/);
  });

  it.each([
    '10.0.0.5',
    '172.16.9.1',
    '192.168.1.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '192.0.2.7',
    '198.51.100.9',
    '203.0.113.4',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
  ])('refuses a hostname that resolves to %s', async addr => {
    useResolver(async () => [{ address: addr }]);
    await expect(assertWebhookUrl('https://hooks.example.com/x')).rejects.toThrow(/SSRF_BLOCKED/);
  });

  it('refuses when ANY of several answers is private', async () => {
    useResolver(async () => [{ address: '93.184.216.34' }, { address: '10.1.1.1' }]);
    await expect(assertWebhookUrl('https://hooks.example.com/x')).rejects.toThrow(/SSRF_BLOCKED/);
  });

  it('DNS rebinding: public at registration, private at send time -> no request is made', async () => {
    useResolver(pub);
    await expect(assertWebhookUrl(base.url)).resolves.toBeInstanceOf(URL);
    useResolver(async () => [{ address: '127.0.0.1' }]);
    const fetchImpl = vi.fn();
    const r = await postWebhook({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('postWebhook', () => {
  it('sends the signed headers and body, with redirect:manual and a timeout signal', async () => {
    useResolver(pub);
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const r = await postWebhook({
      ...base,
      nowSec: 1_700_000_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: true, status: 200, snippet: 'ok' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(base.url);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.body).toBe(base.body);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const h = new Headers(init.headers);
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('x-ebda-event-id')).toBe('evt_1');
    expect(h.get('x-ebda-delivery-id')).toBe('dl_1');
    expect(h.get('x-ebda-event')).toBe('order.created');
    expect(h.get('x-ebda-signature')).toBe(signWebhook(SECRET, base.body, 1_700_000_000));
  });

  it('treats a redirect as a failure and never requests the Location (even a private one)', async () => {
    useResolver(pub);
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
    );
    const r = await postWebhook({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(302);
    expect(r.error).toBe('redirect_not_followed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails on non-2xx and keeps only a short snippet of the body', async () => {
    useResolver(pub);
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(5000), { status: 500 }));
    const r = await postWebhook({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.snippet!.length).toBeLessThanOrEqual(200);
    expect(r.error).toBe('http_500');
  });

  it('reports a timeout / network error without throwing', async () => {
    useResolver(pub);
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    const r = await postWebhook({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
  });
});
