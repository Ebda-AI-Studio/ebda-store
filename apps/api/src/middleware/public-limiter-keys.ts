import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { resolvedStoreId } from '../utils/resolved-store';

/** The publicTenantLimiter bucket key (also the native anonymous-read limiter's tenant key). */
export function publicTenantKey(req: Request): string {
  // The RESOLVED store id wins: a raw header or param value is attacker-controlled, so rotating
  // fake tenant values must not buy a fresh bucket. (publicStoreContext resolves before the
  // limiters run; an unresolvable value is a 404 there, so it never reaches a limiter.)
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

/** Test and load-test bypass, the same one the exact public limiters use. */
export function skipPublicLimiters(req: Request): boolean {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return true;
  const expected = process.env.LOAD_TEST_BYPASS_TOKEN;
  return Boolean(expected) && req.header('x-load-test-token') === expected;
}
