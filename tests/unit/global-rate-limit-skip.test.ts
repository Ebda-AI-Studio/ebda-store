/**
 * `/auth/refresh` is counted by ONE bucket, not two.
 *
 * Ruling P2-B2-3 enumerated the buckets refresh shared and missed this one.
 * The global limiter is mounted app-level, counts every mutation, uses the
 * DEFAULT key generator — per IP, no per-user scoping — and caps at 200 per 15
 * minutes. `POST /auth/refresh` is a mutation, so after giving refresh its own
 * user-scoped bucket it was still sharing an IP-wide counter with every order
 * creation, cart write and admin save. The "every user behind a NAT shares one
 * bucket" failure the dedicated limiter exists to end, one layer up.
 *
 * The predicate was inline, which made it a closure no test could reach, and
 * the limiter is disabled under vitest — so every branch of it was
 * unobservable. It lives in its own module now and this suite executes it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { skipGlobalRateLimit } from '@api/middleware/global-rate-limit-skip';

const req = (over: Partial<Request> = {}): Request =>
  ({
    method: 'POST',
    path: '/api/v1/orders',
    header: () => undefined,
    ...over,
  }) as unknown as Request;

// Builds a request carrying (or not) the Inngest signature header, matching
// how express's `req.header()` reads it case-insensitively.
const inngestReq = (opts: { signature?: string; path?: string; method?: string } = {}): Request =>
  req({
    method: opts.method ?? 'POST',
    path: opts.path ?? '/api/v1/inngest',
    header: (name: string) =>
      name.toLowerCase() === 'x-inngest-signature' ? opts.signature : undefined,
  });

// Bypass 0 short-circuits on the test env, so every other branch is dead under
// vitest unless these are cleared. Without this the suite would pass no matter
// what the predicate said.
const SAVED = { node: process.env.NODE_ENV, vitest: process.env.VITEST };
beforeEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.VITEST;
  delete process.env.LOAD_TEST_BYPASS_TOKEN;
});
afterEach(() => {
  if (SAVED.node !== undefined) process.env.NODE_ENV = SAVED.node;
  if (SAVED.vitest !== undefined) process.env.VITEST = SAVED.vitest;
});

describe('the global mutation limiter skips the refresh route', () => {
  it('lets POST /api/v1/auth/refresh past uncounted', () => {
    expect(skipGlobalRateLimit(req({ path: '/api/v1/auth/refresh' }))).toBe(true);
  });

  it('still counts every other mutation', () => {
    // The negative control. A predicate that returned true for everything
    // would satisfy the case above and disable the limiter platform-wide.
    for (const path of [
      '/api/v1/orders',
      '/api/v1/stores/s1/cart/items',
      '/api/v1/auth/login',
      '/api/v1/auth/register',
      '/api/v1/payments/tap/charge',
    ]) {
      expect(skipGlobalRateLimit(req({ path })), `${path} must stay counted`).toBe(false);
    }
  });

  it('does not open the bypass to lookalike paths', () => {
    for (const path of [
      '/api/v1/auth/refreshx',
      '/api/v1/auth/refresh/extra',
      '/auth/refresh',
      '/api/v2/auth/refresh',
    ]) {
      expect(skipGlobalRateLimit(req({ path })), `${path} must stay counted`).toBe(false);
    }
  });

  it('does not extend the bypass to other methods on that path', () => {
    expect(skipGlobalRateLimit(req({ method: 'DELETE', path: '/api/v1/auth/refresh' }))).toBe(
      false
    );
  });

  it('still bypasses safe methods and the test env', () => {
    expect(skipGlobalRateLimit(req({ method: 'GET', path: '/api/v1/orders' }))).toBe(true);
    process.env.VITEST = 'true';
    expect(skipGlobalRateLimit(req({ path: '/api/v1/orders' }))).toBe(true);
  });
});

describe('the global mutation limiter skips signed Inngest step callbacks', () => {
  it('lets a signed POST /api/v1/inngest past uncounted', () => {
    expect(skipGlobalRateLimit(inngestReq({ signature: 't=123&s=abc' }))).toBe(true);
  });

  it('does NOT skip an unsigned POST /api/v1/inngest (dev-mode / attacker without the key)', () => {
    expect(skipGlobalRateLimit(inngestReq({ signature: undefined }))).toBe(false);
    expect(skipGlobalRateLimit(inngestReq({ signature: '' }))).toBe(false);
  });

  it('does not open the bypass to lookalike paths', () => {
    // The negative control. A predicate keyed on a prefix or substring match
    // instead of an exact path would let these through.
    for (const path of [
      '/api/v1/inngest-x',
      '/api/v1/inngest/extra',
      '/api/v1/inngest/../stores',
      '/inngest',
      '/api/v2/inngest',
    ]) {
      expect(
        skipGlobalRateLimit(inngestReq({ signature: 't=1&s=a', path })),
        `${path} must stay counted even with a signature header`
      ).toBe(false);
    }
  });

  it('does not extend the bypass to other methods on that path', () => {
    expect(skipGlobalRateLimit(inngestReq({ signature: 't=1&s=a', method: 'PUT' }))).toBe(false);
    expect(skipGlobalRateLimit(inngestReq({ signature: 't=1&s=a', method: 'DELETE' }))).toBe(false);
  });

  it('still counts every other mutation, signature header notwithstanding', () => {
    for (const path of ['/api/v1/orders', '/api/v1/webhooks/payment/tap', '/api/v1/auth/login']) {
      expect(
        skipGlobalRateLimit(inngestReq({ signature: 't=1&s=a', path })),
        `${path} must stay counted`
      ).toBe(false);
    }
  });
});

describe('the global mutation limiter skips the merchant-admin MCP surface (#1733, restored)', () => {
  // This predicate runs app-level, BEFORE the router that calls
  // `verifyMerchantKey` — so it cannot tell a merchant from a prober by
  // itself. The bypass is safe here ONLY because `mcp-admin.routes.ts` now
  // mounts a genuinely IP-only backstop (`merchantMcpIpLimiter`, see
  // `mcp-admin-limiter-key.test.ts`) ahead of the per-key limiter — this
  // suite only proves the PATH/METHOD MATCH is exact; the actual bucket
  // mechanics are proven where the limiters are defined.
  const mcpReq = (opts: { key?: string; path?: string; method?: string } = {}): Request =>
    req({
      method: opts.method ?? 'POST',
      path: opts.path ?? '/api/v1/mcp/admin/pecannbee',
      header: (name: string) => (name.toLowerCase() === 'x-merchant-key' ? opts.key : undefined),
    });

  it('lets POST /api/v1/mcp/admin/:storeSlug past uncounted, with or without a credential', () => {
    expect(skipGlobalRateLimit(mcpReq())).toBe(true);
    expect(skipGlobalRateLimit(mcpReq({ key: 'fwbm_whatever' }))).toBe(true);
  });

  it('does not open the bypass to lookalike paths', () => {
    // The negative control. A prefix match without the trailing slash inside
    // 'admin/' would let a similarly-named but DIFFERENT path through too.
    for (const path of [
      '/api/v1/mcp/admin-x/pecannbee',
      '/api/v1/mcp-admin/pecannbee',
      '/api/v1/mcp/adminx',
      '/mcp/admin/pecannbee',
      '/api/v2/mcp/admin/pecannbee',
      '/api/v1/mcp/admin/pecannbee/../../auth/login',
    ]) {
      expect(skipGlobalRateLimit(mcpReq({ path, key: 'fwbm_whatever' })), path).toBe(false);
    }
  });

  it('does not extend the bypass to other mutating methods on that path', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(skipGlobalRateLimit(mcpReq({ method, key: 'fwbm_whatever' })), method).toBe(false);
    }
    // GET already bypasses via bypass 2 (safe methods), not this branch.
    expect(skipGlobalRateLimit(mcpReq({ method: 'GET' }))).toBe(true);
  });

  it('does NOT extend the bypass to the anonymous buyer-facing /mcp/:storeSlug surface (no per-caller identity, verified or not, to bind a tighter bucket to)', () => {
    expect(skipGlobalRateLimit(req({ path: '/api/v1/mcp/pecannbee' }))).toBe(false);
  });

  it('still counts every other mutation', () => {
    for (const path of ['/api/v1/orders', '/api/v1/stores/s1/cart/items']) {
      expect(skipGlobalRateLimit(req({ path })), `${path} must stay counted`).toBe(false);
    }
  });
});

describe('req.path at app-level really is the full mounted path', () => {
  it('is /api/v1/auth/refresh, not /refresh', async () => {
    // The bypass matches a literal string, so it is only correct if Express
    // hands an app-level middleware the FULL path. That is a framework fact,
    // not something a hand-made req object can establish — so this drives a
    // real express app on a real socket and reads what the middleware saw.
    const app = express();
    let seenPath = '';
    let seenSkip: boolean | null = null;
    app.use((r, _res, next) => {
      seenPath = r.path;
      seenSkip = skipGlobalRateLimit(r);
      next();
    });
    app.use(
      '/api/v1',
      express.Router().post('/auth/refresh', (_r, res) => res.json({ ok: true }))
    );

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/refresh`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(seenPath).toBe('/api/v1/auth/refresh');
      expect(seenSkip).toBe(true);
    } finally {
      server.close();
    }
  });

  it('is /api/v1/inngest, not /inngest, and only skips with the signature header', async () => {
    const app = express();
    const seen: Array<{ path: string; skip: boolean }> = [];
    app.use((r, _res, next) => {
      seen.push({ path: r.path, skip: skipGlobalRateLimit(r) });
      next();
    });
    app.use(
      '/api/v1',
      express.Router().post('/inngest', (_r, res) => res.json({ ok: true }))
    );

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      await fetch(`http://127.0.0.1:${port}/api/v1/inngest`, {
        method: 'POST',
        headers: { 'x-inngest-signature': 't=123&s=abc' },
      });
      await fetch(`http://127.0.0.1:${port}/api/v1/inngest`, { method: 'POST' });

      expect(seen[0]).toEqual({ path: '/api/v1/inngest', skip: true });
      expect(seen[1]).toEqual({ path: '/api/v1/inngest', skip: false });
    } finally {
      server.close();
    }
  });
});
