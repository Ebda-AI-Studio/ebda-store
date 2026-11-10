/**
 * Ruling DEMO-EDGE-1: the showroom's pages are identical for every cookieless visitor (noindex,
 * checkout refused, no personal data), so the Worker serves them from the Cloudflare edge cache
 * instead of re-rendering. A Worker route runs BEFORE the zone cache, so this uses `caches.default`
 * directly. Hardened after the security review of #128 (cache poisoning, scope bypass, parser
 * differential); every rule below has a negative control in tests/unit/demo-edge-cache.test.ts.
 *
 *  - SCOPE (finding 2): a request is eligible only when BOTH hold: (a) its hostname, taken from
 *    the request URL alone (never Host / X-Forwarded-Host / Forwarded, which make the request
 *    ineligible when present), is EXACTLY `<label>.ebda.app` for a label of the `DEMO_HOSTS` map
 *    (lower-case, no trailing dot, no port, no custom domain); and (b) the API's own store
 *    resolver says that host's store is `isDemo === true` and active (`isDemoStoreHost`, fail
 *    closed on any error or doubt, remembered per isolate for 5 minutes).
 *  - KEY (finding 3): built by us from a strict allowlist, never from the raw URL: canonical host,
 *    a path of `[A-Za-z0-9._~%/-]` (no `//`, no `..`), and ONLY a `look` value that is a BUILT look
 *    of the registry (single occurrence). Any other query key, a malformed or unknown look, a
 *    repeated look, or a fragment-like oddity makes the request ineligible. The synthetic key
 *    request never reaches Cloudflare's own cache key logic.
 *  - PER-VISITOR STATE (finding 1): ANY Cookie header (consent, language, draft, analytics, auth),
 *    Authorization, or a non-HTML/RSC/action/prefetch request is ineligible, so the cached body is
 *    the one a cookieless visitor gets, by construction: the storefront server's only per-visitor
 *    inputs are the cookies (`force-language`, `force-cookie-consent`, `force-preview-draft`; the
 *    headers it reads are host-derived), and none can be present. A visitor who has set the
 *    consent cookie is rendered live, never from this cache. On a `/ar|/en` path the URL decides the
 *    language, so the language cookie is not part of the key there and the one Set-Cookie the render
 *    writes for it is stripped and re-issued per visitor (edge-html-lang.ts); any other `Set-Cookie`,
 *    a non-200 or a non-HTML body is never stored.
 * Real merchant stores and every ineligible request keep the app's `private, no-store`.
 * CACHE CLASS: BOUNDED-stale. Fresh 300 s, then served stale while one request refreshes, up to
 * 86400 s. Residual: a demo catalogue/layout edit shows after <= 300 s. No NEVER-stale data
 * (price, stock, permissions) is decided from a demo page; checkout is refused.
 * BUILD (Ruling EDGE-BUILD-1, NEVER-stale): the HTML names `/_next/static` files that exist only in the Worker version
 * that rendered it, so every entry is stored under that version's id ({@link buildScopedKey}). A deploy is therefore a
 * new, empty key space: no copy of an older build is ever read, stale window or not. No version id = no caching.
 */
import { getLook } from '@ebda/shared';
import { retryableUnavailable } from './resolve-unavailable-edge';
import { DEMO_HOSTS } from './src/lib/demo-hosts';
import { renewNonce } from './csp-nonce-renew';
import { buildScopedKey } from './edge-build-id';
import {
  acceptsHtmlDocument,
  isStorableHtml,
  reissueLangCookie,
  urlLocaleOf,
} from './edge-html-lang';

export const DEMO_EDGE_FRESH_S = 300;
export const DEMO_EDGE_STALE_S = 86400;
/** What the CLIENT is told: never cacheable downstream. The Worker's own cache is internal. */
export const DEMO_EDGE_CACHE_CONTROL = 'private, no-store';
const APEX = 'ebda.app';
/** The API the resolver check asks (the same one the storefront resolves stores against). */
export const DEMO_EDGE_API_URL = 'https://api.ebda.app/api/v1';

