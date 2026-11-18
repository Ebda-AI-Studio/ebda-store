/**
 * Ruling WA-COD-V2-2, hardening of the guest order-status link: per-shopper rate limit behind the storefront's server render
 * (RL-SSR-IP-6), the bearer token never reaching a log line, and the page's headers.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { redactPathSecrets, redactSensitiveQuery } from '@ebda/shared';
import {
  CLIENT_IP_HEADER,
  SSR_AUTH_HEADER,
  SSR_FORWARD_ROUTES,
  isForwardableRead,
  resolveClientAddress,
} from '@api/cf/ssr-client-ip';
import { orderStatusLimiter } from '@api/middleware/order-status-limiter';
import { applyOrderLinkHeaders } from '../../apps/web/src/lib/order-link-headers';
import { signClientIp } from '../../apps/web/ssr-client-address';

const SECRET = 'test-revalidate-secret';
const EGRESS = '2a06:98c0:3600::103';
const STORE = '11111111-1111-4111-8111-111111111111';
const ORDER = '33333333-3333-4333-8333-333333333333';
const TOKEN = `${STORE}.${ORDER}.1795000000.${'A'.repeat(43)}`;
const PATH = `/api/v1/public/order-status/${TOKEN}`;

/** What the Worker does before Express: resolve the address, then the app sees it as X-Forwarded-For (trust proxy). */
async function viaWorker(app: express.Express, headers: Record<string, string>) {
  const r = await resolveClientAddress(
    new Request(`https://api.ebda.app${PATH}`, {
      headers: { 'cf-connecting-ip': EGRESS, ...headers },
    }),
    SECRET
  );
  const req = request(app).get('/limited');
  if (r.ip) req.set('X-Forwarded-For', r.ip);
  return req;
}

describe('order-status route is charged to the shopper, not the storefront Worker', () => {
  it('is a forwarded storefront read', () => {
    expect(SSR_FORWARD_ROUTES['/order-status/:token']).toBe('forward');
    expect(isForwardableRead('GET', PATH)).toBe(true);
  });

  it('two shoppers behind the same storefront egress get separate buckets; an unsigned forwarded address is ignored', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.get(
      '/limited',
      orderStatusLimiter(() => false),
      (_q, s) => void s.json({ ok: true })
    );
    const signed = async (ip: string) => ({
      [CLIENT_IP_HEADER]: ip,
      [SSR_AUTH_HEADER]: await signClientIp(SECRET, ip),
    });
    const a = await signed('203.0.113.7');
    const b = await signed('203.0.113.8');
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await viaWorker(app, a)).status;
    expect(last).toBe(429); // shopper A spent their 30
    expect((await viaWorker(app, b)).status).toBe(200); // shopper B has their own bucket
    // An attacker cannot pick a fresh bucket: an unsigned address is dropped and the Worker-seen address stands (one shared bucket).
    const forged = (n: number) =>
      viaWorker(app, { [CLIENT_IP_HEADER]: `198.51.100.${n}`, [SSR_AUTH_HEADER]: 'ab'.repeat(32) });
    expect((await forged(1)).status).toBe(200);
    for (let i = 0; i < 30; i++) await forged(2 + i);
    expect((await forged(99)).status).toBe(429); // rotating the claimed address did not reset the bucket
  });
});

describe('the token never reaches a log line or an error report', () => {
  it('is masked in the API path, the storefront path, a full URL and a router-relative path', () => {
    for (const text of [
      PATH,
      `/o/${TOKEN}`,
      `https://souq.ebda.app/o/${TOKEN}`,
      `GET https://api.ebda.app${PATH}?x=1`,
      `/${TOKEN}`,
    ]) {
      const out = redactPathSecrets(text);
      expect(out, text).not.toContain(STORE);
      expect(out, text).not.toContain(ORDER);
      expect(out, text).not.toContain('AAAAAAAAAA');
    }
    expect(redactPathSecrets(PATH)).toBe('/api/v1/public/order-status/[Filtered]');
    // the error-report scrubber (Sentry, PostHog) masks it too
    expect(redactSensitiveQuery(`https://souq.ebda.app/o/${TOKEN}`)).toBe(
      'https://souq.ebda.app/o/[Filtered]'
    );
  });
  it('leaves ordinary paths alone', () => {
    expect(redactPathSecrets('/api/v1/public/products/blue-shirt')).toBe(
      '/api/v1/public/products/blue-shirt'
    );
    expect(redactPathSecrets('/api/v1/public/orders/not-a-token')).toBe(
      '/api/v1/public/orders/not-a-token'
    );
  });
});

describe('/o/<token> page headers', () => {
  it('are no-store, no-referrer and noindex on the page, and absent elsewhere', () => {
    const h = new Headers();
    applyOrderLinkHeaders(`/o/${TOKEN}`, h);
    expect(h.get('cache-control')).toBe('private, no-store');
    expect(h.get('referrer-policy')).toBe('no-referrer');
    expect(h.get('x-robots-tag')).toContain('noindex');
    for (const p of ['/', '/products/o', '/o', '/o/a/b', '/account/orders/x']) {
      const other = new Headers();
      applyOrderLinkHeaders(p, other);
      expect([...other.keys()], p).toEqual([]);
    }
  });
});
