import { resolveDefaultLanguage } from '@ebda/shared';
import { renewNonce } from './csp-nonce-renew';
import { buildScopedKey } from './edge-build-id';
import {
  acceptsHtmlDocument,
  isStorableHtml,
  reissueLangCookie,
  urlLocaleOf,
  type UrlLocale,
} from './edge-html-lang';

export { urlLocaleOf };
/**
 * Ruling STORE-EDGE-1 (SEO-2 / P14): real merchant storefront HTML from the Cloudflare edge, purged per store on every write.
 *
 * WHY: storefront HTML was `private, no-store` with a 0.8-1.0 s warm and 2-11 s cold render, so Googlebot and first
 * visitors always met the slow path. The demo showroom already has this (Ruling DEMO-EDGE-1, demo-edge-cache.ts); this is
 * the same Workers Cache API layer for REAL stores. Two gates, both must hold:
 *   STOREFRONT_HTML_EDGE_HOSTS  `all` (every store host, the launch default since S2-REVIVE / Ruling STORE-EDGE-2) or a
 *                               comma list of exact store hosts. Empty = nobody.
 *   the store must also pass the API resolver (active, not a draft/inactive store), fail closed on doubt.
 * One-step off switch: the Worker secret `STOREFRONT_HTML_EDGE_OFF=1` (read in sentry-worker-entry.ts; a `wrangler secret
 * put` is a new version at once, no build). Purge epochs keep being recorded while it is off, so switching back on never
 * serves a page rendered before a purge that happened in between.
 *
 * WHAT IS CACHED: an anonymous GET of an HTML page from a visitor carrying no cookie at all (or exactly
 * `force-language=ar|en`). Any other cookie (consent, auth, draft, analytics), Authorization, RSC/prefetch/action headers,
 * a spoofed host header, a non-HTML request or a personalised path (cart, checkout, account, auth, wishlist, search,
 * compare, review, unsubscribe, affiliate, ...; with or without a `/ar|/en` prefix) bypasses. A non-200 is never stored.
 * The client is always told `private, no-store`: the copy lives only in this Worker.
 *   LANGUAGE (LOCALE-PATHS-1): on a `/ar|/en` path the URL decides the language (the cookie is ignored by the render), so
 *   the key has no language part and the only Set-Cookie the render may carry is the matching `force-language=<url
 *   locale>`, which is stripped from the stored copy and re-issued to each visitor whose cookie differs. Without this a
 *   first visitor (no cookie yet = always a Set-Cookie) was never cached: measured on storedemo.ebda.app/ar 2026-11-09,
 *   2.95 s TTFB cookie-less vs a HIT with the cookie. On an unprefixed path the cookie language is part of the key and any
 *   Set-Cookie still refuses storage.
 *   QUERY: none, except click-tracking parameters (utm_*, fbclid, gclid, ttclid, ...) on a `/ar|/en` path, which are
 *   dropped from the key AND from the request the page is rendered from, so one visitor's click id never lands in a copy
 *   served to another (the browser keeps its own URL; the Next client router reads `window.location`). Any other
 *   parameter (filters, paging, preview, look) bypasses.
 *   COALESCING: concurrent misses for the same key in one isolate share one render (a viral spike after a purge).
 *
 * PURGE (NEVER-stale: price, stock, status, theme, layout): the API already calls POST /api/revalidate with the storefront
 * tags on every store write (revalidateStorefront: products/categories/bundles/layout/pwa:<storeId>, store-domain/slug:<host>).
 * This Worker sees that call first, and after the Next handler accepts it writes a per-store EPOCH to R2 (strongly
 * consistent, global, already bound as NEXT_INC_CACHE_R2_BUCKET). A stored page is served only if no epoch for its host, its
 * store id or the global `all` key is newer than the moment its render STARTED, so a write that lands mid-render can only
 * make the copy invalid. An unreadable epoch or an unmapped tag fails closed (bypass / invalidate everything). Cache API
 * `delete` would clear one data centre only; the epoch reaches all of them.
 *
 * CACHE CLASS: price/stock/gold-rate price/status/theme/layout = NEVER-stale, event-invalidated as above; categories, blog
 * and static pages = BOUNDED-stale under the same purge (category writes purge `categories:<id>` since S2-REVIVE). The TTL
 * (fresh 60 s, then served stale for up to 600 s while one request refreshes) is only an outer bound and applies the same
 * epoch check to the stale copy. Residuals (Ruling STORE-EDGE-2, cost if wrong: a shopper sees an old listing price or
 * stock figure for that long; checkout re-reads both from the store and stays authoritative): (1) the order path coalesces
 * its purge to one per 10 s per store (public-cache.ts ORDER_PURGE_COALESCE_MS); (2) a purge the API could not deliver
 * (secret missing, Worker down) leaves the copy until the TTL, the same floor the Next data cache already has; (3) each
 * isolate remembers an epoch it read for {@link EPOCH_MEMO_MS} (2 s, the NZ-D3 window), so another isolate may serve a
 * pre-purge copy for up to 2 s (the isolate that took the purge forgets at once); (4) a render that starts right after a
 * purge reads the API, whose KV L1 is eventually consistent (<= 60 s, Ruling NZ-D1/EDGE-API-1 residual), so it can store a
 * copy that is one KV window old until the next purge or the TTL.
 *
 * BUILD (Ruling EDGE-BUILD-1, NEVER-stale): the HTML names `/_next/static` files that exist only in the Worker version
 * that rendered it, and a deploy is not a store write, so no epoch moves. Every entry is therefore stored under that
 * version's id ({@link buildScopedKey}; `deps.build`): a new version starts from an empty key space and never reads a
 * copy an older build rendered. No version id = the layer does not cache.
 */
