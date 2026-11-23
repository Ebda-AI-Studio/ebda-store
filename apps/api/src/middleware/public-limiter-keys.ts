import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { resolvedStoreId } from '../utils/resolved-store';
import { trustedSsrRequests } from '../cf/ssr-client-ip';

/** The publicTenantLimiter bucket key (also the native anonymous-read limiter's tenant key). */
export function publicTenantKey(req: Request): string {
  // The RESOLVED store id wins: a raw header or param value is attacker-controlled, so rotating
  // fake tenant values must not buy a fresh bucket. (publicStoreContext resolves before the
  // limiters run. A request whose store did not resolve still reaches them, so that an unknown
  // store is limited and counted: it is refused right after, `refuseUnknownPublicStore`.)
  const resolved = resolvedStoreId(req);
  if (resolved) return `t:${resolved}`;
  // Route-level usages (coupons/validate, promotions/preview) carry the
  // tenant as a :storeId path param; router-level usage sees only headers.
  const paramStoreId = (req.params as Record<string, string> | undefined)?.storeId;
  const storeId = req.headers['x-store-id'];
  const storeDomain = req.headers['x-store-domain'];
  const tenant =
    (typeof paramStoreId === 'string' && paramStoreId) ||
    (typeof storeId === 'string' && storeId) ||
    (typeof storeDomain === 'string' && storeDomain.toLowerCase()) ||
    '';
  return tenant ? `t:${tenant}` : ipKeyGenerator(req.ip ?? '') || 'noip';
}

/** The publicLimiter bucket key: the client IP, IPv6 normalised to its /64. */
export function publicIpKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? '') || 'noip';
}

/**
 * Load-test bypass, the SAME one the exact public limiters use (`skipForLoadTest` in security.ts).
 * It must not add a test-environment skip of its own: `publicReadLimit` would then bypass the exact
 * limiters altogether under vitest, so no suite exercised them (and `RateLimit-Policy` vanished from
 * every public response in tests; Ruling ITEST-8).
 */
export function skipPublicLimiters(req: Request): boolean {
  const expected = process.env.LOAD_TEST_BYPASS_TOKEN;
  return Boolean(expected) && req.header('x-load-test-token') === expected;
}

/**
 * Ruling DO-BUDGET-2: a request from ebda-web carrying a VERIFIED v2 signature (cf/ssr-client-ip.ts) is `trusted`. Trust is
 * membership of a WeakSet that only app.ts fills, from a header only worker.ts sets after a constant-time WebCrypto verify of
 * ts.HMAC(HKDF(REVALIDATE_SECRET), method | path+query | store host | shopper address | ts) inside +-60 s on an anonymous
 * storefront read. Every inbound copy of the marker and the forward headers is deleted first. A signature cannot move to another
 * request, replay after a minute, or come from a v1 header; `none` is never trusted. No secret = nothing trusted.
 * Residual: the signing key is derived from the revalidate secret (one root secret).
 */
export function isTrustedSsr(req: Request): boolean {
  return trustedSsrRequests.has(realRequest(req));
}

/**
 * The limiter prefetch (request-limit-prefetch.ts) predicts keys on a Proxy copy of the request. A Proxy is not the WeakSet member,
 * so the copy answers `REAL_REQUEST` with the request it wraps: trust and the once-per-request budget decision are then read
 * from the real request, and the plan agrees with what the limiters later decide.
 */
export const REAL_REQUEST = Symbol('ebda.realRequest');
const realRequest = (req: Request): Request =>
  ((req as unknown as Record<symbol, Request | undefined>)[REAL_REQUEST] ?? req) as Request;

/**
 * A trusted render is still limited per VERIFIED shopper address and per store, but isolate-first: an in-memory fixed-window
 * counter (no Durable Object call) answers while a key is cold; once a key passes {@link LOCAL_HOT} hits in the window the
 * exact DO limiters run for it (they count from zero, so a hot key can use at most LOCAL_HOT + the limit per isolate). Same
 * protection under abuse, no DO call in the normal case. Per-isolate counts are the residual: N isolates can each pass
 * LOCAL_HOT free hits.
 */
const LOCAL_WINDOW_MS = 60_000;
const LOCAL_HOT = { ip: 60, tenant: 1200 } as const;
const LOCAL_MAX_KEYS = 20_000;
const local = new Map<string, { n: number; resetAt: number }>();
const decided = new WeakMap<object, boolean>();

/**
 * Fixed window per key. At the cap, make room WITHOUT forgetting live counters (a full clear would hand a large botnet fresh
 * free hits): first sweep every key whose window already ended, then drop the least recently touched keys (a touched key moves
 * to the end of the Map's insertion order), one at a time, until there is room.
 */
function bump(key: string, hot: number): boolean {
  const now = Date.now();
  let e = local.get(key);
  if (e)
    local.delete(key); // re-inserted below: most recently used goes last
  else if (local.size >= LOCAL_MAX_KEYS) {
    for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
    for (const k of local.keys()) {
      if (local.size < LOCAL_MAX_KEYS) break;
      local.delete(k);
    }
  }
  if (!e || e.resetAt <= now) e = { n: 0, resetAt: now + LOCAL_WINDOW_MS };
  e.n += 1;
  local.set(key, e);
  return e.n > hot;
}

/**
 * True = this trusted request spends NO exact DO limiter hit (both its keys are cold). Decided once per request (memoised), so
 * the prefetch, publicReadLimit and storeResolveLimiter agree. Always false for an untrusted request.
 */
export function ssrWithinLocalBudget(req: Request): boolean {
  if (!isTrustedSsr(req)) return false;
  const real = realRequest(req);
  const known = decided.get(real);
  if (known !== undefined) return known;
  const ipHot = req.ip ? bump(`ip:${publicIpKey(req)}`, LOCAL_HOT.ip) : false;
  const tenantHot = bump(`t:${publicTenantKey(req)}`, LOCAL_HOT.tenant);
  const cold = !ipHot && !tenantHot;
  decided.set(real, cold);
  return cold;
}
