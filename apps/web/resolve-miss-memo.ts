/**
 * QA-90: a host the API has just answered 404 for ("no store owns this domain") is remembered for a few seconds so the
 * layers that follow in the SAME request do not each ask again.
 *
 * WHY (measured 2026-11-20, never-seen `qa-cold-<n>.ebda.app/ar`: 1.3-3.0 s TTFB cold vs 0.48 s on the next hit, API
 * answers in 0.38 s): on a cold host the edge locale-redirect verdict, the demo verdict and then the page's own
 * resolver (`store-resolve-cache.ts`: R2 read + API call) each asked `GET /public/store/resolve` and the render waited
 * behind the slowest. The edge verdicts already cache a 404, but the render path could not see them (separate bundle).
 * This memo is shared through `globalThis`, so the render skips its R2 read + API round-trip.
 *
 * STALENESS CLASS: BOUNDED-stale, per isolate. A NEW store's host resolves within MISS_MEMO_TTL_MS (10 s) of the
 * first miss; `clearResolveMemory` (called on purge in this isolate) drops it at once. ONLY a definitive 404 is
 * recorded: a 429 / 5xx / network error / timeout is "could not ask" and is NEVER written here.
 */
export const MISS_MEMO_TTL_MS = 10_000;
const MAX_ENTRIES = 2_000;
const SLOT = Symbol.for('ebda.web.resolveMissMemo');

function slot(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  return (g[SLOT] ??= new Map<string, number>());
}

const norm = (host: string) => host.toLowerCase().replace(/^www\./, '');

/** Record a DEFINITIVE miss (HTTP 404 from the resolver). Never call for 429/5xx/errors. */
export function noteDefinitiveMiss(host: string, now = Date.now()): void {
  const m = slot();
  if (m.size >= MAX_ENTRIES) m.clear();
  m.set(norm(host), now);
}

export function isRecentDefinitiveMiss(host: string, now = Date.now()): boolean {
  const at = slot().get(norm(host));
  return at !== undefined && now - at >= 0 && now - at < MISS_MEMO_TTL_MS;
}

export function clearMissMemo(host?: string): void {
  if (host) slot().delete(norm(host));
  else slot().clear();
}
