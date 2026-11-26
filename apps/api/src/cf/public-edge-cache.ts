/**
 * Public read edge cache in the API Worker (SEO-3 / P14, Ruling EDGE-API-1).
 *
 * WHY HERE: the API Worker is bound straight to api.ebda.app, so a Worker route runs BEFORE Cloudflare's zone
 * cache and the `Cache-Control: public, s-maxage` the public routes already send was honoured by nothing
 * (measured: no cf-cache-status, ~1 s per read, 503 OVERLOADED under one light client). A hit here answers before
 * Express, the database lease and the role check, so it also takes load off the connection pool that sheds the 503.
 * The layer sits above the data path, so it is the same code on the Durable Object / D1 backend (and on the
 * Node shell's local Postgres).
 *
 * WHAT IS CACHED: anonymous GET /public/products, /public/products/:slugOrId, /public/categories, /public/tags for a
 * store selected by `x-store-domain`, and only a 200 the route itself marked cacheable (`setEdgeCache` stamps the
 * fill headers; a private/no-store answer carries none and is never stored).
 *
 * KEY: store host + CORS origin + path + sorted query. Never a cookie, a credential, `x-store-id`, a preview token,
 * the search-term header, a session header or the DO opt-in header: any of those bypasses the layer.
 *
 * STALENESS (the rule: TTL alone is never enough for price/stock): a stored copy is served only while the cache
 * GENERATIONS it was filled under are unchanged (lib/edge-gens.ts). Every write path already bumps them (they are the
 * counters `invalidateCached*` maintain in the strongly consistent AuthState DO), in every data centre at once.
 * One DO read validates a hit. If the generations cannot be read the request bypasses to the origin (fail closed).
 *   - NEVER-stale (products, product detail): served only inside the fresh window (`s-maxage`), never from the
 *     stale-while-revalidate tail, and only with unchanged generations.
 *   - BOUNDED-stale (categories, tags): fresh window plus the swr tail, same generation check.
 * Residuals: (1) the KV L1 under `getCached` is eventually consistent (<= 60 s), so a fill that read a KV copy
 * older than a write can be re-published for at most one fresh window; (2) per-request entitlements (backorder,
 * product_3d) ride the route's documented window (Ruling FU46-W1b-6). Cost if wrong: a shopper sees a price or stock
 * figure up to 60 s old on a read-only listing; checkout re-reads both from the database and stays authoritative.
 */
import {
  EDGE_CLASS_HEADER,
  EDGE_FILL_HEADER,
  edgeDepNames,
  type EdgeSnapshot,
} from '../lib/edge-gens';

const META = 'x-ebda-edge-meta';
const STATE = 'x-edge-cache';
const API = '/api/v1/public';

/** Request headers that make a response depend on who asks, or that select a non-default backend. */
const BYPASS_REQUEST_HEADERS = [
  'authorization',
  'cookie',
  'x-store-id',
  'x-ebda-backend',
  'x-builder-preview-token',
  'x-search-query',
  EDGE_FILL_HEADER,
  'range',
];
const PDP = /^\/products\/[A-Za-z0-9._~%-]{1,200}$/;
const MAX_QUERY = 400;

export interface CacheLike {
  match(key: Request | string): Promise<Response | undefined>;
  put(key: Request | string, res: Response): Promise<void>;
}

export interface EdgeDeps {
  cache: CacheLike;
  /** The generations of `names` as one string, or null when unverifiable. */
  readGens(names: string[]): Promise<string | null>;
  now(): number;
}

interface Meta extends EdgeSnapshot {
  at: number;
  fresh: number;
  swr: number;
  never: boolean;
  cc: string;
  vary: string;
}

/** The cache key for this request, or null when it must not touch the layer. */
export function publicEdgeKey(request: Request): string | null {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (!url.pathname.startsWith(API)) return null;
  const path = url.pathname.slice(API.length);
  const ok = path === '/products' || path === '/categories' || path === '/tags' || PDP.test(path);
  if (!ok) return null;
  const h = request.headers;
  for (const name of BYPASS_REQUEST_HEADERS) if (h.has(name)) return null;
  const domain = h.get('x-store-domain')?.trim().toLowerCase();
  if (!domain || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain)) return null;
  const q = new URLSearchParams(url.search);
  q.sort();
  const qs = q.toString();
  if (qs.length > MAX_QUERY) return null;
  // `Vary: Origin` (CORS): the Access-Control-Allow-Origin it stored is per requester.
  const origin = encodeURIComponent((h.get('origin') ?? '-').slice(0, 200));
  return `https://edge.ebda.internal/public/${domain}/${origin}${path}${qs ? `?${qs}` : ''}`;
}