const BYPASS_PATH = /^\/(api|_next|checkout)(\/|$)/;
const SAFE_PATH = /^\/[A-Za-z0-9._~%/-]*$/;

/** The canonical demo host of this request URL, or null. Exact match, nothing else. */
export function canonicalDemoHost(url: URL): string | null {
  const host = url.hostname;
  if (url.port !== '' || host !== host.toLowerCase()) return null;
  for (const label of Object.values(DEMO_HOSTS) as string[])
    if (host === `${label}.${APEX}`) return host;
  return null;
}

/**
 * The strict cache key for this request, or null when it must not touch the demo edge cache. This is the request's part
 * only: `serveDemoEdge` stores it under the running Worker version (Ruling EDGE-BUILD-1).
 */
export function demoEdgeKey(request: Request): string | null {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
  const host = canonicalDemoHost(url);
  if (!host) return null;
  const h = request.headers;
  // Spoof / per-visitor inputs: any of these makes the request ineligible.
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
  if (!acceptsHtmlDocument(h.get('accept'))) return null;
  // The ONLY cookie a cacheable request may carry is the storefront's own language cookie, exactly
  // `force-language=ar|en` and nothing else in the header: the app writes it on every first load, so
  // refusing it would exclude every visitor after their first page. It selects one of two HTML
  // variants and is part of the key; consent, draft, auth, analytics or any second cookie bypass.
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
  let look = '';
  const keys = [...url.searchParams.keys()];
  if (keys.length > 1 || keys.some(k => k !== 'look')) return null;
  if (keys.length === 1) {
    const all = url.searchParams.getAll('look');
    if (all.length !== 1 || getLook(all[0])?.status !== 'built') return null;
    look = all[0];
  }
  // On a `/ar|/en` path the URL decides the language; the cookie is not part of the page (edge-html-lang.ts).
  if (urlLocaleOf(path)) lang = '';
  const q = [look && `look=${look}`, lang && `__lang=${lang}`].filter(Boolean).join('&');
  return `https://${host}${path}${q ? `?${q}` : ''}`;
}

const demoVerdict = new Map<string, { demo: boolean; until: number; at: number }>();
/** Ruling RESOLVE-BULLETPROOF-1: a transient error keeps the last verdict only this long after the last real answer. */
export const DEMO_VERDICT_STALE_MAX_MS = 10 * 60_000;

/**
 * True only when the API's store resolver says `host` is an ACTIVE `isDemo` store. Fails closed.
 * The verdict (either way) is remembered for 5 minutes in this isolate.
 */
export async function isDemoStoreHost(
  host: string,
  apiUrl: string,
  fetcher: typeof fetch = fetch,
  now = Date.now()
): Promise<boolean> {
  const known = demoVerdict.get(host);
  if (known && known.until > now) return known.demo;
  let demo = false;
  try {
    const res = await fetcher(`${apiUrl}/public/store/resolve`, {
      headers: { 'x-store-domain': host },
    });
    // Ruling RESOLVE-BULLETPROOF-1: a 429/5xx is "could not ask", not "not a demo": keep the last verdict.
    if (known && !res.ok && res.status !== 404 && now - known.at < DEMO_VERDICT_STALE_MAX_MS) {
      demoVerdict.set(host, { demo: known.demo, until: now + 60_000, at: known.at });
      return known.demo;
    }
    if (!res.ok && res.status !== 404) {
      demoVerdict.set(host, { demo: false, until: now + 60_000, at: known?.at ?? 0 });
      return false;
    }
    if (res.ok) {
      const store = (
        (await res.json()) as { data?: { store?: { isDemo?: unknown; status?: unknown } } }
      )?.data?.store;
      demo = store?.isDemo === true && store?.status === 'active';
    }
  } catch {
    if (known && now - known.at < DEMO_VERDICT_STALE_MAX_MS) {
      demoVerdict.set(host, { demo: known.demo, until: now + 60_000, at: known.at });
      return known.demo;
    }
    demoVerdict.set(host, { demo: false, until: now + 60_000, at: known?.at ?? 0 });
    return false;
  }
  demoVerdict.set(host, { demo, until: now + 300_000, at: now });
  return demo;
}

