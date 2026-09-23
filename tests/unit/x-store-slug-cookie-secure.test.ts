/**
 * S3-3 (2026-09-22 security audit): the `x-store-slug` cookie was `httpOnly`
 * + `sameSite: 'lax'` but had no explicit `Secure` attribute — the browser's
 * own default then leaves the door open to being sent over a plain-http
 * connection. It carries a public slug, not a credential, but every
 * production cookie should still declare Secure explicitly rather than rely
 * on a default.
 *
 * Same technique as `web-middleware-characterization.test.ts`: drive the
 * real `middleware()` export and read the emitted `Set-Cookie` header,
 * rather than grepping the source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../apps/web/middleware';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_TENANT_ROUTING = process.env.STOREFRONT_TENANT_ROUTING;

function setNodeEnv(value: string) {
  // NODE_ENV is typed readonly in some TS lib configs; cast to bypass that
  // for the test only, matching the pattern other suites in this repo use
  // to flip NODE_ENV.
  (process.env as Record<string, string>).NODE_ENV = value;
}

beforeEach(() => {
  delete process.env.STOREFRONT_TENANT_ROUTING;
});

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
  if (ORIGINAL_TENANT_ROUTING === undefined) delete process.env.STOREFRONT_TENANT_ROUTING;
  else process.env.STOREFRONT_TENANT_ROUTING = ORIGINAL_TENANT_ROUTING;
});

function req(url: string, host: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers: { host, ...headers } });
}

describe('S3-3: x-store-slug cookie Secure attribute', () => {
  it('sets Secure in production', () => {
    setNodeEnv('production');
    const res = middleware(req('https://store.force-ai.co/palora/products', 'store.force-ai.co'));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('x-store-slug=palora');
    expect(setCookie).toMatch(/;\s*Secure/i);
  });

  it('does not set Secure outside production (dev over plain http must keep working)', () => {
    setNodeEnv('development');
    const res = middleware(req('https://store.force-ai.co/palora/products', 'store.force-ai.co'));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('x-store-slug=palora');
    expect(setCookie).not.toMatch(/;\s*Secure/i);
  });

  it('is still httpOnly and sameSite=lax in production (unchanged behaviour)', () => {
    setNodeEnv('production');
    const res = middleware(req('https://store.force-ai.co/palora/products', 'store.force-ai.co'));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });
});
