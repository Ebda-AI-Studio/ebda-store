import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { cfWaitUntil } from '../cf/bindings';
import { authStateAvailable } from '../cf/auth-state-client';
import { prefetchHits, releaseUnconsumed, runWithPrefetchedHits } from '../cf/rate-limit-store';
import { isWorkers } from '../lib/runtime';
import { limitPlanOf, plannedSteps, type PlannedStep } from './limit-plan';
import { REAL_REQUEST } from './public-limiter-keys';

/**
 * PERF-BATCH-1 (Ruling PERF-BATCH-1): every rate-limit hit of a request in ONE AuthState round trip per shard.
 *
 * Mounted in place of the global limiter (app.ts). Before the global limiter runs it walks the API router for the route this
 * request will reach (middleware/limit-plan.ts `plannedSteps`) and collects the plan of every limiter on the way: the global
 * limiter, router-level and route-level limiters (sign-in: `rl:global` + `rl:auth-ip-fail` + `rl:auth`; guest order create:
 * `rl:global` + the public family + `rl:write`). All their hits go out at once, batched per shard (cf/rate-limit-store.ts
 * `prefetchHits`), then the global limiter runs and each later limiter takes its prefetched result. Before: each limiter was
 * its own serial round trip (sign-in 3, order create 3, measured 2026-11-11).
 *
 * Nothing about a limit changes: every limiter still runs in its place with its own key, window, max, headers, 429 body and
 * skip; a hit no limiter takes (an earlier 429, a 401 before the limiter, a wrong prediction) is taken back with `unhit` when
 * the response ends; a limiter that finds no prefetched hit counts directly as before. A batched call that times out applies
 * the strictest fail class among its members (Ruling API-HANG-2 + PERF-BATCH-1).
 *
 * Keys that read the body (the per-email sign-in, reset and verify limiters, MCP writes, contact enquiries) need it parsed:
 * for such a route the JSON body parser runs here, before the global limiter, instead of after it. A parse error is held and
 * raised at the parser's own place in the chain (`raiseHeldBodyError`), so a request over the global limit still gets the
 * global 429 first, exactly as before. The key is predicted on a copy of the request whose body went through the same input
 * sanitiser and cookie parser the limiter will see (`prepare`).
 */
const HELD_BODY_ERROR = Symbol('ebda.heldBodyError');
/** Every limiter a planner (the public router's family) names counts per 60 s (public-limit-prefetch.ts). */
const PUBLIC_WINDOW_MS = 60_000;

interface RequestLimitPrefetchOptions {
  /** The global limiter (its plan is read off it). */
  global: RequestHandler;
  /** The API router and the path it is mounted at. */
  router: unknown;
  mount: string;
  /** The app's JSON body parser (the same instance mounted after the global limiter). */
  jsonBody: RequestHandler;
  /** Make a prediction copy look like the request the limiter will see (sanitised body, parsed cookies). */
  prepare: (copy: Request) => void;
}

/**
 * A copy of the request for key prediction: reads go to the real request (its getters run on IT, so `req.ip` reads the real
 * socket, a workerd private field a prototype copy cannot reach), writes stay on the copy (sanitised body, parsed cookies,
 * route params), so the request itself is never touched.
 */
function predictionCopy(req: Request, own: Record<PropertyKey, unknown>): Request {
  return new Proxy(req, {
    get(target, prop) {
      if (prop === REAL_REQUEST)
        return (target as unknown as Record<symbol, unknown>)[REAL_REQUEST] ?? target; // copies nest
      if (Object.prototype.hasOwnProperty.call(own, prop)) return own[prop];
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
    set(_target, prop, value) {
      own[prop] = value;
      return true;
    },
    has(target, prop) {
      return Object.prototype.hasOwnProperty.call(own, prop) || Reflect.has(target, prop);
    },
  });
}

/** The planned limiters this request meets: the global limiter first, then the API router's, in chain order. */
function requestLimitSteps(
  req: Request,
  opts: Pick<RequestLimitPrefetchOptions, 'global' | 'router' | 'mount'>
): PlannedStep[] {
  const steps = plannedSteps(opts.router, opts.mount, req.method, req.path);
  const globalPlan = limitPlanOf(opts.global);
  return globalPlan ? [{ plan: globalPlan, params: {}, path: req.path }, ...steps] : steps;
}

/** The hits (and peeks) of those steps, one per key. */
function requestLimitPlan(
  req: Request,
  steps: PlannedStep[],
  prepare: RequestLimitPrefetchOptions['prepare']
): { hits: Array<{ key: string; windowMs: number }>; peeks: string[] } {
  const hits: Array<{ key: string; windowMs: number }> = [];
  const peeks: string[] = [];
  const base = predictionCopy(req, {});
  prepare(base);
  for (const step of steps) {
    const copy = predictionCopy(base, { params: step.params });
    if (step.planner) {
      const p = step.planner(copy, step.path);
      p.hits.forEach(key => hits.push({ key, windowMs: PUBLIC_WINDOW_MS }));
      peeks.push(...p.peeks);
      continue;
    }
    const plan = step.plan;
    if (!plan || plan.skip(copy)) continue;
    const key = plan.key(copy);
    if (key !== null) hits.push({ key: `rl:${plan.name}:${key}`, windowMs: plan.windowMs });
  }
  return { hits, peeks };
}

export function prefetchRequestLimits(opts: RequestLimitPrefetchOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isWorkers || !authStateAvailable()) return opts.global(req, res, next);
    const steps = requestLimitSteps(req, opts);
    const go = () => {
      const plan = requestLimitPlan(req, steps, opts.prepare);
      if (plan.hits.length === 0 && plan.peeks.length === 0) return opts.global(req, res, next);
      const hits = prefetchHits(plan.hits, plan.peeks);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        cfWaitUntil(releaseUnconsumed(hits));
      };
      res.once('finish', release);
      res.once('close', release);
      runWithPrefetchedHits(hits, () => opts.global(req, res, next));
    };
    if (!steps.some(s => s.plan?.body)) return go();
    opts.jsonBody(req, res, (err?: unknown) => {
      if (err) (req as unknown as Record<symbol, unknown>)[HELD_BODY_ERROR] = err;
      go();
    });
  };
}

/** Mounted right before the JSON body parser: raises a parse error held by the early parse, at the parser's own place. */
export function raiseHeldBodyError(req: Request, _res: Response, next: NextFunction): void {
  const err = (req as unknown as Record<symbol, unknown>)[HELD_BODY_ERROR];
  if (err) return next(err);
  next();
}