export const STORE_EDGE_FRESH_S = 60;
export const STORE_EDGE_STALE_S = 600;
const META = 'x-store-edge-meta';
const APEX_SLUG_SUFFIX = '.ebda.app';

/** Personalised or non-page roots (checked after any `/ar|/en` prefix is removed). */
const BYPASS_PATH =
  /^\/(api|_next|checkout|cart|account|admin|auth|login|orders|wishlist|search|compare|review|unsubscribe|sms-unsubscribe|affiliate|q|landing-preview|og|feeds|llms\.txt)(\/|$)/;
/** Click-tracking parameters that never change the page (dropped on a `/ar|/en` path, see QUERY above). */
const TRACKING_PARAM =
  /^(utm_[a-z_]{1,20}|fbclid|gclid|gbraid|wbraid|dclid|msclkid|ttclid|twclid|igshid|srsltid|yclid|mc_cid|mc_eid|_gl|li_fat_id)$/;
/** `STOREFRONT_HTML_EDGE_HOSTS=all`: every host the store resolver vouches for. */
const ALL_HOSTS = '*';
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
  /** `settings.defaultLanguage` resolved (unset = the region default), for the edge locale redirect. */
  defaultLanguage?: 'ar' | 'en';
}
export interface StoreEdgeDeps {
  allow: Set<string>;
  r2: R2Like | undefined;
  cache: CacheLike;
  /** The Worker version id (`edgeBuildId(env)`), part of every key; null = this layer does not cache (EDGE-BUILD-1). */
  build: string | null;
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

/** Parse the allowlist: the single word `all`, or exact lower-case hosts only (no wildcards). */
export function parseAllowlist(raw: unknown): Set<string> {
  if (typeof raw !== 'string') return new Set();
  if (raw.trim().toLowerCase() === 'all') return new Set([ALL_HOSTS]);
  return new Set(
    raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s))
  );
}

/** The Worker's switches: the secret `STOREFRONT_HTML_EDGE_OFF=1` wins over the host list (Ruling STORE-EDGE-2). */
export function edgeAllowlistFromEnv(env: {
  STOREFRONT_HTML_EDGE_HOSTS?: unknown;
  STOREFRONT_HTML_EDGE_OFF?: unknown;
}): Set<string> {
  if (env.STOREFRONT_HTML_EDGE_OFF === '1') return new Set();
  return parseAllowlist(env.STOREFRONT_HTML_EDGE_HOSTS);
}

/**
 * The strict cache key for this request, or null when it must not touch the layer. This is the request's part only:
 * `serveStoreEdge` stores it under the running Worker version (Ruling EDGE-BUILD-1).
 */
