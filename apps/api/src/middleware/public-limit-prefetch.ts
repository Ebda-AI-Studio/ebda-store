import type { NextFunction, Request, Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { cfBindings, cfWaitUntil } from '../cf/bindings';
import { authStateAvailable } from '../cf/auth-state-client';
import { prefetchHits, releaseUnconsumed, runWithPrefetchedHits } from '../cf/rate-limit-store';
import { isWorkers } from '../lib/runtime';
import { resolvedStoreId } from '../utils/resolved-store';
import { publicIpKey, publicTenantKey, skipPublicLimiters } from './public-limiter-keys';
import { isAnonymousPublicRead } from './public-read-limit';
import { hasSearchTerm } from './security';

/**
 * PERF-RL-DO: send every public-router rate-limit hit of this request in ONE round trip, before the limiters run.
 *
 * Mounted first on the public router. It predicts which of the router's limiters will count this request and with which key
 * (the same key functions and skips the limiters use), and prefetches those hits batched per shard (cf/rate-limit-store.ts);
 * the per-IP family shares the client's shard, so a store resolve is ONE Durable Object call, a tenant-scoped read two in
 * parallel. Before: `publicLimiter` + `publicTenantLimiter` (one round trip), then `storeMissLimiter`, then
 * `publicSearchLimiter`, each its own serial round trip.
 *
 * A wrong prediction never changes a count: a limiter with no prefetched hit calls the DO itself, and a hit no limiter took is
 * taken back when the response ends. Window: every public-router limiter counts per 60 s.
 *
 * LAUNCH-RL-MISS: the store-miss limiter no longer hits on every request. It READS its counter before the handler and counts
 * only after a 404, so its key rides this batch as a `peek` (two read ops), not a hit.
 */
const WINDOW_MS = 60_000;
const SUGGEST = /^\/[^/]+\/search\/suggest(?:\/|$)/;
const PRODUCTS = /^\/products(?:\/|$)/;

export function plannedPublicHits(req: Request): { hits: string[]; peeks: string[] } {
  const keys: string[] = [];
  const peeks: string[] = [];
  const b = cfBindings();
  // publicReadLimit's native fast path (anonymous cached catalogue read of a resolved store): no exact DO limiters.
  const native =
    isAnonymousPublicRead(req) &&
    Boolean(b?.PUBLIC_IP_LIMITER && b.PUBLIC_TENANT_LIMITER) &&
    Boolean(resolvedStoreId(req));
  if (!native)
    keys.push(`rl:public:${publicIpKey(req)}`, `rl:public-tenant:${publicTenantKey(req)}`);
  if (req.ip) {
    const ip = ipKeyGenerator(req.ip);
    peeks.push(`rl:store-miss:${ip}`);
    if (SUGGEST.test(req.path) || (PRODUCTS.test(req.path) && hasSearchTerm(req)))
      keys.push(`rl:public-search:${ip}`);
  }
  return { hits: keys, peeks };
}

export function prefetchPublicLimits(req: Request, res: Response, next: NextFunction): void {
  if (!isWorkers || !authStateAvailable() || skipPublicLimiters(req)) return next();
  const planned = plannedPublicHits(req);
  const hits = prefetchHits(
    planned.hits.map(key => ({ key, windowMs: WINDOW_MS })),
    planned.peeks
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    cfWaitUntil(releaseUnconsumed(hits));
  };
  res.once('finish', release);
  res.once('close', release);
  runWithPrefetchedHits(hits, next);
}
