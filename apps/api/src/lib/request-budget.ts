/**
 * Per-route request counters (NEON-ZERO plan 9.2, FOLD-COUNTERS): ONE Analytics Engine data point per sampled request in the
 * dataset `ebda_request_budget` (binding `REQUEST_BUDGET`). Feeds the p95 alert (lib/request-budget-alert.ts) and the SCALE-READY numbers.
 *
 * Shape: index = route TEMPLATE (`/api/v1/stores/:storeId/products/:id`, never the raw path), blobs = [storeShard, method, status class],
 * doubles = [weight (1 when always-sampled, else SAMPLE_RATE: the number of requests this point stands for), wall ms, status code]. Cardinality is bounded: the template set is the router, `storeShard` is the store id hashed
 * into 64 buckets (never the id), and nothing user-supplied (query, header, body, user id, IP) is ever written. No PII by construction.
 * Sampling: 1 in 20, ALWAYS for a non-2xx/3xx response and for a slow one (>= SLOW_MS). Unbound = a no-op, never an error.
 *
 * Not counted here: per-request D1 / DO / KV call counts. The store D1 client has no `onStatement` wiring in the API yet, so those
 * doubles are a follow-up; latency + route + status are what the alert needs.
 * Cost if wrong: a dropped data point (fire-and-forget, wrapped in try/catch); the response is never affected.
 */
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { cfBindings, type AnalyticsEngineLike } from '../cf/bindings';

const SAMPLE_RATE = 20;
const SLOW_MS = 1500;
const STORE_SHARDS = 64;

export function storeShard(storeId: string | undefined): string {
  if (!storeId) return 'none';
  return String(createHash('sha256').update(storeId).digest().readUInt16BE(0) % STORE_SHARDS);
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/** The store id segment of a mount path (`/stores/<id>/...`), the one raw id the mount carries. */
const STORE_SEGMENT = /(^|\/)stores\/([^/]+)/;

/**
 * The matched Express route template, or a fixed label. Never the raw path: `baseUrl` holds the CONCRETE mount path
 * (`/api/v1/stores/<uuid>/products`), so every param value in it goes back to `:name`, and whatever follows `/stores/` is
 * `:storeId` even when the router did not merge its parent params. Read it while the router stack is intact.
 */
function routeTemplate(req: Pick<Request, 'baseUrl' | 'route' | 'params'>): string {
  const p = req.route?.path;
  if (typeof p !== 'string') return 'unmatched';
  let base = req.baseUrl || '';
  for (const [name, value] of Object.entries(req.params ?? {})) {
    if (typeof value !== 'string' || !value) continue;
    base = base
      .split('/')
      .map(seg => (seg === value ? `:${name}` : seg))
      .join('/');
  }
  base = base.replace(STORE_SEGMENT, (_m, lead: string) => `${lead}stores/:storeId`);
  return `${base}${p}`.replace(/\/+$/, '') || '/';
}

/** The store id of this request, from the params or the mount path. Read while the router stack is intact. */
function requestStoreId(req: Pick<Request, 'baseUrl' | 'params'>): string | undefined {
  const fromParams = req.params?.storeId;
  if (typeof fromParams === 'string' && fromParams) return fromParams;
  return STORE_SEGMENT.exec(req.baseUrl || '')?.[2];
}

/** 0 = drop; otherwise the weight of the point (requests it represents). Errors and slow requests are always kept at weight 1. */
function sampleWeight(status: number, ms: number, rand: () => number = Math.random): number {
  if (status >= 400 || ms >= SLOW_MS) return 1;
  return rand() * SAMPLE_RATE < 1 ? SAMPLE_RATE : 0;
}

export function requestBudget(
  sink: () => AnalyticsEngineLike | undefined = () => cfBindings()?.REQUEST_BUDGET,
  rand: () => number = Math.random
) {
  return function requestBudgetMw(req: Request, res: Response, next: NextFunction): void {
    const start = performance.now();
    let template = 'unmatched';
    let storeId: string | undefined;
    const end = res.end.bind(res) as (...a: unknown[]) => Response;
    // Capture template AND store id while the router stack is still intact: by 'finish' the routers have reset
    // `baseUrl` and `params` (the store bucket was always `none` when read there).
    res.end = ((...a: unknown[]) => {
      template = routeTemplate(req);
      storeId = requestStoreId(req);
      return end(...a);
    }) as typeof res.end;
    res.once('finish', () => {
      try {
        const ae = sink();
        if (!ae) return;
        const ms = Math.round(performance.now() - start);
        const status = res.statusCode;
        const weight = sampleWeight(status, ms, rand);
        if (!weight) return;
        ae.writeDataPoint({
          indexes: [template.slice(0, 96)],
          blobs: [storeShard(storeId), req.method, statusClass(status)],
          doubles: [weight, ms, status],
        });
      } catch {
        /* telemetry never affects the response */
      }
    });
    next();
  };
}
