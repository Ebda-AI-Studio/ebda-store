// Storefront OpenNext DO-sharded tag cache options. Single source: scripts/cf-setup-local.sh bakes
// `doShardedTagCache(TAG_CACHE_OPTIONS)` into the generated open-next.config.ts (OPENNEXT_CACHE=true).
//
// WHY `regionalCacheDangerouslyPersistMissingTags` (measured 2026-11-14): every render asks the tag cache about
// each fetch/page tag. In @opennextjs/cloudflare@1.20.9 (do-sharded-tag-cache.ts putToRegionalCache) a tag the DO
// has NEVER seen is not cached regionally by default, so the common case (products:<id>, layout:<id>, the Next soft
// `_N_T_/…` tags, none revalidated since the last write) hit a Durable Object on EVERY render:
// ~5-7 DO calls/render, ~68k tag-soft/tag-hard requests/day on the ebda.app zone. With the sentinel persisted, a
// colo asks a shard at most once per tag per TTL.
//
// STALENESS CLASS: BOUNDED-stale for the regional layer, on top of event invalidation.
//   - Same colo as the revalidating Worker (POST /api/revalidate, merchant price/stock/theme write): the regional
//     entry is deleted by writeTags -> visible on the next render (test: tag-cache-options.test.ts).
//   - Other colos: cache.delete is per-colo, so the tag lookup may be served from a copy up to TTL old.
//     RESIDUAL WINDOW = REGIONAL_TTL_SEC (5s, the library default, made explicit). This window already existed for
//     every tag that had been revalidated once; persisting missing tags extends the same bound to first-ever writes.
//   - Price/inventory are NEVER-stale data: this does not weaken the write path (writeTags still hits every DO
//     replica and deletes the local entry); it only bounds cross-colo propagation to <= 5s. Do NOT raise the TTL
//     without enabling cache-tag purge (CF_PURGE_* env, isPurgeCacheEnabled) so every colo is invalidated.
export const REGIONAL_TTL_SEC = 5;

export const TAG_CACHE_OPTIONS = {
  baseShardSize: 12,
  regionalCache: true,
  regionalCacheTtlSec: REGIONAL_TTL_SEC,
  regionalCacheDangerouslyPersistMissingTags: true,
} as const;
