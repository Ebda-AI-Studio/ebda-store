import type { Snapshot } from './types';

/**
 * Edge snapshot cache for the public reads (page, /search.json, /api/status.json).
 *
 * Why: every public read used to call the StatusStore Durable Object live. Measured 2026-11-19: the page
 * answered in 0.5 s or in 4-23 s (and a few 500s) depending on that call, while /healthz (no DO) stayed fast.
 * Reads now come from the Cache API; the DO is only asked to REFRESH, never on the visitor's critical path
 * once a snapshot exists in that colo.
 *
 * Staleness class: BOUNDED-stale. A served snapshot is at most FRESH_MS old, plus one refresh round-trip,
 * when the colo is busy; a quiet colo serves a snapshot up to MAX_STALE_MS old (2 cron intervals) while one
 * background refresh runs. The Cache API is per colo, so every colo pays one live DO read per MAX_STALE_MS at
 * worst, then none. The probe cron and incident writes refresh the colo they run in; other colos catch
 * up within FRESH_MS. A status page that lags real state by <= 30 s is within the probe cadence (5 min).
 */
export const FRESH_MS = 30_000;
export const MAX_STALE_MS = 10 * 60_000;
/** Synthetic cache key: never fetched, only a stable name inside caches.default. */
export const SNAPSHOT_KEY = 'https://status.ebda.app/__snapshot';

let inflight: Promise<Snapshot> | null = null;

const cache = () => caches.default;

async function refresh(load: () => Promise<Snapshot>): Promise<Snapshot> {
  // one live DO read per isolate at a time, however many visitors are waiting
  inflight ??= (async () => {
    try {
      const snap = await load();
      await cache().put(
        SNAPSHOT_KEY,
        new Response(JSON.stringify(snap), {
          headers: {
            'content-type': 'application/json',
            'cache-control': `public, max-age=${MAX_STALE_MS / 1000}`,
          },
        })
      );
      return snap;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function getSnapshot(
  load: () => Promise<Snapshot>,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  now = Date.now()
): Promise<Snapshot> {
  const hit = await cache().match(SNAPSHOT_KEY);
  const cached = hit ? ((await hit.json()) as Snapshot) : null;
  const age = cached ? now - cached.generatedAt : Infinity;
  if (cached && age <= FRESH_MS) return cached;
  if (cached && age <= MAX_STALE_MS) {
    const bg = refresh(load).catch(err => console.error('[status] snapshot refresh failed', err));
    if (ctx) ctx.waitUntil(bg);
    else await bg;
    return cached;
  }
  try {
    return await refresh(load);
  } catch (err) {
    // the DO is failing: an old snapshot beats a 500 for a status page
    if (cached) return cached;
    throw err;
  }
}

/** Write a fresh snapshot (cron, after a probe round). Failure never fails the caller. */
export async function warmSnapshot(load: () => Promise<Snapshot>): Promise<void> {
  await refresh(load).catch(err => console.error('[status] snapshot warm failed', err));
}