function windows(cc: string): { fresh: number; swr: number } | null {
  if (/\b(private|no-store|no-cache)\b/i.test(cc)) return null;
  const fresh = Number(/s-maxage=(\d+)/i.exec(cc)?.[1] ?? 0);
  const swr = Number(/stale-while-revalidate=(\d+)/i.exec(cc)?.[1] ?? 0);
  return fresh > 0 ? { fresh, swr } : null;
}

function clientCopy(res: Response, state: string, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res);
  out.headers.delete(EDGE_FILL_HEADER);
  out.headers.delete(EDGE_CLASS_HEADER);
  out.headers.delete(META);
  out.headers.set(STATE, state);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return out;
}

type Ctx = { waitUntil(p: Promise<unknown>): void };
type Origin = (request: Request) => Promise<Response>;

function withFill(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set(EDGE_FILL_HEADER, '1');
  return new Request(request, { headers });
}

/** Never trust a client-supplied fill marker on any path: only this layer sets it. */
export function stripFillMarker(request: Request): Request {
  if (!request.headers.has(EDGE_FILL_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(EDGE_FILL_HEADER);
  return new Request(request, { headers });
}

async function fill(
  key: string,
  request: Request,
  ctx: Ctx,
  origin: Origin,
  deps: EdgeDeps
): Promise<Response> {
  const res = await origin(withFill(request));
  const raw = res.headers.get(EDGE_FILL_HEADER);
  const cls = res.headers.get(EDGE_CLASS_HEADER);
  const cc = res.headers.get('cache-control') ?? '';
  const win = windows(cc);
  if (res.status !== 200 || !raw || !cls || !win || res.headers.has('set-cookie')) {
    return clientCopy(res, 'BYPASS');
  }
  let snap: EdgeSnapshot;
  try {
    snap = JSON.parse(raw) as EdgeSnapshot;
  } catch {
    return clientCopy(res, 'BYPASS');
  }
  if (!snap.storeId || !snap.host || typeof snap.gens !== 'string')
    return clientCopy(res, 'BYPASS');
  const meta: Meta = {
    ...snap,
    at: deps.now(),
    fresh: win.fresh,
    swr: win.swr,
    never: cls === 'never',
    cc,
    vary: res.headers.get('vary') ?? '',
  };
  const stored = new Response(res.clone().body, res);
  stored.headers.delete(EDGE_FILL_HEADER);
  stored.headers.delete(EDGE_CLASS_HEADER);
  // The Cache API would otherwise apply `Vary` (x-store-id, x-store-domain, Origin) against a key that carries
  // none of those headers; the tenant and origin are already in the key, so the header is parked in `meta`.
  stored.headers.delete('vary');
  stored.headers.set(META, JSON.stringify(meta));
  stored.headers.set('cache-control', `public, max-age=${win.fresh + win.swr}`);
  ctx.waitUntil(deps.cache.put(key, stored).catch(() => {}));
  return clientCopy(res, 'MISS');
}

/** Serve `request` through the public edge cache; falls through to `origin` when not eligible. */
export async function servePublicEdge(
  request: Request,
  ctx: Ctx,
  origin: Origin,
  deps: EdgeDeps
): Promise<Response> {
  const key = publicEdgeKey(request);
  if (!key) return origin(stripFillMarker(request));

  try {
    const hit = await deps.cache.match(key);
    const raw = hit?.headers.get(META);
    if (hit && raw) {
      const meta = JSON.parse(raw) as Meta;
      const age = (deps.now() - meta.at) / 1000;
      const limit = meta.never ? meta.fresh : meta.fresh + meta.swr;
      if (age >= 0 && age < limit) {
        const gens = await deps.readGens(edgeDepNames(meta.storeId, meta.host));
        if (gens !== null && gens === meta.gens) {
          const stale = age >= meta.fresh;
          if (stale) {
            // The refreshed body is discarded unread: only its cache.put matters (cancel() would wait for the tee).
            ctx.waitUntil(fill(key, request, ctx, origin, deps).catch(() => {}));
          }
          return clientCopy(hit, stale ? 'STALE' : 'HIT', {
            'cache-control': meta.cc,
            age: String(Math.floor(age)),
            ...(meta.vary ? { vary: meta.vary } : {}),
          });
        }
      }
    }
  } catch {
    // cache or generation read unavailable: fail closed, render at the origin
  }
  return fill(key, request, ctx, origin, deps);
}
