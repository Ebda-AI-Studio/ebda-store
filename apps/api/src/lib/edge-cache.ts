import type { Response } from 'express';

/**
 * Apply CDN-friendly Cache-Control + Vary headers so whatever edge/CDN sits
 * in front of the API (`api.force-ai.co`, Railway-hosted) can cache public
 * read responses. Storefront reads are tenant-scoped via `x-store-id` OR
 * `x-store-domain` (`getStoreIdFromRequest` falls back to the domain header,
 * and the storefront's feed proxy sends ONLY `x-store-domain` for
 * custom-domain merchants) — so BOTH headers are default Vary tokens: a
 * Vary of `x-store-id` alone would key domain-selected responses on an
 * always-absent header and serve one merchant's payload to every other
 * custom-domain merchant (audit-followup #1145/#1160). Callers add
 * `Accept-Language` via `varyOn` for the few per-locale payloads.
 *
 * sMaxAge: how long the edge serves the cached copy without revalidating.
 * staleWhileRevalidate: how long after sMaxAge expires the edge will
 * still return the stale copy while it kicks off a background refresh.
 *
 * The merchant-perceived staleness window for any admin-driven change is
 * roughly `sMaxAge` because the API also calls `invalidateCached(...)`
 * on writes (Redis L1 layer); the edge L2 just respects the TTL — IF
 * something in front of the API actually honors `Cache-Control`. VERIFIED
 * 2026-09-02: `api.force-ai.co` IS Cloudflare-proxied (live response carries
 * `server: cloudflare` + `cf-ray`), but `cf-cache-status: DYNAMIC` — CF does
 * not cache these JSON responses without an explicit cache rule, so today
 * these headers are honored-but-inert.
 *
 * The Vary set below is NOT load-bearing on Cloudflare even once a cache
 * rule IS added: Cloudflare's cache key ignores the `Vary` header (other
 * than `Vary: Accept-Encoding`) unless the account has the Enterprise-only
 * "Cache by Vary header" / "Vary for images" feature turned on for that
 * rule — plain `Vary` tokens like the ones this file sets are otherwise
 * invisible to CF's cache-key computation (audit-followup #1269). If edge
 * caching of these tenant-scoped responses is ever turned on, key the cache
 * explicitly on store id — a CF Cache Rule custom cache key, or a
 * URL-embedded tenant segment — rather than relying on Vary. `Vary` still
 * matters for any Vary-respecting cache in front of Cloudflare (browsers,
 * corporate proxies), which is why it stays set.
 * (Supersedes the 2026-07-13 open item in
 * docs/audits/2026-07-13-cache-stampede.md.)
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
    /** Vary tokens beyond the defaults (`x-store-id`, `x-store-domain`).
     *  Add `'Accept-Language'` for locale-split payloads. */
    varyOn?: string[];
  }
): void {
  const swr = opts.staleWhileRevalidate ?? opts.sMaxAge * 5;
  res.setHeader('Cache-Control', `public, s-maxage=${opts.sMaxAge}, stale-while-revalidate=${swr}`);
  // res.vary() APPENDS (merge + case-insensitive dedupe) instead of
  // replacing — `setHeader('Vary', ...)` here used to clobber the
  // `Vary: Origin` the global cors() middleware sets (its `origin` option
  // is a function, so ACAO differs per requester), which would let a
  // caching edge replay one merchant's ACAO to every other merchant's
  // browser (audit-followup #1161).
  res.vary('x-store-id');
  res.vary('x-store-domain');
  for (const token of opts.varyOn ?? []) {
    res.vary(token);
  }
}
