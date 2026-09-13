import type { Request } from 'express';

/**
 * Whether the GLOBAL mutation limiter lets a request past uncounted.
 *
 * Exported and named so it can be executed by a test. Inline, it was a
 * closure no suite could reach, and the limiter itself is disabled under
 * vitest — so every branch of it was unobservable.
 */
export function skipGlobalRateLimit(req: Request): boolean {
  // Bypass 0: test environment. Integration test suites issue many
  // POST/PUT/DELETE mutations in a short window; the global mutation cap
  // would fire mid-suite and cascade all subsequent tests to 429. The
  // per-endpoint authLimiter already skips for test env — the global
  // limiter follows the same convention.
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return true;
  // Bypass 1: load test
  const expected = process.env.LOAD_TEST_BYPASS_TOKEN;
  if (expected) {
    const provided = req.header('x-load-test-token');
    if (provided && provided === expected) return true;
  }
  // Bypass 2: safe-method reads. Legitimate clients (admin merchant
  // sessions, storefront customers) issue many GETs per page load;
  // 100+/15min is normal for normal use. Per-endpoint limiters
  // (publicLimiter etc.) still cover targeted hotspots. Mutations
  // (POST/PUT/PATCH/DELETE) below the bypass remain limited at 200/
  // 15min — that's the abuse-blocking surface.
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }
  // Bypass 3: /auth/refresh, which now has its own dedicated bucket.
  //
  // It is a POST, so it was counted here too — one IP-wide counter of 200
  // per 15 minutes shared with every order creation, cart write and admin
  // save. That is the same "every user behind a NAT shares one bucket"
  // failure `refreshLimiter` was introduced to end, one layer up: two
  // herd events on a shared office IP bind on THIS cap before the
  // per-user one, and a 429 from here is indistinguishable to the client
  // from a 429 from there. Double-counting buys nothing — refreshLimiter
  // is user-scoped, tighter in the case that matters, and always runs.
  //
  // Matched exactly, and on the path only: nothing else may fall through
  // this bypass. `req.path` here is the full mounted path.
  if (method === 'POST' && req.path === '/api/v1/auth/refresh') {
    return true;
  }
  return false;
}
