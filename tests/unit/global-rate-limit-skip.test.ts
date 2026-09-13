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
});
