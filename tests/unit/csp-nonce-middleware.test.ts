/**
 * SEC-4 / M-067: the admin and Orders middleware mint a fresh CSP nonce per request, hand the SAME
 * policy to Next on the request (that is how Next stamps the nonce on its own scripts) and set it on
 * the response. Red if: two requests share a nonce, request and response policies differ, the
 * response policy loses the nonce, or `x-nonce` (read by the admin root layout) stops being set.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { isValidCspNonce, newCspNonce, nonceScriptSrc } from '@ebda/shared';
import {
  middleware as adminMiddleware,
  config as adminMatcher,
} from '../../apps/admin/src/middleware';
import {
  middleware as ordersMiddleware,
  config as ordersMatcher,
} from '../../apps/orders/src/middleware';

// NextResponse.next({ request: { headers } }) reports the overridden REQUEST headers to the router
// through these two response headers.
const OVERRIDE = 'x-middleware-override-headers';
const reqHeader = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1] ?? '';

describe.each([
  ['admin', adminMiddleware, 'https://store.ebda.app/stores/s1/orders'],
  ['orders', ordersMiddleware, 'https://orders.ebda.app/orders'],
] as const)('%s middleware', (_app, mw, url) => {
  it('sets a nonce CSP on the response and the identical policy + x-nonce on the request', () => {
    const res = mw(new NextRequest(url)) as unknown as Response;
    const csp = res.headers.get('Content-Security-Policy')!;
    const nonce = nonceOf(csp);
    expect(isValidCspNonce(nonce)).toBe(true);
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(res.headers.get(OVERRIDE)).toContain('content-security-policy');
    expect(reqHeader(res, 'content-security-policy')).toBe(csp);
    expect(reqHeader(res, 'x-nonce')).toBe(nonce);
  });

  it('a new nonce on every request', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const res = mw(new NextRequest(url)) as unknown as Response;
      seen.add(nonceOf(res.headers.get('Content-Security-Policy')!));
    }
    expect(seen.size).toBe(50);
  });
});

describe('nonce helpers', () => {
  it('newCspNonce is valid base64 of 128 bits and nonceScriptSrc never emits unsafe-inline', () => {
    const n = newCspNonce();
    expect(isValidCspNonce(n)).toBe(true);
    expect(atob(n).length).toBe(16);
    expect(nonceScriptSrc(n)).toBe(`script-src 'self' 'nonce-${n}' 'strict-dynamic'`);
    expect(nonceScriptSrc(n, { unsafeEval: true })).toContain("'unsafe-eval'");
  });
  it('rejects anything that could break out of a header', () => {
    for (const bad of ['', 'a b', "x'; script-src *", 'AAAA\r\nSet-Cookie: x', null, 5]) {
      expect(isValidCspNonce(bad)).toBe(false);
    }
  });
});

describe('middleware matcher (Opus review SEC-4)', () => {
  const toRe = (m: string) => new RegExp(`^${m}$`);
  it.each([
    ['admin', adminMatcher],
    ['orders', ordersMatcher],
  ])('%s: any path that is not a named static asset gets the CSP, extension or not', (_n, cfg) => {
    const re = toRe(cfg.matcher[0]);
    for (const p of [
      '/',
      '/login',
      '/stores/abc/settings',
      '/stores/a.b/settings',
      '/users/x.y',
      '/foo.svg',
      '/foo.js',
      '/api/data.json',
      '/robots.txt',
      '/healthz',
      '/icons',
    ])
      expect(re.test(p), p).toBe(true);
    for (const p of [
      '/_next/static/chunks/a.js',
      '/_next/image',
      '/icons/icon-192.png',
      '/icons/x.svg',
      '/favicon.ico',
      '/health',
      '/manifest.webmanifest',
      '/sw.js',
    ])
      expect(re.test(p), p).toBe(false);
  });

  it('admin no longer carves out the OneSignal worker path (the SDK is gone from the admin)', () => {
    expect(toRe(adminMatcher.matcher[0]).test('/OneSignalSDKWorker.js')).toBe(true);
    expect(toRe(ordersMatcher.matcher[0]).test('/OneSignalSDKWorker.js')).toBe(false);
  });

  it.each(['admin', 'orders'])(
    '%s: the asset-layer _headers gives a strict CSP to svg and /icons, and none to the workers',
    app => {
      const h = fs.readFileSync(
        path.resolve(__dirname, `../../apps/${app}/public/_headers`),
        'utf8'
      );
      const block = (sel: string) => h.split('\n').slice(h.split('\n').indexOf(sel) + 1)[0] ?? '';
      for (const sel of ['/*.svg', '/icons/*']) {
        const line = block(sel);
        expect(line, sel).toContain("default-src 'none'");
        expect(line, sel).toContain("frame-ancestors 'none'");
      }
      expect(h).not.toMatch(/^\/\*\n\s+Content-Security-Policy/m);
    }
  );

  it('next.config.js does not also set a CSP (OpenNext would let it override or double the nonce policy)', () => {
    for (const app of ['admin', 'orders']) {
      const cfg = fs.readFileSync(
        path.resolve(__dirname, `../../apps/${app}/next.config.js`),
        'utf8'
      );
      expect(cfg.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')).not.toContain('Content-Security-Policy');
    }
  });
});
