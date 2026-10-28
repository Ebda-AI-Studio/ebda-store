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
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Request } from 'express';
import { skipGlobalRateLimit } from '@api/middleware/global-rate-limit-skip';

/**
 * Runs `app` on an in-memory request/response pair: no listening port, no network, nothing to
 * tear down (a real socket here once answered 404 in a full run). Resolves with the status code
 * once the app ends the response.
 */
function dispatch(
  app: express.Express,
  method: string,
  url: string,
  headers: Record<string, string> = {}
): Promise<number> {
  const rq = new IncomingMessage(new Socket());
  rq.method = method;
  rq.url = url;
  rq.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const rs = new ServerResponse(rq);
  return new Promise<number>((resolve, reject) => {
    rs.end = ((..._args: unknown[]) => {
      resolve(rs.statusCode);
      return rs;
    }) as typeof rs.end;
    app(rq, rs, err => reject(err ?? new Error(`unhandled ${method} ${url}`)));
  });
}

const req = (over: Partial<Request> = {}): Request =>
  ({
    method: 'POST',
    path: '/api/v1/orders',
    header: () => undefined,
    ...over,
  }) as unknown as Request;

// Bypass 0 short-circuits on the test env, so every other branch is dead under
// vitest unless these are cleared. Without this the suite would pass no matter
// what the predicate said.
const SAVED = {
  node: process.env.NODE_ENV,
  vitest: process.env.VITEST,
};
beforeEach(() => {
  process.env.NODE_ENV = 'production';
  delete process.env.VITEST;
  delete process.env.LOAD_TEST_BYPASS_TOKEN;
});
afterEach(() => {
  if (SAVED.node !== undefined) process.env.NODE_ENV = SAVED.node;
  else delete process.env.NODE_ENV;
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

  // Regression for #1793: the bypass used a raw `===`, so a client/proxy
  // that normalizes case or appends a trailing slash missed it — those
  // refresh calls stayed counted against the shared IP-wide mutation cap,
  // the exact defect this bypass exists to end.
  it('matches the refresh path case-insensitively', () => {
    expect(skipGlobalRateLimit(req({ path: '/API/V1/AUTH/REFRESH' }))).toBe(true);
    expect(skipGlobalRateLimit(req({ path: '/Api/V1/Auth/Refresh' }))).toBe(true);
  });

  it('matches the refresh path with ONE trailing slash', () => {
    expect(skipGlobalRateLimit(req({ path: '/api/v1/auth/refresh/' }))).toBe(true);
  });

  it('still does not open the bypass to a lookalike, even case-varied', () => {
    for (const path of [
      '/API/V1/AUTH/REFRESHX',
      '/api/v1/auth/refresh//',
      '/api/v2/AUTH/refresh',
    ]) {
      expect(skipGlobalRateLimit(req({ path })), `${path} must stay counted`).toBe(false);
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
      path: opts.path ?? '/api/v1/mcp/admin/demo-store',
      header: (name: string) => (name.toLowerCase() === 'x-merchant-key' ? opts.key : undefined),
    });

  it('lets POST /api/v1/mcp/admin/:storeSlug past uncounted, with or without a credential', () => {
    expect(skipGlobalRateLimit(mcpReq())).toBe(true);
    expect(skipGlobalRateLimit(mcpReq({ key: 'ebdam_whatever' }))).toBe(true);
  });

  it('does not open the bypass to lookalike paths', () => {
    // The negative control. A prefix match without the trailing slash inside
    // 'admin/' would let a similarly-named but DIFFERENT path through too.
    for (const path of [
      '/api/v1/mcp/admin-x/demo-store',
      '/api/v1/mcp-admin/demo-store',
      '/api/v1/mcp/adminx',
      '/mcp/admin/demo-store',
      '/api/v2/mcp/admin/demo-store',
      '/api/v1/mcp/admin/demo-store/../../auth/login',
    ]) {
      expect(skipGlobalRateLimit(mcpReq({ path, key: 'ebdam_whatever' })), path).toBe(false);
    }
  });

  it('does not extend the bypass to other mutating methods on that path', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(skipGlobalRateLimit(mcpReq({ method, key: 'ebdam_whatever' })), method).toBe(false);
    }
    // GET already bypasses via bypass 2 (safe methods), not this branch.
    expect(skipGlobalRateLimit(mcpReq({ method: 'GET' }))).toBe(true);
  });

  it('does NOT extend the bypass to the anonymous buyer-facing /mcp/:storeSlug surface (no per-caller identity, verified or not, to bind a tighter bucket to)', () => {
    expect(skipGlobalRateLimit(req({ path: '/api/v1/mcp/demo-store' }))).toBe(false);
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
    // real express app in memory (no socket) and reads what the middleware saw.
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

    const status = await dispatch(app, 'POST', '/api/v1/auth/refresh');

    expect(status).toBe(200);
    expect(seenPath).toBe('/api/v1/auth/refresh');
    expect(seenSkip).toBe(true);
  });
});