export function storeEdgeKey(request: Request, allow: Set<string>): string | null {
  if (allow.size === 0 || request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port !== '')
    return null;
  const host = url.hostname;
  if (host !== host.toLowerCase() || host.endsWith('.')) return null;
  if (!allow.has(ALL_HOSTS) && !allow.has(host)) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.')) return null;
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
  if (!acceptsHtmlDocument(h.get('accept'))) return null;
  const path = url.pathname;
  const urlLocale = urlLocaleOf(path);
  if (url.search !== '') {
    // Filters, paging, preview and look params bypass; click-tracking params only on a `/ar|/en` path.
    if (!urlLocale || url.search.length > 600) return null;
    for (const k of url.searchParams.keys()) if (!TRACKING_PARAM.test(k)) return null;
  }
  let lang = '';
  const cookie = h.get('cookie');
  if (cookie !== null) {
    const m = /^force-language=(ar|en)$/.exec(cookie.trim());
    if (!m) return null;
    lang = m[1];
  }
  const rest = urlLocale ? path.slice(urlLocale.length + 1) || '/' : path;
  if (
    !SAFE_PATH.test(path) ||
    path.length > 200 ||
    path.includes('//') ||
    path.includes('..') ||
    BYPASS_PATH.test(rest)
  )
    return null;
  // On a `/ar|/en` path the URL decides the language and the cookie is not part of the page (LOCALE-PATHS-1).
  // `__edge=store` keeps this layer's entries apart from the demo layer's in the SAME `caches.default` (Ruling STORE-EDGE-3):
  // the two used to write the same key for a demo host, each read the other's copy as a miss and overwrote it, so the
  // demo layer never hit and this one hit only every other time (measured on storedemo-souq.ebda.app/ar, 2026-11-09).
  return `https://${host}${path}?__edge=store${lang && !urlLocale ? `&__lang=${lang}` : ''}`;
}

