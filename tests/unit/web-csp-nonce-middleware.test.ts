/**
 * Ruling CSP-WEB-1: the storefront middleware mints a fresh CSP nonce per request, hands the SAME policy to Next on
 * the request (that is how Next stamps the nonce on its own scripts), sets it on every response, and never trusts a
 * client-sent nonce. Red if: two requests share a nonce, the policy regains unsafe-inline/unsafe-eval, a rewrite or a
 * 404 goes out without a policy, or next.config.js emits a second (static) CSP that would fight the nonce one.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { isValidCspNonce } from '@ebda/shared';
import { middleware } from '../../apps/web/middleware';

const OVERRIDE = 'x-middleware-override-headers';
const reqHeader = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);
const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
const run = (url: string, headers: Record<string, string> = {}) =>
  middleware(
    new NextRequest(url, { headers: { host: new URL(url).host, ...headers } })
  ) as Response;

const STORE = 'https://some-shop.ebda.app/ar';

describe('storefront middleware CSP nonce', () => {
  it('sets a nonce + strict-dynamic policy with no unsafe-inline/eval, identical on request and response', () => {
    const res = run(STORE);
    const csp = res.headers.get('Content-Security-Policy')!;
    const nonce = nonceOf(csp);
    expect(isValidCspNonce(nonce)).toBe(true);
    const scriptSrc = csp.split('; ').find(d => d.startsWith('script-src '))!;
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(res.headers.get(OVERRIDE)).toContain('content-security-policy');
    expect(reqHeader(res, 'content-security-policy')).toBe(csp);
    expect(reqHeader(res, 'x-nonce')).toBe(nonce);
  });

  it('a new nonce on every request', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++)
      seen.add(nonceOf(run(STORE).headers.get('Content-Security-Policy')!));
    expect(seen.size).toBe(50);
  });

  it('ignores a client-sent x-nonce and CSP request header', () => {
    const res = run(STORE, {
      'x-nonce': 'attacker',
      'content-security-policy': "script-src 'unsafe-inline'",
    });
    expect(reqHeader(res, 'x-nonce')).not.toBe('attacker');
    expect(reqHeader(res, 'content-security-policy')).toContain("'strict-dynamic'");
    expect(reqHeader(res, 'content-security-policy')).not.toContain("script-src 'unsafe-inline'");
  });

  it('a 404 for a host that is not a store also carries the policy', () => {
    const res = run('https://x.y.ebda.app/');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Security-Policy')).toContain("'strict-dynamic'");
  });

  it('keeps next.config.js free of a second (static) Content-Security-Policy', () => {
    const cfg = fs.readFileSync(path.resolve(__dirname, '../../apps/web/next.config.js'), 'utf8');
    expect(cfg.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')).not.toContain('Content-Security-Policy');
  });

  it('every executable inline script in the root layout carries the nonce', () => {
    const layout = fs.readFileSync(
      path.resolve(__dirname, '../../apps/web/src/app/layout.tsx'),
      'utf8'
    );
    const scripts = [...layout.matchAll(/<script\b[^>]*>/g)].map(m => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of layout.match(/<script\s[^>]*?(?=dangerouslySetInnerHTML)/gs) ?? []) {
      if (!s.includes('application/ld+json')) expect(s).toContain('nonce={nonce}');
    }
  });
});
