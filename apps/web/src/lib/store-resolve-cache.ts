/**
 * Ruling RESOLVE-BULLETPROOF-1: the storefront's host -> store resolution never turns an API blip into an error page.
 *
 * WHY (2026-11-10 incident, measured): every render asks `GET /public/store/resolve`; the API's `storeResolveLimiter`
 * (30/min per IP) saw the whole storefront as one client, so busy or unknown hosts flipped between 404 and 500 inside a
 * minute. The Next data cache could not protect us: it has no stale-if-error for a host it has not cached since the
 * entry expired, and it cannot tell a purge apart from an outage. (Production does run a DO-sharded tag cache via the
 * deploy-generated open-next config, so its own tag purges work; the committed local config has none.) This module
 * is therefore the ONE owner of resolve caching, checked against the purge epochs, and the resolve fetch is no-store.
 *
 * LAYERS (docs/plans/done/2026-11-10-resolve-bulletproof.md):
 *   L1 per-isolate memory of hits AND definitive misses (hit 60 s / miss 30 s; without R2 8 s / 15 s).
 *   L2 durable last-known-good in R2 (`resolve-lkg/<host>`), shared by every isolate: fresh 60 s / 30 s, stale-if-error 24 h.
 *   L3 concurrent misses for one key in one isolate share one API call.
 *   L4 stale-if-error: on 429/5xx/network/timeout serve the newest copy that is still epoch-current.
 *   L5 no copy at all -> one retry after 150-400 ms (never on a definitive 404), then StoreTemporarilyUnavailableError
 *      (-> 503 + Retry-After at the edge, resolve-unavailable-edge.ts; never cached).
 *
 * STALENESS CLASS: store status, domain/slug ownership and plan entitlement are NEVER-stale. Every serve from L1/L2/L4
 * first checks the per-store purge EPOCHS the Worker writes to R2 on every `/api/revalidate` (store-edge-cache.ts,
 * Ruling STORE-EDGE-1): `all`, `host/<host>` and `id/<storeId>`. A copy stamped before a newer epoch is never served —
 * not even during an outage (fail closed: 503, not a suspended store's shop). Every API write path that changes those
 * properties ends in `bustStoreCaches` -> `revalidateStorefront`, which bumps both the host and the `id/<storeId>`
 * epoch. Residuals: the 2 s epoch memo (EPOCH_MEMO_MS, NZ-D3) and, during an outage only, a copy up to 24 h old when no
 * purge happened in between. Theme/content fields ride the same payload and are BOUNDED-stale at 60 s.
 * No R2 (next dev / next start / tests): no cross-isolate invalidation exists, so the memory TTLs drop to 8 s / 15 s.
 * R2 bound but unreadable: a copy is served only while under 8 s old (the pre-PR window); older -> API, else 503.
 */
import { entryEpochState, type R2Like } from '../../store-edge-cache';
import { clearMissMemo, isRecentDefinitiveMiss } from '../../resolve-miss-memo';
import { StoreTemporarilyUnavailableError } from './store-unavailable';

export const HIT_TTL_MS = 60_000;
export const MISS_TTL_MS = 30_000;
/** Without R2 epochs nothing can invalidate another isolate, so keep the old short window. */
export const LOCAL_HIT_TTL_MS = 8_000;
export const LOCAL_MISS_TTL_MS = 15_000;
/** Outage mode: the oldest copy stale-if-error may serve (only if no purge happened since it was fetched). */
export const MAX_STALE_MS = 24 * 60 * 60_000;
export const RETRY_MIN_MS = 150;
export const RETRY_SPREAD_MS = 250;

export interface ResolveDeps {
  r2: R2Like | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
  waitUntil(p: Promise<unknown>): void;
}

interface Entry<T> {
  /** Moment the API call that produced this value STARTED (so a purge during the call invalidates it). */
  at: number;
  value: T | null;
}

const memory = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const MEMORY_MAX = 5_000;

const lkgKey = (key: string) => `resolve-lkg/${key}`;

function idOf(value: unknown): string {
  // A parsed store carries `id`; a raw resolve body carries `data.store.id` (store-resolver.ts caches the raw body).
  const v = value as { id?: unknown; data?: { store?: { id?: unknown } } } | null;
  const id = v?.id ?? v?.data?.store?.id;
  return typeof id === 'string' && id ? id : '-';
}

/**
 * May this copy be served? `current` (no newer purge) = yes. `purged` = never. `unknown` (R2 unreadable) = only while
 * younger than {@link LOCAL_HIT_TTL_MS}: the same 8 s window the resolver had before R2 epochs existed, so an R2 outage
 * does not send every render to the API (where the limiter would 429 and every store would 503), and the NEVER-stale
 * budget is the pre-epoch 8 s, not the copy's 60 s / 24 h. No R2 binding at all = nothing can purge, TTL decides.
 */
async function usable(deps: ResolveDeps, host: string, e: Entry<unknown>): Promise<boolean> {
  if (!deps.r2) return true;
  const state = await entryEpochState(deps.r2, { at: e.at, host, id: idOf(e.value) }, deps.now());
  if (state === 'current') return true;
  return state === 'unknown' && deps.now() - e.at < LOCAL_HIT_TTL_MS;
}

