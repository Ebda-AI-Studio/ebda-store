import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

/**
 * scoped-audit P2 follow-up on PR #1942: the agent-discovery routes
 * (llms.txt, .well-known/acp.json, .well-known/ucp) need to tell "the store
 * came from the URL" apart from "the store came from the sticky x-store-slug
 * cookie fallback" so a cookie-resolved response can be marked non-shared-
 * cacheable. middleware.ts signals this via `x-store-slug-source: cookie`,
 * set ONLY on the cookie-fallback branch (a subroute with no slug segment in
 * the URL) and explicitly cleared on every other branch — including when a
 * client sends the header itself, since `requestHeaders` starts as a clone
 * of the raw incoming request.
 *
 * Next.js exposes what a `NextResponse.rewrite/next(..., {request: {headers}})`
 * call actually forwards downstream via `x-middleware-request-<header>`
 * response headers — that's what these tests read, not the response's own
 * headers.
 */
function forwardedHeader(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`);
}

describe('middleware — x-store-slug-source signal', () => {
  // Since #1959 (merged via the security batch) the agent/feed documents never
  // resolve from the sticky cookie at all — they are shared-cacheable and must
  // be keyed by URL/Host alone. That supersedes marking a cookie-resolved
  // response: there is no cookie-resolved response to mark.
  it('does NOT resolve a bare well-known path from the sticky cookie', async () => {
    const req = new NextRequest('https://ebda.app/.well-known/acp.json', {
      headers: { host: 'ebda.app', cookie: 'x-store-slug=pecanbee' },
    });
    const res = middleware(req);
    expect(forwardedHeader(res, 'x-store-slug')).toBeNull();
    expect(forwardedHeader(res, 'x-store-slug-source')).toBeNull();
  });

  it('does NOT resolve a bare /llms.txt from the sticky cookie', async () => {
    const req = new NextRequest('https://ebda.app/llms.txt', {
      headers: { host: 'ebda.app', cookie: 'x-store-slug=pecanbee' },
    });
    const res = middleware(req);
    expect(forwardedHeader(res, 'x-store-slug')).toBeNull();
    expect(forwardedHeader(res, 'x-store-slug-source')).toBeNull();
  });

  it('still sets x-store-slug-source: cookie on an ordinary subroute resolved from the cookie', async () => {
    const req = new NextRequest('https://ebda.app/products', {
      headers: { host: 'ebda.app', cookie: 'x-store-slug=pecanbee' },
    });
    const res = middleware(req);
    expect(forwardedHeader(res, 'x-store-slug')).toBe('pecanbee');
    expect(forwardedHeader(res, 'x-store-slug-source')).toBe('cookie');
  });

  it('does NOT set x-store-slug-source when the slug comes from the URL', async () => {
    const req = new NextRequest('https://ebda.app/pecanbee/.well-known/acp.json', {
      headers: { host: 'ebda.app' },
    });
    const res = middleware(req);
    expect(forwardedHeader(res, 'x-store-slug')).toBe('pecanbee');
    expect(forwardedHeader(res, 'x-store-slug-source')).toBeNull();
  });

  it('does NOT set x-store-slug-source on a custom domain', async () => {
    const req = new NextRequest('https://wadyaljuz.com/.well-known/acp.json', {
      headers: { host: 'wadyaljuz.com' },
    });
    const res = middleware(req);
    expect(forwardedHeader(res, 'x-store-domain')).toBe('wadyaljuz.com');
    expect(forwardedHeader(res, 'x-store-slug-source')).toBeNull();
  });

  it('strips a client-spoofed x-store-slug-source on a URL-slug request (anti-spoof)', async () => {
    // requestHeaders is seeded from the raw request, so without an explicit
    // clear this client-supplied value would pass straight through and wrongly
    // mark a legitimately URL-resolved response non-shared-cacheable.
    const req = new NextRequest('https://ebda.app/pecanbee/.well-known/acp.json', {
      headers: { host: 'ebda.app', 'x-store-slug-source': 'cookie' },
    });
    const res = middleware(req);
    expect(forwardedHeader(res, 'x-store-slug-source')).toBeNull();
  });

  it('strips a client-spoofed x-store-slug-source on a custom-domain request (anti-spoof)', async () => {
    const req = new NextRequest('https://wadyaljuz.com/.well-known/acp.json', {
      headers: { host: 'wadyaljuz.com', 'x-store-slug-source': 'cookie' },
    });
    const res = middleware(req);
    expect(forwardedHeader(res, 'x-store-slug-source')).toBeNull();
  });
});
