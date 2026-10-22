import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { cfBindings } from '../cf/bindings';
import { publicIpKey, publicTenantKey, skipPublicLimiters } from './public-limiter-keys';

/**
 * Anonymous public READS are limited by the Workers Rate Limiting bindings (a local, in-colo
 * check: no Durable Object round trip) instead of the exact Durable Object limiters. Measured
 * 2026-10-22: the two DO counters cost one ~110 ms hop warm and 0.2-0.9 s on a cold shard on
 * every storefront API read.
 *
 * Scope, enforced here and tested:
 *  - only GET/HEAD with no Authorization header and no Cookie header (an authenticated or
 *    session-bearing request, and every write, keeps the exact DO limiters);
 *  - the numbers are the DO limiters' own (300/min per IP, 6000/min per tenant);
 *  - a binding that is missing or throws falls back to the DO limiters (never to "no limit");
 *  - a block answers the same 429 body the DO limiters send.
 * Residual (Ruling PUBLIC-READ-LIMIT-1): the bindings count per Cloudflare location, so a client
 * spread over several locations at once can exceed the global figure; the exact DO limiters (and
 * the coarse 1200/min per-IP native guard in front of Express) still bound everything else, and
 * these routes are KV-cached reads, not writes.
 */
export function isAnonymousPublicRead(req: Request): boolean {
  const m = req.method.toUpperCase();
  return (m === 'GET' || m === 'HEAD') && !req.headers.authorization && !req.headers.cookie;
}

const BODY = {
  success: false,
  error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
};

export function publicReadLimit(exactLimiters: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (skipPublicLimiters(req)) return next();
    const b = cfBindings();
    if (!isAnonymousPublicRead(req) || !b?.PUBLIC_IP_LIMITER || !b.PUBLIC_TENANT_LIMITER) {
      return exactLimiters(req, res, next);
    }
    Promise.all([
      b.PUBLIC_IP_LIMITER.limit({ key: publicIpKey(req) }),
      b.PUBLIC_TENANT_LIMITER.limit({ key: publicTenantKey(req) }),
    ]).then(
      ([ip, tenant]) => {
        if (ip.success && tenant.success) return next();
        res.setHeader('Retry-After', '60');
        res.status(429).json(BODY);
      },
      () => exactLimiters(req, res, next)
    );
  };
}
