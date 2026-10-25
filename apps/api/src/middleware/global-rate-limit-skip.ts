import type { Request } from 'express';

/**
 * The merchant-admin MCP route's shape (`router.post('/:storeSlug', ...)` in
 * mcp-admin.routes.ts) — exactly one path segment after `/admin/`. Module-level
 * so it is compiled once, not per request, on this hot (every-mutation) path.
 */
const MCP_ADMIN_PATH = /^\/api\/v1\/mcp\/admin\/[^/]+$/;

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
  // Matched on the path only: nothing else may fall through this bypass.
  // `req.path` here is the full mounted path. Case-insensitive and
  // tolerant of ONE trailing slash — a raw `===` missed a client/proxy that
  // normalizes case or appends a trailing slash, which does not admit any
  // new bypass (the comparison target is still the exact refresh path, not
  // a pattern), it just failed the SAFE direction (those callers stayed
  // counted against the shared cap instead of getting their own bucket).
  // Deliberately NOT percent-decoded, unlike security.ts's
  // normalizePlatformGatePath sibling: decoding before an ALLOW-list check
  // fails OPEN (see that function's doc comment) and Express's own req.path
  // is already decoded for a normal request, so there is nothing to gain
  // here from decoding again.
  if (method === 'POST' && req.path.toLowerCase().replace(/\/$/, '') === '/api/v1/auth/refresh') {
    return true;
  }
  // (Bypass 4, the Inngest step-callback skip, was removed with Inngest.)
  // Bypass 5: the merchant-admin MCP surface (`POST /api/v1/mcp/admin/:storeSlug`).
  //
  // A first version of this bypass was removed (then this comment block
  // documented why) because its stated compensating control was false: this
  // predicate runs app-level, BEFORE the router, so it cannot know whether
  // the caller presented a valid key, and `merchantMcpLimiter`'s per-key
  // bucket did not bind an unauthenticated caller either — a made-up
  // `x-merchant-key` rotated per request minted a fresh bucket every time.
  //
  // The bypass is restored NOW that the compensating control is real, not
  // merely asserted: `mcp-admin.routes.ts` mounts `merchantMcpIpLimiter`
  // (300/15min, keyed on `ipKeyGenerator(req.ip)` ONLY — nothing the caller
  // sends can choose or split this bucket) AHEAD of `merchantMcpLimiter`
  // (120/min, now ALWAYS IP-qualified: `mmcp:${ip}:${fp}`). Both are
  // Redis-backed (`makeRateLimitStore`) so the caps hold across replicas, not
  // per-process. A caller with no key, or one rotated per request, is bounded
  // by the IP-only limiter regardless of what it sends; a merchant with a
  // real key gets that limiter's 300/15min headroom PLUS their own 120/min
  // sub-bucket, unaffected by other merchants or probes sharing their IP.
  // `handleMerchantMcpPost` also rejects an implausibly-shaped key (wrong
  // prefix/length) before any DB work, so the router's own limiters are the
  // FIRST cost a garbage credential pays, not the last.
  //
  // Exempting this path from the global 200/15min-per-IP mutation cap
  // therefore gives a legitimate MCP-driven bulk catalogue job real headroom
  // (it no longer shares a bucket with every other admin-dashboard mutation
  // from the same office IP) without reopening the hole: an unauthenticated
  // or credential-rotating caller is still bounded, by a limiter that cannot
  // be escaped by anything in the request.
  //
  // Only the exact admin-MCP path skips. The anonymous, buyer-facing
  // `/api/v1/mcp/:storeSlug` surface (unauthenticated reads + `place_order`,
  // mcp.routes.ts) is deliberately NOT exempted here — it has no per-caller
  // identity, verified OR unverified, to bind any tighter bucket to, so the
  // IP-wide backstop stays in front of it.
  //
  // Matched by a shape, not a bare prefix: the mounted route is
  // `router.post('/:storeSlug', ...)` (mcp-admin.routes.ts) — exactly ONE
  // path segment after `/admin/`, nothing further. A bare `.startsWith()`
  // also matched `/api/v1/mcp/admin/x/../../auth/login` (Node/Express do NOT
  // resolve `..` segments out of `req.path` — that normalization, if any,
  // happens upstream at a reverse proxy, which cannot be assumed), which
  // would have exempted a request TARGETING an entirely different route from
  // the global cap merely because its literal path started with this
  // prefix. The regex requires a single `[^/]+` segment and nothing after
  // it, so neither a lookalike path (`/api/v1/mcp/admin-x/...`,
  // `/api/v1/mcp-admin/...`) nor a traversal-shaped one satisfies it.
  if (method === 'POST' && MCP_ADMIN_PATH.test(req.path)) {
    return true;
  }
  return false;
}
