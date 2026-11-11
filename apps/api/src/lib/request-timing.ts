/**
 * Per-request Server-Timing (BE:E-1): `auth`, `identity`, `db-wait`, `handler`, plus one entry per remote binding kind the
 * request called (`d1`, `store-do`, `auth-state`, `do-other`, `accounts`, `kv`: `desc` = calls, `dur` = summed ms; PERF-LATENCY,
 * lib/io-tally.ts).
 *
 * The QA stall (33.5 s TTFB) was invisible because the only entry was `request-tx` (commit time). These four split the wait
 * into the places it can hide: signature + live identity check (`auth`, of which `identity` is the RPC pair), the time to lease a
 * pooled DB client and BEGIN (`db-wait`), and everything else (`handler`). Durations accumulate when a stage runs twice
 * (tenantContext pre-authenticates, `authenticate` then hits the cache).
 */
import type { NextFunction, Request, Response } from 'express';
import { formatIoTiming, newIoTally, runWithIoTally, type IoTally } from './io-tally';
import { runWithRequestMemo } from './request-memo';

const TIMINGS = Symbol('ebda.requestTimings');
type Timings = { start: number; ms: Record<string, number>; io?: IoTally };

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
  return [
    ...Object.entries(entries).map(([k, v]) => `${k};dur=${v.toFixed(1)}`),
    ...(t.io ? formatIoTiming(t.io) : []),
  ].join(', ');
}

/**
 * Credential entry points (sign-in, register, reset, MFA, passkeys, staff invites): in production their responses carry no
 * per-binding call counts, so a caller cannot tell "account exists" from "it does not" by how many store calls the attempt made
 * (the dummy bcrypt compare equalises the time; a count would not be equalised). Tests and local dev keep them (the budgets).
 */
const CREDENTIAL_PATH_RE = /^(?:\/api\/v1)?\/(?:auth|staff-invites)(?:\/|$)/;
export function showsIoCounts(path: string, nodeEnv = process.env.NODE_ENV): boolean {
  return (
    nodeEnv !== 'production' || process.env.DEV_STATS === '1' || !CREDENTIAL_PATH_RE.test(path)
  );
}

export function serverTiming(req: Request, res: Response, next: NextFunction): void {
  const io = newIoTally();
  if (process.env.DEV_STATS === '1') {
    io.ops = [];
    // API-HANG-1 tests: a production-like AuthState round trip, or a stuck instance (cf/auth-state-client.ts `call`)
    const delayMs = Math.min(
      5_000,
      Math.max(0, Number(req.headers['x-dev-authstate-delay-ms']) || 0)
    );
    const stall = String(req.headers['x-dev-authstate-stall'] ?? '').slice(0, 64);
    if (delayMs || stall) io.authStateFault = { delayMs, stall };
  }
  const t: Timings = {
    start: performance.now(),
    ms: {},
    io: showsIoCounts(req.originalUrl?.split('?')[0] ?? req.path) ? io : undefined,
  };
  (req as unknown as Record<symbol, Timings>)[TIMINGS] = t;
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, ...args: Parameters<Response['writeHead']>) {
    if (!res.headersSent) {
      const prior = res.getHeader('Server-Timing');
      const mine = formatServerTiming(t, performance.now());
      res.setHeader('Server-Timing', prior ? `${String(prior)}, ${mine}` : mine);
      if (process.env.DEV_STATS === '1' && io.ops)
        res.setHeader('x-dev-io-ops', encodeURIComponent(io.ops.join('\n')));
    }
    return writeHead.apply(this, args);
  } as Response['writeHead'];
  // Every binding call made while this request runs is tallied (lib/io-tally.ts); read back above when the head is written.
  // The request-scoped memo (lib/request-memo.ts) opens here too: one scope per HTTP request.
  runWithIoTally(io, () => runWithRequestMemo(next));
}
