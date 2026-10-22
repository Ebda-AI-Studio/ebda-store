/**
 * Ruling DEMO-EDGE-1: the showroom's pages are identical for every visitor (noindex, checkout
 * refused, no personal data), so the Worker serves them from the Cloudflare edge cache instead of
 * re-rendering. A Worker route runs BEFORE the zone cache, so this uses `caches.default` directly.
 *
 * Scope, all of it enforced here and pinned by tests/unit/demo-edge-cache.test.ts:
 *  - DEMO hosts only (the `DEMO_HOSTS` map: storedemo, storedemo-souq, storedemo-jasmine). Every
 *    other host, real merchant stores included, keeps the `private, no-store` the app sets.
 *  - GET of a plain HTML document: never an RSC/prefetch/action request, never `/api`, `/_next`,
 *    `/checkout`, never a builder/preview/draft URL (`_`-prefixed query keys) or draft cookie.
 *  - A request carrying an auth-looking cookie bypasses the cache. The three cookies the storefront
 *    server actually reads are `force-language`, `force-cookie-consent` (both change the HTML, so
 *    both are part of the key) and `force-preview-draft` (bypass); every other cookie is ignored by
 *    the render, so analytics cookies do not fragment the cache.
 *  - `?look=` is part of the key (the query is sorted into it).
 * CACHE CLASS: BOUNDED-stale. Fresh 300 s, then served stale while one request refreshes, for up
 * to 86400 s. Residual window: a demo-store catalogue/layout edit shows after <= 300 s (the
 * stale-while-revalidate hit that follows renders fresh). Nothing here is ever NEVER-stale data
 * (no price/inventory/permissions decisions are taken from a demo page; checkout is refused).
 */
import { DEMO_HOSTS } from './src/lib/demo-hosts';

export const DEMO_EDGE_FRESH_S = 300;
export const DEMO_EDGE_STALE_S = 86400;
export const DEMO_EDGE_CACHE_CONTROL = `public, s-maxage=${DEMO_EDGE_FRESH_S}, stale-while-revalidate=${DEMO_EDGE_STALE_S}`;

const BYPASS_PATH = /^\/(api|_next|checkout)(\/|$)/;
const AUTH_COOKIE = /(^|[-_.])(token|session|sid|auth|jwt|csrf)/i;

function cookieMap(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

const token = (v: string | undefined) => (v ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 16);

/** The cache key for this request, or null when it must not touch the demo edge cache. */
export function demoEdgeKey(request: Request): string | null {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  const [label, ...rest] = url.hostname.split('.');
  if (rest.length === 0 || !(Object.values(DEMO_HOSTS) as string[]).includes(label)) return null;
  if (BYPASS_PATH.test(url.pathname)) return null;
  const h = request.headers;
  if (
    h.has('rsc') ||
    h.has('next-action') ||
    h.has('next-router-prefetch') ||
    h.has('authorization')
  )
    return null;
  if (!(h.get('accept') ?? '').includes('text/html')) return null;
  for (const k of url.searchParams.keys()) if (k.startsWith('_')) return null;
  const cookies = cookieMap(h.get('cookie'));
  if (cookies.has('force-preview-draft')) return null;
  for (const name of cookies.keys()) if (AUTH_COOKIE.test(name)) return null;
  const q = [...url.searchParams.entries()]
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const lang = token(cookies.get('force-language'));
  const consent = token(cookies.get('force-cookie-consent'));
  return `https://${url.host}${url.pathname}?${q}${q ? '&' : ''}__ek=${lang}.${consent}`;
}

/** Only a clean 200 HTML document without cookies is worth keeping. */
export function isStorable(res: Response): boolean {
  return (
    res.status === 200 &&
    (res.headers.get('content-type') ?? '').includes('text/html') &&
    !res.headers.has('set-cookie')
  );
}

/** Age in seconds of a stored copy; Infinity when unstamped. */
export function ageSeconds(stored: Response, now = Date.now()): number {
  const at = Number(stored.headers.get('x-edge-cached-at'));
  return Number.isFinite(at) && at > 0 ? (now - at) / 1000 : Infinity;
}

function withEdgeHeaders(res: Response, state: 'HIT' | 'MISS' | 'STALE'): Response {
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', DEMO_EDGE_CACHE_CONTROL);
  out.headers.set('x-demo-edge', state);
  out.headers.delete('vary');
  return out;
}

type EdgeCtx = { waitUntil(p: Promise<unknown>): void };
type Origin = (request: Request) => Promise<Response>;

/** Serve `request` through the demo edge cache; falls through to `origin` when not eligible. */
export async function serveDemoEdge(
  request: Request,
  ctx: EdgeCtx,
  origin: Origin,
  cache: Pick<Cache, 'match' | 'put'> = (caches as unknown as { default: Cache }).default
): Promise<Response> {
  const key = demoEdgeKey(request);
  if (!key) return origin(request);

  const store = async (res: Response) => {
    const copy = new Response(res.body, res);
    copy.headers.set('Cache-Control', `public, max-age=${DEMO_EDGE_STALE_S}`);
    copy.headers.set('x-edge-cached-at', String(Date.now()));
    copy.headers.delete('vary');
    await cache.put(key, copy);
  };

  try {
    const hit = await cache.match(key);
    if (hit) {
      const age = ageSeconds(hit);
      if (age < DEMO_EDGE_FRESH_S) return withEdgeHeaders(hit, 'HIT');
      if (age < DEMO_EDGE_STALE_S) {
        ctx.waitUntil(
          origin(new Request(request))
            .then(r => (isStorable(r) ? store(r) : undefined))
            .catch(() => {})
        );
        return withEdgeHeaders(hit, 'STALE');
      }
    }
  } catch {
    // cache unavailable: render normally
  }

  const res = await origin(request);
  if (!isStorable(res)) return res;
  ctx.waitUntil(store(res.clone()).catch(() => {}));
  return withEdgeHeaders(res, 'MISS');
}
