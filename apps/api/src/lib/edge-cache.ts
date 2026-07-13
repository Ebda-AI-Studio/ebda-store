import type { Response } from 'express';

/**
 * Apply CDN-friendly Cache-Control + Vary headers so whatever edge/CDN sits
 * in front of the API (`api.force-ai.co`, Railway-hosted) can cache public
 * read responses. Most storefront reads are tenant-scoped via path or
 * `x-store-id` header — we Vary on `x-store-id` so two tenants don't
 * collide on the same cache key, plus Accept-Language for the few
 * endpoints that emit per-locale payloads.
 *
 * sMaxAge: how long the edge serves the cached copy without revalidating.
 * staleWhileRevalidate: how long after sMaxAge expires the edge will
 * still return the stale copy while it kicks off a background refresh.
 *
 * The merchant-perceived staleness window for any admin-driven change is
 * roughly `sMaxAge` because the API also calls `invalidateCached(...)`
 * on writes (Redis L1 layer); the edge L2 just respects the TTL — IF
 * something in front of the API actually honors `Cache-Control`. As of
 * 2026-07-13 that's an open item: confirm whether `api.force-ai.co` is
 * Cloudflare-proxied (orange-cloud) in the dashboard. Not confirmable from
 * the repo alone — see docs/audits/2026-07-13-cache-stampede.md.
 *
 * Don't apply to authenticated reads — most CDNs won't cache responses
 * with `Cache-Control: private` or with cookies. Public reads only.
 *
 * (Formerly said "Vercel's edge" — Vercel was cancelled 2026-07-07; the
 * SWR contract itself is unchanged, only the doc comment was stale.)
 */
export function setEdgeCache(
  res: Response,
  opts: {
    /** Edge fresh-cache window in seconds. */
    sMaxAge: number;
    /** Stale-while-revalidate window in seconds. */
    staleWhileRevalidate?: number;
    /** Vary tokens beyond the default (`x-store-id`). Add
     *  `'Accept-Language'` for locale-split payloads. */
    varyOn?: string[];
  }
): void {
  const swr = opts.staleWhileRevalidate ?? opts.sMaxAge * 5;
  res.setHeader('Cache-Control', `public, s-maxage=${opts.sMaxAge}, stale-while-revalidate=${swr}`);
  // CDN-compliant edges respect Vary; combine our default with any caller-supplied tokens.
  const vary = ['x-store-id', ...(opts.varyOn ?? [])];
  res.setHeader('Vary', vary.join(', '));
}
