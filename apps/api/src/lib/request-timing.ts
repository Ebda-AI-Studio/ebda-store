/**
 * Per-request Server-Timing (BE:E-1): `auth`, `identity`, `db-wait`, `handler`.
 *
 * The QA stall (33.5 s TTFB) was invisible because the only entry was `request-tx` (commit time). These four split the wait
 * into the places it can hide: signature + live identity check (`auth`, of which `identity` is the RPC pair), the time to lease a
 * pooled DB client and BEGIN (`db-wait`), and everything else (`handler`). Durations accumulate when a stage runs twice
 * (tenantContext pre-authenticates, `authenticate` then hits the cache).
 */
import type { NextFunction, Request, Response } from 'express';

const TIMINGS = Symbol('ebda.requestTimings');
type Timings = { start: number; ms: Record<string, number> };

function slot(req: Request): Timings | undefined {
  return (req as unknown as Record<symbol, Timings | undefined>)[TIMINGS];
}

export function recordTiming(
  req: Request,
  name: 'auth' | 'identity' | 'db-wait',
  ms: number
): void {
  const t = slot(req);
  if (!t) return;
  t.ms[name] = (t.ms[name] ?? 0) + Math.max(0, ms);
}

/** Serialise what was measured; `handler` is the remainder of the wall time. Exported for the unit test. */
export function formatServerTiming(t: Timings, now: number): string {
  const total = now - t.start;
  const accounted = (t.ms['auth'] ?? 0) + (t.ms['db-wait'] ?? 0);
  const entries = { ...t.ms, handler: Math.max(0, total - accounted) };
  return Object.entries(entries)
    .map(([k, v]) => `${k};dur=${v.toFixed(1)}`)
    .join(', ');
}

export function serverTiming(req: Request, res: Response, next: NextFunction): void {
  const t: Timings = { start: performance.now(), ms: {} };
  (req as unknown as Record<symbol, Timings>)[TIMINGS] = t;
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, ...args: Parameters<Response['writeHead']>) {
    if (!res.headersSent) {
      const prior = res.getHeader('Server-Timing');
      const mine = formatServerTiming(t, performance.now());
      res.setHeader('Server-Timing', prior ? `${String(prior)}, ${mine}` : mine);
    }
    return writeHead.apply(this, args);
  } as Response['writeHead'];
  next();
}
