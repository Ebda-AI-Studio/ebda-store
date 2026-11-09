/**
 * Ruling EDGE-BUILD-1: cached HTML never outlives the build that rendered it.
 *
 * WHY: storefront HTML names content-hashed files under `/_next/static/`. Workers Static Assets belong to ONE Worker
 * version, so a deploy replaces them and the previous build's chunks answer 404. Both HTML edge layers (demo-edge-cache.ts,
 * store-edge-cache.ts) keyed their copies by host + path only, so a copy rendered by the previous version was served by the
 * new one: an unstyled, non-interactive page for up to 24 h per data centre on the demo layer and up to 10 min on the store
 * layer (measured 2026-11-09 on storedemo.ebda.app/en after the 20:58Z deploy: `x-demo-edge: STALE`, 5 JS chunks and the
 * stylesheet 404).
 *
 * RULE: the Worker version id (`CF_VERSION_METADATA.id`, the same value `/health` reports as `deploymentId`) is part of
 * every HTML edge-cache key. A version reads and writes only its own entries, so the copy it serves always names files it
 * can serve. This holds through a rollback (the old version's entries are its own again) and through the seconds in which
 * two versions answer side by side. Nothing has to be purged, so there is no purge that can be forgotten or lost.
 *
 * NO ID = NO CACHE: without a well-formed id the layers do not read or write at all (every request renders). The id is a
 * binding the deploy config must carry; `scripts/assert-cf-cache-bindings.sh` fails the deploy and the PR dry run when
 * the generated wrangler.jsonc lacks it.
 */
export interface BuildEnv {
  CF_VERSION_METADATA?: { id?: unknown } | null;
}

/** The Worker version id that partitions the HTML edge caches, or null when it is missing or malformed. */
export function edgeBuildId(env: BuildEnv): string | null {
  const id = env.CF_VERSION_METADATA?.id;
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

/** `key` (an `https://host/path[?query]` cache key) as stored under `build`. The result is still a parseable URL. */
export function buildScopedKey(key: string, build: string): string {
  return `${key}${key.includes('?') ? '&' : '?'}__build=${build}`;
}
