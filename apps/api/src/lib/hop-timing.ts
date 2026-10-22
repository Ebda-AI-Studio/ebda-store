/**
 * Per-hop request timing, operator-only (see `hopTiming`).
 *
 * Used to find where an API request spends its wall time (Durable Object ops, KV, database
 * queries, the request transaction) because CPU is ~10-40 ms while wall is 1-15 s. Off unless the
 * request asks for it: no header, no store, no overhead beyond one header read. It only OBSERVES;
 * it never changes whether or how any guard, query or cache op runs.
 *
 * The result is one structured log line per traced request (hop names are op kinds such as
 * `do-ratelimit-hit`, `kv-get`, `db-Store.findUnique`; never keys, ids or values).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import logger from './logger';

interface Trace {
  t0: number;
  hops: Array<{ name: string; at: number; ms: number }>;
}
const als = new AsyncLocalStorage<Trace>();

const clean = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48);

export function recordHop(name: string, ms: number): void {
  const t = als.getStore();
  if (t) t.hops.push({ name: clean(name), at: performance.now() - t.t0 - ms, ms });
}

/** Run `fn` and record its duration as `name` when the current request is traced. */
export async function hop<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!als.getStore()) return fn();
  const t = performance.now();
  try {
    return await fn();
  } finally {
    recordHop(name, performance.now() - t);
  }
}

/** Mark "the request reached here" (cumulative ms since it entered the app). */
export function markHop(name: string): void {
  const t = als.getStore();
  if (t) t.hops.push({ name: clean(`at-${name}`), at: performance.now() - t.t0, ms: 0 });
}

/** Constant-time check of the operator token (sha256 both sides so lengths never leak). */
function operatorAllowed(req: Request): boolean {
  const secret = process.env.HOP_TIMING_TOKEN;
  const given = req.headers['x-hop-timing'];
  if (!secret || secret.length < 16 || typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * Operator-only: traced when `x-hop-timing` equals the Worker secret `HOP_TIMING_TOKEN` (unset or
 * short secret = feature off). The timings go to the Worker LOG only (one structured line per
 * traced request, read with `wrangler tail`); they are NEVER written to the response, so a public
 * caller can neither trigger nor see them (no timing oracle for account enumeration).
 */
export function hopTiming(req: Request, res: Response, next: NextFunction): void {
  if (!operatorAllowed(req)) return next();
  const trace: Trace = { t0: performance.now(), hops: [] };
  res.once('finish', () => {
    // No path: it can carry ids or contact data; the operator knows what they requested.
    logger.info(
      {
        hopTiming: true,
        method: req.method,
        status: res.statusCode,
        totalMs: Math.round(performance.now() - trace.t0),
        hops: trace.hops.slice(0, 80).map(h => [h.name, Math.round(h.at), Math.round(h.ms)]),
      },
      'hop-timing'
    );
  });
  als.run(trace, next);
}