function freshFor(deps: ResolveDeps, e: Entry<unknown>): number {
  const hit = e.value !== null;
  if (deps.r2) return hit ? HIT_TTL_MS : MISS_TTL_MS;
  return hit ? LOCAL_HIT_TTL_MS : LOCAL_MISS_TTL_MS;
}

function remember(key: string, e: Entry<unknown>): void {
  if (memory.size >= MEMORY_MAX) memory.clear();
  memory.set(key, e);
}

async function readDurable(deps: ResolveDeps, key: string): Promise<Entry<unknown> | null> {
  if (!deps.r2) return null;
  try {
    const o = await deps.r2.get(lkgKey(key));
    if (!o) return null;
    const e = JSON.parse(await o.text()) as Entry<unknown>;
    return typeof e?.at === 'number' && 'value' in e ? e : null;
  } catch {
    return null;
  }
}

// ---- alert signal (Ruling RESOLVE-BULLETPROOF-1 §alert) ---------------------------------------------------------
export const ALERT_WINDOW_MS = 60_000;
export const ALERT_THRESHOLD = 10;
let windowStart = 0;
let windowCount = 0;
let windowAlerted = false;
type Alerter = (msg: string, extra: Record<string, unknown>) => void;
let alerter: Alerter = (msg, extra) => {
  console.error(`[resolve-degraded] ${msg}`, JSON.stringify(extra));
  void import('@sentry/nextjs')
    .then(S => S.captureMessage(`[resolve-degraded] ${msg}`, { level: 'error', extra }))
    .catch(() => {});
};

/** Count one upstream failure (429/5xx/network/timeout); fires the alert once per window at the threshold. */
export function noteResolveFailure(now: number, detail: string): void {
  if (now - windowStart >= ALERT_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
    windowAlerted = false;
  }
  windowCount += 1;
  if (!windowAlerted && windowCount >= ALERT_THRESHOLD) {
    windowAlerted = true;
    alerter(
      `${windowCount} store-resolve upstream failures in ${ALERT_WINDOW_MS / 1000}s (this isolate)`,
      {
        last: detail,
      }
    );
  }
}

/**
 * Resolve `key` (a normalised host) through L1-L5. `fetchFresh` returns the value, `null` for a DEFINITIVE miss, or
 * throws StoreTemporarilyUnavailableError when the API could not be asked. `host` is the epoch host label.
 */
export async function resolveResilient<T>(
  key: string,
  host: string,
  fetchFresh: () => Promise<T | null>,
  deps: ResolveDeps
): Promise<T | null> {
  const now = deps.now();
  const mem = memory.get(key) as Entry<T> | undefined;
  if (mem && now - mem.at < freshFor(deps, mem) && (await usable(deps, host, mem)))
    return mem.value;

  // QA-90: the edge verdict layers just got a definitive 404 for this host (<= 10 s ago): skip the R2 read + API call.
  if (isRecentDefinitiveMiss(key, now)) return null;

  const pending = inflight.get(key) as Promise<T | null> | undefined;
  if (pending) return pending;
  const run = (async (): Promise<T | null> => {
    const durable = (await readDurable(deps, key)) as Entry<T> | null;
    if (
      durable &&
      deps.now() - durable.at < freshFor(deps, durable) &&
      (await usable(deps, host, durable))
    ) {
      remember(key, durable);
      return durable.value;
    }

    const attempt = async (): Promise<T | null> => {
      const at = deps.now();
      const value = await fetchFresh();
      const e: Entry<T> = { at, value };
      remember(key, e);
      if (deps.r2) {
        const r2 = deps.r2;
        deps.waitUntil(
          Promise.resolve()
            .then(() => r2.put(lkgKey(key), JSON.stringify(e)))
            .catch(() => {})
        );
      }
      return value;
    };

    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof StoreTemporarilyUnavailableError)) throw error;
      noteResolveFailure(deps.now(), error.message);
      // L4: newest copy we hold, if no purge has happened since it was fetched.
      const copies = [mem, durable]
        .filter((c): c is Entry<T> => !!c && deps.now() - c.at < MAX_STALE_MS)
        .sort((a, b) => b.at - a.at);
      for (const c of copies) {
        if (await usable(deps, host, c)) {
          console.warn(
            `[resolve] serving stale copy for ${key} (${Math.round((deps.now() - c.at) / 1000)}s old)`
          );
          return c.value;
        }
      }
      // L5: nothing safe to serve; one short jittered retry, then give up.
      await deps.sleep(RETRY_MIN_MS + Math.floor(deps.random() * RETRY_SPREAD_MS));
      try {
        return await attempt();
      } catch (retryError) {
        if (retryError instanceof StoreTemporarilyUnavailableError)
          noteResolveFailure(deps.now(), retryError.message);
        throw retryError;
      }
    }
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/** Drop this isolate's copies (all, or one key). The durable copy is guarded by the epochs, not by this. */
export function clearResolveMemory(key?: string): void {
  clearMissMemo(key);
  if (key) memory.delete(key);
  else memory.clear();
}

/** Test seams. */
export function __resetResolveCacheForTest(a?: Alerter): void {
  memory.clear();
  clearMissMemo();
  inflight.clear();
  windowStart = 0;
  windowCount = 0;
  windowAlerted = false;
  if (a) alerter = a;
}
