import { renewNonce } from './csp-nonce-renew';
/**
 * Ruling STORE-EDGE-1 (SEO-2 / P14): real merchant storefront HTML from the Cloudflare edge, purged per store on every write.
 *
 * WHY: storefront HTML was `private, no-store` with a 0.8-1.0 s warm and 2-11 s cold render, so Googlebot and first
 * visitors always met the slow path. The demo showroom already has this (Ruling DEMO-EDGE-1, demo-edge-cache.ts); this is
 * the same Workers Cache API layer for REAL stores, behind two switches that both default to OFF:
 *   STOREFRONT_HTML_EDGE_HOSTS  comma list of exact store hosts (`shop.ebda.app,www-less custom domains`). Empty = nobody.
 *   the store must also pass the API resolver (active, not a draft/inactive store), fail closed on doubt.
 * Nothing changes for a store until Ahmad lists its host.
 *
 * WHAT IS CACHED: an anonymous GET of an HTML page with NO query string, from a visitor carrying no cookie at all (or exactly
 * `force-language=ar|en`, which is part of the key). Any other cookie (consent, auth, draft, analytics), Authorization,
 * RSC/prefetch/action headers, a spoofed host header or a non-HTML request bypasses. A response with Set-Cookie or a
 * non-200 is never stored. The client is always told `private, no-store`: the copy lives only in this Worker.
 *
 * PURGE (NEVER-stale: price, stock, status, theme, layout): the API already calls POST /api/revalidate with the storefront
 * tags on every store write (revalidateStorefront: products/categories/bundles/layout/pwa:<storeId>, store-domain/slug:<host>).
 * This Worker sees that call first, and after the Next handler accepts it writes a per-store EPOCH to R2 (strongly
 * consistent, global, already bound as NEXT_INC_CACHE_R2_BUCKET). A stored page is served only if no epoch for its host, its
 * store id or the global `all` key is newer than the moment its render STARTED, so a write that lands mid-render can only
 * make the copy invalid. An unreadable epoch or an unmapped tag fails closed (bypass / invalidate everything). Cache API
 * `delete` would clear one data centre only; the epoch reaches all of them.
 *
 * CACHE CLASS: price/stock/status/theme/layout = NEVER-stale, event-invalidated as above; the TTL (fresh 60 s, then served
 * stale for up to 600 s while one request refreshes) is only an outer bound and applies the same epoch check to the stale
 * copy. Residuals (documented, cost if wrong: a shopper sees an old catalogue for the length of one window): (1) the order
 * path coalesces its purge to one per 10 s per store (public-cache.ts ORDER_PURGE_COALESCE_MS, display only, checkout
 * re-reads stock); (2) a purge the API could not deliver (secret missing, Worker down) leaves the copy until the TTL, the same
 * floor the Next data cache already has.
 */
export const STORE_EDGE_FRESH_S = 60;
export const STORE_EDGE_STALE_S = 600;
const META = 'x-store-edge-meta';
const APEX_SLUG_SUFFIX = '.ebda.app';

const BYPASS_PATH = /^\/(api|_next|checkout|cart|account|admin|auth|login|orders)(\/|$)/;
const SAFE_PATH = /^\/[A-Za-z0-9._~%/-]*$/;

export interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
}
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}
export interface StoreVerdict {
  ok: boolean;
  /** The store id from the resolver (epoch key). */
  id?: string;
}
export interface StoreEdgeDeps {
  allow: Set<string>;
  r2: R2Like | undefined;
  cache: CacheLike;
  verdict(host: string): Promise<StoreVerdict>;
  now(): number;
}
type Ctx = { waitUntil(p: Promise<unknown>): void };
type Origin = (request: Request) => Promise<Response>;

interface Meta {
  at: number;
  host: string;
  id: string;
}

/** Parse the allowlist: exact lower-case hosts only, no wildcards. */
export function parseAllowlist(raw: unknown): Set<string> {
  if (typeof raw !== 'string') return new Set();
  return new Set(
    raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s))
  );
}

/** The strict cache key for this request, or null when it must not touch the layer. */
export function storeEdgeKey(request: Request, allow: Set<string>): string | null {
  if (allow.size === 0 || request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port !== '')
    return null;
  const host = url.hostname;
  if (host !== host.toLowerCase() || host.endsWith('.') || !allow.has(host)) return null;
  if (url.search !== '') return null; // filters, paging, preview and tracking params all bypass
  const h = request.headers;
  for (const name of [
    'authorization',
    'x-forwarded-host',
    'forwarded',
    'x-original-host',
    'x-store-domain',
    'rsc',
    'next-action',
    'next-router-prefetch',
    'next-router-state-tree',
  ])
    if (h.has(name)) return null;
  if (!(h.get('accept') ?? '').includes('text/html')) return null;
  let lang = '';
  const cookie = h.get('cookie');
  if (cookie !== null) {
    const m = /^force-language=(ar|en)$/.exec(cookie.trim());
    if (!m) return null;
    lang = m[1];
  }
  const path = url.pathname;
  if (
    !SAFE_PATH.test(path) ||
    path.length > 200 ||
    path.includes('//') ||
    path.includes('..') ||
    BYPASS_PATH.test(path)
  )
    return null;
  return `https://${host}${path}${lang ? `?__lang=${lang}` : ''}`;
}

