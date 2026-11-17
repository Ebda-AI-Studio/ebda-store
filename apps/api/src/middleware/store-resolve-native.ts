import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { cfBindings } from '../cf/bindings';
import { recordRateLimited } from '../lib/rate-limit-telemetry';
import { skipPublicLimiters } from './public-limiter-keys';

/**
 * Ruling PERF-AUTHSTATE-1: the limiters of `GET /public/store/resolve` run on the Workers Rate Limiting bindings (an in-location
 * check, about a millisecond) instead of the AuthState Durable Object (0.4-0.8 s per round trip, 3 to 6 of them in series on a
 * cold request, measured 2026-11-17 with the API's own Server-Timing). Three limiters, all keyed by the forwarded SHOPPER address
 * (`req.ip`, Ruling RL-SSR-IP-6), never by the storefront Worker's own:
 *   - the router-level per-IP read bucket (`PUBLIC_IP_LIMITER`, 300/min), via `publicReadLimit`;
 *   - the route's own `storeResolveLimiter` (`STORE_RESOLVE_LIMITER`, 30/min);
 *   - the unknown-store counter (`STORE_MISS_LIMITER`, 20/min): counted LAZILY, only when the answer is a 404, instead of a
 *     Durable Object READ in front of every request.
 * Semantics that are looser than the Durable Object limiters they replace, on THIS route only (Ruling PUBLIC-READ-LIMIT-1 residual):
 * the bindings count per Cloudflare location, so a client spread over several locations at once can exceed the global figure;
 * and the miss limit now answers 429 instead of the 404 on the request that crosses the line (the lookup behind it already ran).
 * A binding that is missing or throws falls back to the exact Durable Object limiters (never to "no limit"). Everything else keeps
 * the exact limiters: writes, auth, every other public route.
 */
const RESOLVE_PATH = /^\/store\/resolve\/?$/;

const BODY_RESOLVE = {
  success: false,
  error: { code: 'RATE_LIMITED', message: 'Too many store resolution requests.' },
};
const BODY_MISS = {
  success: false,
  error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
};

/** An anonymous GET/HEAD of exactly `/store/resolve` (relative to the `/public` mount) with no query. */
export function isAnonymousStoreResolve(req: Request): boolean {
  const m = req.method.toUpperCase();
  return (
    (m === 'GET' || m === 'HEAD') &&
    RESOLVE_PATH.test(req.path ?? '') &&
    !req.headers.authorization &&
    !req.headers.cookie &&
    Object.keys((req.query ?? {}) as Record<string, unknown>).length === 0
  );
}

/** True when this request's three limiters are all served natively (every binding present). */
export function storeResolveIsNative(req: Request): boolean {
  const b = cfBindings();
  return Boolean(
    b?.PUBLIC_IP_LIMITER &&
    b.STORE_RESOLVE_LIMITER &&
    b.STORE_MISS_LIMITER &&
    isAnonymousStoreResolve(req)
  );
}

const ipOf = (req: Request): string | null => (req.ip ? ipKeyGenerator(req.ip) || null : null);

/** The route-level limiter: native when every binding is present, else the exact one handed in. */
export function storeResolveLimit(exact: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (skipPublicLimiters(req)) return next();
    if (!storeResolveIsNative(req)) return exact(req, res, next);
    const ip = ipOf(req);
    // No client address: not counted (the `noClientIp` convention), exactly as the exact limiter.
    if (!ip) return next();
    const binding = cfBindings()!.STORE_RESOLVE_LIMITER!;
    binding
      .limit({ key: `resolve:${ip}` })
      .then(r => {
        if (r.success) return next();
        recordRateLimited('rl:store-resolve:');
        res.setHeader('Retry-After', '60');
        res.status(429).json(BODY_RESOLVE);
      })
      .catch(() => exact(req, res, next));
  };
}

/**
 * Count one unknown-store answer and say whether the caller is over the limit. Called from the resolve handler's 404 branches,
 * BEFORE the 404 is sent. Resolves `true` when it already answered 429 (the caller must return), `false` to carry on with the 404.
 * Resolves `false` without counting when the request is not served natively (the router-level Durable Object limiter counts it).
 */
export async function countStoreMiss(req: Request, res: Response): Promise<boolean> {
  if (skipPublicLimiters(req) || !storeResolveIsNative(req)) return false;
  const ip = ipOf(req);
  if (!ip) return false;
  try {
    const r = await cfBindings()!.STORE_MISS_LIMITER!.limit({ key: `miss:${ip}` });
    if (r.success) return false;
  } catch {
    return false; // fail open: a missing counter must not turn a 404 into an outage (the DO limiter did the same on a store error)
  }
  recordRateLimited('rl:store-miss:');
  res.setHeader('Retry-After', '60');
  res.status(429).json(BODY_MISS);
  return true;
}