/** The request the page is rendered from: the visitor's, minus click-tracking parameters. */
function renderRequest(request: Request): Request {
  const url = new URL(request.url);
  if (url.search === '') return request;
  url.search = '';
  return new Request(url.toString(), request);
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

/** How long an isolate trusts an epoch it read (residual 3 in the header; the NZ-D3 window). */
export const EPOCH_MEMO_MS = 2_000;
const epochMemo = new Map<string, { v: number; until: number }>();

/** Record a purge: after this, no page rendered before `now` is served for these tags' stores. */
export async function bumpEpochs(r2: R2Like, tags: string[], now: number): Promise<void> {
  const keys = new Set(tags.flatMap(epochKeysForTag));
  // This isolate forgets before and after, so it never serves its own pre-purge copy.
  epochMemo.clear();
  try {
    await Promise.all([...keys].map(k => r2.put(epochObject(k), String(now))));
  } finally {
    epochMemo.clear();
  }
}

async function readEpoch(r2: R2Like, key: string, now: number): Promise<number> {
  const known = epochMemo.get(key);
  if (known && known.until > now) return known.v;
  const o = await r2.get(epochObject(key));
  const v = o ? Number(await o.text()) : 0;
  if (Number.isFinite(v)) {
    if (epochMemo.size > 5_000) epochMemo.clear();
    epochMemo.set(key, { v, until: now + EPOCH_MEMO_MS });
  }
  return v;
}

/** True when no purge newer than `meta.at` exists for this entry. Any read error or junk value = false. */
export async function isEntryCurrent(r2: R2Like, meta: Meta, now = Date.now()): Promise<boolean> {
  try {
    const keys = ['all', `host/${meta.host}`, `id/${meta.id}`];
    const stamps = await Promise.all(keys.map(k => readEpoch(r2, k, now)));
    // 1 s of margin for clock skew between the Worker that rendered and the one that purged.
    return stamps.every(s => Number.isFinite(s) && s < meta.at - 1000);
  } catch {
    return false;
  }
}

/** Test seam. */
export function resetEpochMemo(): void {
  epochMemo.clear();
}

function clientCopy(
  res: Response,
  state: string,
  request: Request,
  urlLocale: UrlLocale
): Response {
  // A stored page is served to many visitors: each response gets its own CSP nonce (Ruling CSP-WEB-1).
  const out =
    state === 'MISS' ? new Response(res.body, res) : renewNonce(new Response(res.body, res));
  out.headers.set('Cache-Control', 'private, no-store');
  out.headers.set('x-store-edge', state);
  out.headers.delete('vary');
  out.headers.delete(META);
  // A shared copy never carries a cookie; the URL's language is re-issued to a visitor whose cookie differs.
  if (state !== 'MISS') reissueLangCookie(out, request, urlLocale);
  return out;
}

/** Per-isolate single flight: the stored template a running fill will produce (null = not storable). */
const inFlight = new Map<string, Promise<Response | null>>();

async function fill(
  key: string,
  request: Request,
  ctx: Ctx,
  origin: Origin,
  deps: StoreEdgeDeps,
  urlLocale: UrlLocale
): Promise<Response> {
  const running = inFlight.get(key);
  if (running) {
    const template = await running.catch(() => null);
    if (template) return clientCopy(template.clone(), 'COALESCED', request, urlLocale);
    return origin(request);
  }
  let settle: (t: Response | null) => void = () => {};
  inFlight.set(
    key,
    new Promise<Response | null>(r => {
      settle = r;
    })
  );
  try {
    const host = new URL(key).hostname;
    const startedAt = deps.now();
    // The resolver verdict runs in parallel with the render and gates the store.
    const verdict = deps.verdict(host).catch((): StoreVerdict => ({ ok: false }));
    const res = await origin(renderRequest(request));
    const v = await verdict;
    if (!isStorableHtml(res, urlLocale) || !v.ok || !v.id) {
      settle(null);
      return res;
    }
    const stored = new Response(res.clone().body, res);
    stored.headers.delete('set-cookie');
    stored.headers.set(META, JSON.stringify({ at: startedAt, host, id: v.id } satisfies Meta));
    stored.headers.set('Cache-Control', `public, max-age=${STORE_EDGE_STALE_S}`);
    stored.headers.delete('vary');
    const template = stored.clone();
    settle(template);
    ctx.waitUntil(deps.cache.put(key, stored).catch(() => {}));
    return clientCopy(res, 'MISS', request, urlLocale);
  } catch (err) {
    settle(null);
    throw err;
  } finally {
    inFlight.delete(key);
  }
}

/** Serve `request` through the store HTML edge cache; falls through to `origin` when not eligible. */
export async function serveStoreEdge(
  request: Request,
  ctx: Ctx,
  origin: Origin,
  deps: StoreEdgeDeps
): Promise<Response> {
  const requestKey = deps.build ? storeEdgeKey(request, deps.allow) : null;
  if (!requestKey || !deps.build || !deps.r2) return origin(request);
  const key = buildScopedKey(requestKey, deps.build);
  const urlLocale = urlLocaleOf(new URL(request.url).pathname);
  try {
    const hit = await deps.cache.match(key);
    const raw = hit?.headers.get(META);
    if (hit && raw) {
      const meta = JSON.parse(raw) as Meta;
      const now = deps.now();
      const age = (now - meta.at) / 1000;
      if (age >= 0 && age < STORE_EDGE_STALE_S && (await isEntryCurrent(deps.r2, meta, now))) {
        if (age >= STORE_EDGE_FRESH_S) {
          ctx.waitUntil(fill(key, request, ctx, origin, deps, urlLocale).catch(() => {}));
          return clientCopy(hit, 'STALE', request, urlLocale);
        }
        return clientCopy(hit, 'HIT', request, urlLocale);
      }
    }
  } catch {
    // cache or epoch store unavailable: render normally
  }
  return fill(key, request, ctx, origin, deps, urlLocale);
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
          data?: {
            store?: {
              id?: unknown;
              status?: unknown;
              isDemo?: unknown;
              settings?: { defaultLanguage?: unknown } | null;
            };
          };
        }
      )?.data?.store;
      if (store?.status === 'active' && typeof store.id === 'string' && store.id)
        v = {
          ok: true,
          id: store.id,
          defaultLanguage: resolveDefaultLanguage(store.settings?.defaultLanguage),
        };
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
