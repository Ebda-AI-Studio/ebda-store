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
  // Bypass 4: Inngest step-execution callbacks. Inngest Cloud POSTs this
  // endpoint once per FUNCTION STEP, from a small, fixed pool of Inngest
  // IPs — an order fanout is ~12 steps, and a cron sweep runs many
  // functions back to back. Busy periods can push a single Inngest IP past
  // 200 mutations/15min and get 429'd here, which delays/retries
  // background jobs (order emails, refunds, stock restore) rather than any
  // browser-facing traffic. A local harness reproduced exactly this.
  //
  // Safe to skip on HEADER PRESENCE alone, not on verifying it here:
  // `inngestServe` (mounted in index.ts) cryptographically verifies
  // `x-inngest-signature` against INNGEST_SIGNING_KEY and returns 401
  // BEFORE running any function whenever the client is in "cloud" mode —
  // which `lib/inngest/client.ts` sets via `isDev: config.nodeEnv !==
  // 'production'`, so production is always cloud mode. Verified against the
  // installed inngest@4.2.6 source (srcof):
  //   - InngestCommHandler.validateSignature (src/components/
  //     InngestCommHandler.ts:2623-2652) throws "No x-inngest-signature
  //     provided" when `sig` is falsy and `client.mode === 'cloud'`, and
  //     otherwise verifies the HMAC via RequestSignature.verifySignature
  //     against signingKey (+ signingKeyFallback).
  //   - InngestCommHandler.handleAction (same file, ~1594-1609) awaits that
  //     validation for every POST and returns `{ status: 401 }` immediately
  //     — before touching `this.fns` or executing any step — when it did
  //     not succeed.
  // So an attacker without the real signing key gains nothing but a
  // rejected 401, same posture as the load-test bypass above. Dev-mode
  // (INNGEST_DEV) traffic from the local dev server does not carry a real
  // signature and so does NOT match this header-presence check — it stays
  // subject to the limiter (moot in practice: dev/test already exits via
  // Bypass 0).
  //
  // Matched exactly, like the /auth/refresh bypass: a lookalike path
  // (`/api/v1/inngest-x`, a `..`-traversal path) must NOT fall through.
  if (
    method === 'POST' &&
    req.path === '/api/v1/inngest' &&
    Boolean(req.header('x-inngest-signature'))
  ) {
    return true;
  }
  return false;
}
