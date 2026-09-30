import logger from './logger';
import { sendAlert } from '../services/alerts.service';

/**
 * Observability for the rate limiters in middleware/security.ts.
 *
 * issue 2216 / issue 2230 / issue 2171: #1862 made every limiter's counters
 * genuinely shared in Redis, which TIGHTENS each per-IP budget by the replica
 * count (a limit that used to be N × replicas becomes N) — and nothing
 * measured the effect. The first signal would have been missing orders.
 * Every 429 is now counted per limiter prefix (`rl:<name>:`), and a summary
 * line is logged once a minute, so a step change is visible in the log drain
 * and alerted on when it is large.
 *
 * issue 1963: when Redis is not connected (boot, an outage, a latched error)
 * or shared counting is switched off (`RATE_LIMIT_SHARED=0`), every limiter
 * silently counted in a per-process MemoryStore — the exact wrong-budget state
 * #1862 was about. The fallback is now announced: counted in the same summary,
 * and alerted ONCE when it happens after a period of Redis-backed counting.
 *
 * No timers: the summary is flushed lazily by the next event after the
 * window, so an idle process logs nothing and nothing keeps the loop alive.
 */

const WINDOW_MS = 60_000;

interface Window {
  startedAt: number;
  exceeded: Map<string, number>;
  memoryFallback: Map<string, number>;
}

const state = {
  window: { startedAt: Date.now(), exceeded: new Map(), memoryFallback: new Map() } as Window,
  /** Has any limiter counted in Redis in this process? */
  sawShared: false,
  /** Alerted about the current fallback episode (reset once Redis is back). */
  fallbackAlerted: false,
};

function alertThreshold(): number {
  const n = Number(process.env.RATE_LIMIT_429_ALERT_PER_MIN);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

function flushIfDue(now: number): void {
  const w = state.window;
  if (now - w.startedAt < WINDOW_MS) return;
  state.window = { startedAt: now, exceeded: new Map(), memoryFallback: new Map() };
  if (w.exceeded.size === 0 && w.memoryFallback.size === 0) return;
  const exceeded = Object.fromEntries(w.exceeded);
  const memoryFallback = Object.fromEntries(w.memoryFallback);
  logger.warn(
    { rateLimited: exceeded, memoryFallback, windowMs: now - w.startedAt },
    '[rate-limit] 429s by limiter in the last window'
  );
  const threshold = alertThreshold();
  const hot = [...w.exceeded].filter(([, n]) => n >= threshold);
  if (hot.length > 0) {
    void sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'rate-limit.429-spike',
      // Stable title so the alerts throttle collapses a sustained spike.
      title: 'Rate limiter 429 spike',
      body:
        `${hot.map(([p, n]) => `${p} ${n}`).join(', ')} — ≥${threshold} 429s in a minute. If this is a shared ` +
        'carrier IP (CGNAT) rather than abuse, the per-IP budget is too small for real ' +
        'traffic — see Ruling S1-4.',
      context: { rateLimited: exceeded },
    }).catch(() => undefined);
  }
}

/** A request was refused by the limiter with this store prefix. */
export function recordRateLimited(prefix: string, now = Date.now()): void {
  flushIfDue(now);
  const m = state.window.exceeded;
  m.set(prefix, (m.get(prefix) ?? 0) + 1);
}

/** A limiter counted in Redis (shared). Re-arms the fallback alert. */
export function recordSharedCounting(): void {
  state.sawShared = true;
  state.fallbackAlerted = false;
}

/**
 * A limiter counted in its per-process MemoryStore for this request.
 * `reason`: 'disabled' (RATE_LIMIT_SHARED=0) or 'redis-unavailable'.
 */
export function recordMemoryFallback(
  prefix: string,
  reason: 'disabled' | 'redis-unavailable',
  now = Date.now()
): void {
  flushIfDue(now);
  const m = state.window.memoryFallback;
  m.set(prefix, (m.get(prefix) ?? 0) + 1);
  if (reason === 'redis-unavailable' && state.sawShared && !state.fallbackAlerted) {
    state.fallbackAlerted = true;
    logger.warn(
      { limiter: prefix },
      '[rate-limit] Redis unavailable — limiters now count per process (per-replica budgets, reset on deploy)'
    );
    void sendAlert({
      level: 'info',
      scope: 'platform',
      source: 'rate-limit.memory-fallback',
      title: 'Rate limiters fell back to per-process counting',
      body:
        'Redis is not connected, so every limiter is counting in local memory: each budget ' +
        'is now per replica and resets on deploy. Shared counting resumes automatically when ' +
        'Redis reconnects.',
      context: { limiter: prefix },
    }).catch(() => undefined);
  }
}

/** Test hook. */
export function resetRateLimitTelemetry(now = Date.now()): void {
  state.window = { startedAt: now, exceeded: new Map(), memoryFallback: new Map() };
  state.sawShared = false;
  state.fallbackAlerted = false;
}
