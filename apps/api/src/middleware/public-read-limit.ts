import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { cfBindings } from '../cf/bindings';
import { publicIpKey, skipPublicLimiters } from './public-limiter-keys';
import { resolvePublicStoreId } from '../utils/store-helpers';
import { storeResolveIsNative } from './store-resolve-native';

/**
 * Anonymous public READS are limited by the Workers Rate Limiting bindings (a local, in-colo
 * check: no Durable Object round trip) instead of the exact Durable Object limiters. Measured
 * 2026-10-22: the two DO counters cost one ~110 ms hop warm and 0.2-0.9 s on a cold shard on
 * every storefront API read.
 *
 * Scope, enforced here and tested:
 *  - only GET/HEAD with no Authorization header and no Cookie header, on the explicit ALLOWLIST
 *    below (KV-cached catalogue reads, no query beyond pagination/sort); anything else keeps the
 *    exact DO limiters;
 *  - the numbers are the DO limiters' own (300/min per IP, 6000/min per tenant);
 *  - a binding that is missing or throws falls back to the DO limiters (never to "no limit");
 *  - a block answers the same 429 body the DO limiters send.
 * Residual (Ruling PUBLIC-READ-LIMIT-1): the bindings count per Cloudflare location, so a client
 * spread over several locations at once can exceed the global figure; the exact DO limiters (and
 * the coarse 1200/min per-IP native guard in front of Express) still bound everything else, and
 * these routes are KV-cached reads, not writes.
 */
/**
 * EXPLICIT ALLOWLIST of what the native fast path may serve: only routes truly answered from the
 * KV cache, with no query beyond pagination and sort. Everything else (search and typeahead,
 * filters that reach the database, the feed, wishlist and guest-order lookups, store resolution,
 * every route not listed) keeps the exact Durable Object limiters. Paths are relative to the
 * `/public` mount.
 */
const PAGING_KEYS = new Set(['page', 'limit', 'sort', 'cursor']);
const ALLOWED: Array<{ path: RegExp; query: ReadonlySet<string> }> = [
  { path: /^\/categories\/?$/, query: new Set() },
  { path: /^\/tags\/?$/, query: new Set() },
  { path: /^\/products\/?$/, query: PAGING_KEYS },
  { path: /^\/products\/[A-Za-z0-9_-]{1,120}\/?$/, query: new Set() },
  { path: /^\/size-charts\/?$/, query: new Set() },
  { path: /^\/redirects\/resolve\/?$/, query: new Set(['type', 'slug']) },
];

export function isCachedCatalogueRead(req: Request): boolean {
  const path = req.path ?? '';
  const rule = ALLOWED.find(r => r.path.test(path));
  if (!rule) return false;
  if (req.headers['x-search-query'] !== undefined) return false;
  const q = (req.query ?? {}) as Record<string, unknown>;
  return Object.keys(q).every(k => rule.query.has(k) && typeof q[k] === 'string');
}

export function isAnonymousPublicRead(req: Request): boolean {
  const m = req.method.toUpperCase();
  return (
    (m === 'GET' || m === 'HEAD') &&
    !req.headers.authorization &&
    !req.headers.cookie &&
    isCachedCatalogueRead(req)
  );
}

const BODY = {
  success: false,
  error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
};

export function publicReadLimit(exactLimiters: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (skipPublicLimiters(req)) return next();
    const b = cfBindings();
    // Store resolve (Ruling PERF-AUTHSTATE-1): the host is not a store yet, so only the per-address bucket applies (the same 300/min
    // as the exact limiter); no tenant bucket keyed on an attacker-supplied host. A binding error falls back to the exact limiters.
    if (storeResolveIsNative(req)) {
      if (!req.ip) return next();
      return void b!
        .PUBLIC_IP_LIMITER!.limit({ key: publicIpKey(req) })
        .then(ip => {
          if (ip.success) return next();
          res.setHeader('Retry-After', '60');
          res.status(429).json(BODY);
        })
        .catch(() => exactLimiters(req, res, next));
    }
    if (!isAnonymousPublicRead(req) || !b?.PUBLIC_IP_LIMITER || !b.PUBLIC_TENANT_LIMITER) {
      return exactLimiters(req, res, next);
    }
    const ipLimiter = b.PUBLIC_IP_LIMITER;
    const tenantLimiter = b.PUBLIC_TENANT_LIMITER;
    // The tenant bucket is the store the request RESOLVED to (memoised, no extra query), never a
    // raw header: an unresolved store goes to the exact limiters.
    resolvePublicStoreId(req)
      .then(storeId => {
        if (!storeId) return exactLimiters(req, res, next);
        return Promise.all([
          // No client address (a storefront render with no shopper, Ruling RL-SSR-IP-6): no per-address bucket,
          // rather than one shared `noip` bucket for every such render; the per-store bucket still counts.
          req.ip ? ipLimiter.limit({ key: publicIpKey(req) }) : Promise.resolve({ success: true }),
          tenantLimiter.limit({ key: `t:${storeId}` }),
        ]).then(([ip, tenant]) => {
          if (ip.success && tenant.success) return next();
          res.setHeader('Retry-After', '60');
          res.status(429).json(BODY);
        });
      })
      .catch(() => exactLimiters(req, res, next));
  };
}

/**
 * Routes that never open the per-request tenant transaction (Ruling LAZY-TX-1): an anonymous
 * GET/HEAD of exactly `/categories`, `/tags`, the product list (paging/sort only) or the product
 * page, with no cookie or Authorization. A KV hit needs no database;
 * the cache fill reads through `readInStoreContext` in its own short tenant transaction. Anything
 * else, and every authenticated or cookie-bearing request, keeps the request transaction.
 */
export function skipsRequestTransaction(req: Request): boolean {
  const m = req.method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  if (req.headers.authorization || req.headers.cookie) return false;
  if (req.headers['x-search-query'] !== undefined) return false;
  const path = req.path ?? '';
  const q = (req.query ?? {}) as Record<string, unknown>;
  const keys = Object.keys(q);
  if (/^\/(categories|tags)\/?$/.test(path)) return keys.length === 0;
  // The anonymous product list: paging and sort only (no search, filter or ids: those reach the
  // database with unbounded distinct values), and the product page (no query).
  if (/^\/products\/?$/.test(path))
    return keys.every(k => PAGING_KEYS.has(k) && typeof q[k] === 'string');
  if (/^\/products\/[A-Za-z0-9_-]{1,120}\/?$/.test(path)) return keys.length === 0;
  return false;
}
