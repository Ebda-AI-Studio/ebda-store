import type { Request, RequestHandler } from 'express';

/**
 * PERF-BATCH-1 (Ruling PERF-BATCH-1): what a rate limiter WILL count for a request, declared next to the limiter so the
 * request-level prefetch (middleware/request-limit-prefetch.ts) can send every limiter hit of a request in ONE AuthState
 * round trip per shard, before the first limiter runs. The plan is built from the limiter's own options (security.ts
 * `plannedRateLimit`): the same store name, window, key function and skip predicate, so a plan cannot disagree with its
 * limiter. A limiter whose key depends on state set later in the chain (`req.user`) carries no plan and counts directly.
 */
export interface LimitPlan {
  /** Store name: the counter key is `rl:<name>:<key>`. */
  name: string;
  windowMs: number;
  /** The limiter's key for this request, or null when it would not count (no client address). */
  key(req: Request): string | null;
  skip(req: Request): boolean;
  /** The key reads `req.body` (prediction needs the parsed, sanitised body). */
  body?: boolean;
}

/** A middleware that knows several hits / peeks of its own (the public router's limiter family). */
export type LimitPlanner = (req: Request, path: string) => { hits: string[]; peeks: string[] };

const PLAN = Symbol.for('ebda.limitPlan');
const PLANNER = Symbol.for('ebda.limitPlanner');

export function withLimitPlan<T extends RequestHandler>(mw: T, plan: LimitPlan): T {
  return Object.assign(mw, { [PLAN]: plan });
}
export function limitPlanOf(fn: unknown): LimitPlan | undefined {
  return (fn as Record<symbol, LimitPlan | undefined> | null)?.[PLAN];
}
const NO_PLAN = Symbol.for('ebda.limitNoPlan');
/** A limiter that deliberately counts directly (its key reads state set later in the chain); `reason` is required. */
export function withoutLimitPlan<T extends RequestHandler>(mw: T, reason: string): T {
  return Object.assign(mw, { [NO_PLAN]: reason });
}
export function noLimitPlanReason(fn: unknown): string | undefined {
  return (fn as Record<symbol, string | undefined> | null)?.[NO_PLAN];
}
export function withLimitPlanner<T extends RequestHandler>(mw: T, planner: LimitPlanner): T {
  return Object.assign(mw, { [PLANNER]: planner });
}
export function limitPlannerOf(fn: unknown): LimitPlanner | undefined {
  return (fn as Record<symbol, LimitPlanner | undefined> | null)?.[PLANNER];
}

/** An express-rate-limit middleware (it exposes `resetKey` + `getKey`). */
export function isRateLimiter(fn: unknown): boolean {
  const f = fn as { resetKey?: unknown; getKey?: unknown } | null;
  return typeof f?.resetKey === 'function' && typeof f?.getKey === 'function';
}

// --- Express 4 router walk -----------------------------------------------------------------------------------------------

interface ExpressLayer {
  name: string;
  regexp: RegExp & { fast_slash?: boolean; fast_star?: boolean };
  keys: Array<{ name: string | number }>;
  method?: string;
  route?: { stack: ExpressLayer[]; _handles_method(method: string): boolean };
  handle: ((...args: unknown[]) => unknown) & { stack?: ExpressLayer[] };
}

export interface PlannedStep {
  plan?: LimitPlan;
  planner?: LimitPlanner;
  /** Route params at that point of the chain (express mergeParams is off: a route sees only its own). */
  params: Record<string, string>;
  /** The path as that layer sees it (mount prefixes stripped). */
  path: string;
}

function decode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function matchLayer(
  layer: ExpressLayer,
  path: string
): { matched: string; params: Record<string, string> } | null {
  if (layer.regexp.fast_slash) return { matched: '', params: {} };
  if (layer.regexp.fast_star) return { matched: path, params: { 0: decode(path) } };
  const m = layer.regexp.exec(path);
  if (!m) return null;
  const params: Record<string, string> = {};
  layer.keys.forEach((k, i) => {
    const v = m[i + 1];
    if (v !== undefined) params[String(k.name)] = decode(v);
  });
  return { matched: m[0], params };
}

function visit(handle: unknown, params: Record<string, string>, path: string, out: PlannedStep[]) {
  const plan = limitPlanOf(handle);
  if (plan) out.push({ plan, params, path });
  const planner = limitPlannerOf(handle);
  if (planner) out.push({ planner, params, path });
}

/** A mounted express Router (by shape: the bundle is minified, so the function name `router` cannot be relied on). */
function isRouter(layer: ExpressLayer): boolean {
  const h = layer.handle as unknown as { stack?: unknown; handle?: unknown };
  return Array.isArray(h.stack) && typeof h.handle === 'function';
}

function walk(stack: ExpressLayer[], method: string, path: string, out: PlannedStep[]): boolean {
  for (const layer of stack) {
    // error handlers never run on the request path
    if (layer.handle.length > 3 && !layer.route) continue;
    const m = matchLayer(layer, path);
    if (!m) continue;
    if (layer.route) {
      if (!layer.route._handles_method(method)) continue;
      let verb = method.toLowerCase();
      if (verb === 'head' && !layer.route.stack.some(l => l.method === 'head')) verb = 'get';
      for (const l of layer.route.stack)
        if (!l.method || l.method === verb) visit(l.handle, m.params, path, out);
      return true;
    }
    if (isRouter(layer)) {
      let rest = path.slice(m.matched.length);
      if (!rest.startsWith('/')) rest = `/${rest}`;
      if (walk(layer.handle.stack as ExpressLayer[], method, rest, out)) return true;
      continue;
    }
    visit(layer.handle, m.params, path, out);
  }
  return false;
}

/**
 * The planned limiters a request meets inside `router` (mounted at `mount`), in chain order, up to and including the first
 * route that handles it. A PREDICTION: a middleware that ends the request earlier, or a handler that calls `next()`, only
 * leaves a prefetched hit unconsumed, which is taken back when the response ends (cf/rate-limit-store `releaseUnconsumed`).
 */
export function plannedSteps(
  router: unknown,
  mount: string,
  method: string,
  path: string
): PlannedStep[] {
  const stack = (router as { stack?: ExpressLayer[] } | null)?.stack;
  if (!Array.isArray(stack)) return [];
  if (path !== mount && !path.startsWith(`${mount}/`)) return [];
  const out: PlannedStep[] = [];
  walk(stack, method, path.slice(mount.length) || '/', out);
  return out;
}

/** Every planned and unplanned limiter in a router tree (tests: completeness of the plans). */
export function allLimiterHandles(
  router: unknown
): Array<{ handle: unknown; planned: boolean; noPlanReason?: string }> {
  const out: Array<{ handle: unknown; planned: boolean; noPlanReason?: string }> = [];
  const seen = new Set<unknown>();
  const add = (h: unknown) => {
    if (seen.has(h)) return;
    seen.add(h);
    if (isRateLimiter(h))
      out.push({ handle: h, planned: Boolean(limitPlanOf(h)), noPlanReason: noLimitPlanReason(h) });
  };
  const rec = (stack: ExpressLayer[]) => {
    for (const layer of stack) {
      if (layer.route) layer.route.stack.forEach(l => add(l.handle));
      else if (isRouter(layer)) rec(layer.handle.stack as ExpressLayer[]);
      else add(layer.handle);
    }
  };
  const stack = (router as { stack?: ExpressLayer[] } | null)?.stack;
  if (Array.isArray(stack)) rec(stack);
  return out;
}