/** The epoch keys a storefront purge tag invalidates. Unmapped tags invalidate everything (`all`). */
export function epochKeysForTag(tag: string): string[] {
  const m = /^([a-z-]+):(.+)$/.exec(tag);
  if (!m) return ['all'];
  const [, kind, value] = m;
  if (
    ['products', 'categories', 'bundles', 'layout', 'pwa'].includes(kind) &&
    /^[\w-]{8,64}$/.test(value)
  )
    return [`id/${value}`];
  const label = value.toLowerCase().replace(/^www\./, '');
  if (kind === 'store-domain' && /^[a-z0-9.-]{1,253}$/.test(label)) return [`host/${label}`];
  if (kind === 'store-slug' && /^[a-z0-9-]{1,63}$/.test(label))
    return [`host/${label}${APEX_SLUG_SUFFIX}`];
  return ['all'];
}

const epochObject = (key: string) => `html-epoch/${key}`;

/** Record a purge: after this, no page rendered before `now` is served for these tags' stores. */
export async function bumpEpochs(r2: R2Like, tags: string[], now: number): Promise<void> {
  const keys = new Set(tags.flatMap(epochKeysForTag));
  await Promise.all([...keys].map(k => r2.put(epochObject(k), String(now))));
}

/** True when no purge newer than `meta.at` exists for this entry. Any read error or junk value = false. */
export async function isEntryCurrent(r2: R2Like, meta: Meta): Promise<boolean> {
  try {
    const keys = ['all', `host/${meta.host}`, `id/${meta.id}`];
    const stamps = await Promise.all(
      keys.map(async k => {
        const o = await r2.get(epochObject(k));
        return o ? Number(await o.text()) : 0;
      })
    );
    // 1 s of margin for clock skew between the Worker that rendered and the one that purged.
    return stamps.every(s => Number.isFinite(s) && s < meta.at - 1000);
  } catch {
    return false;
  }
}

/** Only a clean 200 HTML document without cookies is worth keeping. */
function isStorable(res: Response): boolean {
  return (
    res.status === 200 &&
    (res.headers.get('content-type') ?? '').includes('text/html') &&
    !res.headers.has('set-cookie')
  );
}

function clientCopy(res: Response, state: string): Response {
  // A stored page is served to many visitors: each response gets its own CSP nonce (Ruling CSP-WEB-1).
  const out =
    state === 'MISS' ? new Response(res.body, res) : renewNonce(new Response(res.body, res));
  out.headers.set('Cache-Control', 'private, no-store');
  out.headers.set('x-store-edge', state);
  out.headers.delete('vary');
  out.headers.delete(META);
  return out;
}

async function fill(
  key: string,
  request: Request,
  ctx: Ctx,
  origin: Origin,
  deps: StoreEdgeDeps
): Promise<Response> {
  const host = new URL(key).hostname;
  const startedAt = deps.now();
  // The resolver verdict runs in parallel with the render and gates the store.
  const verdict = deps.verdict(host).catch((): StoreVerdict => ({ ok: false }));
  const res = await origin(request);
  const v = await verdict;
  if (!isStorable(res) || !v.ok || !v.id) return res;
  const stored = new Response(res.clone().body, res);
  stored.headers.set(META, JSON.stringify({ at: startedAt, host, id: v.id } satisfies Meta));
  stored.headers.set('Cache-Control', `public, max-age=${STORE_EDGE_STALE_S}`);
  stored.headers.delete('vary');
  ctx.waitUntil(deps.cache.put(key, stored).catch(() => {}));
  return clientCopy(res, 'MISS');
}

/** Serve `request` through the store HTML edge cache; falls through to `origin` when not eligible. */
export async function serveStoreEdge(
  request: Request,
  ctx: Ctx,
  origin: Origin,
  deps: StoreEdgeDeps
): Promise<Response> {
  const key = storeEdgeKey(request, deps.allow);
  if (!key || !deps.r2) return origin(request);
  try {
    const hit = await deps.cache.match(key);
    const raw = hit?.headers.get(META);
    if (hit && raw) {
      const meta = JSON.parse(raw) as Meta;
      const age = (deps.now() - meta.at) / 1000;
      if (age >= 0 && age < STORE_EDGE_STALE_S && (await isEntryCurrent(deps.r2, meta))) {
        if (age >= STORE_EDGE_FRESH_S) {
          ctx.waitUntil(fill(key, request, ctx, origin, deps).catch(() => {}));
          return clientCopy(hit, 'STALE');
        }
        return clientCopy(hit, 'HIT');
      }
    }
  } catch {
    // cache or epoch store unavailable: render normally
  }
  return fill(key, request, ctx, origin, deps);
}

const verdicts = new Map<string, { v: StoreVerdict; until: number }>();

/** The API resolver's verdict for a store host: active store + its id. Fails closed; remembered 60 s per isolate. */
export async function storeVerdict(
  host: string,
  apiUrl: string,
  fetcher: typeof fetch = fetch,
  now = Date.now()
): Promise<StoreVerdict> {
  const known = verdicts.get(host);
  if (known && known.until > now) return known.v;
  let v: StoreVerdict = { ok: false };
  try {
    const res = await fetcher(`${apiUrl}/public/store/resolve`, {
      headers: { 'x-store-domain': host },
    });
    if (res.ok) {
      const store = (
        (await res.json()) as {
          data?: { store?: { id?: unknown; status?: unknown; isDemo?: unknown } };
        }
      )?.data?.store;
      if (store?.status === 'active' && typeof store.id === 'string' && store.id)
        v = { ok: true, id: store.id };
    }
  } catch {
    v = { ok: false };
  }
  verdicts.set(host, { v, until: now + 60_000 });
  return v;
}

/** Test seam. */
export function resetStoreVerdicts(): void {
  verdicts.clear();
}