/** Test seam. */
export function resetDemoVerdicts(): void {
  demoVerdict.clear();
}

/**
 * Only a clean 200 HTML document is worth keeping; a Set-Cookie refuses it, except the URL-locale language cookie of a
 * `/ar|/en` page (stripped from the copy, re-issued per visitor: edge-html-lang.ts).
 */
export function isStorable(res: Response, path = '/'): boolean {
  return isStorableHtml(res, urlLocaleOf(path));
}

/** Age in seconds of a stored copy; Infinity when unstamped. */
export function ageSeconds(stored: Response, now = Date.now()): number {
  const at = Number(stored.headers.get('x-edge-cached-at'));
  return Number.isFinite(at) && at > 0 ? (now - at) / 1000 : Infinity;
}

function withEdgeHeaders(
  res: Response,
  state: 'HIT' | 'MISS' | 'STALE',
  request: Request
): Response {
  // A stored page is served to many visitors: each response gets its own CSP nonce (Ruling CSP-WEB-1).
  const out =
    state === 'MISS' ? new Response(res.body, res) : renewNonce(new Response(res.body, res));
  // The Worker caches internally; clients (and office/ISP proxies) must not keep copies.
  out.headers.set('Cache-Control', 'private, no-store');
  out.headers.set('x-demo-edge', state);
  out.headers.set('x-demo-cache', state.toLowerCase());
  out.headers.delete('vary');
  if (state !== 'MISS') reissueLangCookie(out, request, urlLocaleOf(new URL(request.url).pathname));
  return out;
}

type EdgeCtx = { waitUntil(p: Promise<unknown>): void };
type Origin = (request: Request) => Promise<Response>;

/**
 * Serve `request` through the demo edge cache; falls through to `origin` when not eligible. `build` is the Worker
 * version id (`edgeBuildId(env)`); null means this isolate cannot tell which build it is, so nothing is cached.
 */
export async function serveDemoEdge(
  request: Request,
  ctx: EdgeCtx,
  render: Origin,
  isDemoHost: (host: string) => Promise<boolean>,
  build: string | null,
  cache: Pick<Cache, 'match' | 'put'> = (caches as unknown as { default: Cache }).default
): Promise<Response> {
  // Ruling RESOLVE-BULLETPROOF-1: a store-unresolvable render leaves as 503 + Retry-After, never 500 (and never stored).
  const origin = (r: Request) => render(r).then(retryableUnavailable);
  const requestKey = build ? demoEdgeKey(request) : null;
  if (!requestKey || !build) return origin(request);
  const key = buildScopedKey(requestKey, build);
  const path = new URL(request.url).pathname;

  const store = async (res: Response) => {
    const copy = new Response(res.body, res);
    copy.headers.delete('set-cookie');
    copy.headers.set('Cache-Control', `public, max-age=${DEMO_EDGE_STALE_S}`);
    copy.headers.set('x-edge-cached-at', String(Date.now()));
    copy.headers.delete('vary');
    await cache.put(key, copy);
  };

  try {
    const hit = await cache.match(key);
    if (hit) {
      const age = ageSeconds(hit);
      if (age < DEMO_EDGE_FRESH_S) return withEdgeHeaders(hit, 'HIT', request);
      if (age < DEMO_EDGE_STALE_S) {
        ctx.waitUntil(
          origin(new Request(request))
            .then(r => (isStorable(r, path) ? store(r) : undefined))
            .catch(() => {})
        );
        return withEdgeHeaders(hit, 'STALE', request);
      }
    }
  } catch {
    // cache unavailable: render normally
  }

  // MISS: the resolver verdict runs IN PARALLEL with the render (a stored entry only ever exists
  // for a host that passed it, so a HIT/STALE above needs no second check) and gates the store.
  const verdict = isDemoHost(new URL(key).hostname).catch(() => false);
  const res = await origin(request);
  if (!isStorable(res, path) || !(await verdict)) return res;
  ctx.waitUntil(store(res.clone()).catch(() => {}));
  return withEdgeHeaders(res, 'MISS', request);
}
