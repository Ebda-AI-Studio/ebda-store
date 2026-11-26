import { resolveDefaultLanguage, storeOrigin } from '@ebda/shared';
import { headers } from 'next/headers';
import { API_URL } from './api';
import {
  LOCALE_PATH_HEADER,
  localePathsOn,
  localizeUrlsInText,
  machineFileLocale,
  storeKeyForHost,
} from './locale-paths';

/**
 * Passthrough for the advertising product feeds (`/feeds/google.xml`, `/feeds/meta.xml`, `/feeds/tiktok.csv`).
 * Tenant = the request HOST (middleware's `x-store-domain`), exactly like `feeds/products.json`. The feed is built and
 * gated in the API (`product_feeds`, 404 when off - fail closed); this handler resolves the store, forwards `lang`/`part`
 * after validating them, and puts the store's own links on the language prefix when LOCALE-PATHS is on.
 *
 * CACHE: the Next data cache entry is tagged `products:<storeId>`, the tag every product/price/stock write purges
 * (invalidateStoreProductCaches) - the NEVER-stale layer. The remaining window is the response's s-maxage, 300 s
 * (60 s for gold-rate stores), no stale-while-revalidate: BOUNDED, shorter than any ad platform's fetch interval
 * (Ruling FEEDS-4).
 */
type FeedKind = 'google.xml' | 'meta.xml' | 'tiktok.csv';

async function resolveStore(domain: string) {
  const none = {
    id: null as string | null,
    slug: null as string | null,
    domain: null as string | null,
    defaultLanguage: undefined as string | undefined,
  };
  try {
    const res = await fetch(`${API_URL}/public/store/resolve`, {
      next: {
        revalidate: 600,
        tags: [`store-domain:${domain.toLowerCase().replace(/^www\./, '')}`],
      },
      headers: { 'Content-Type': 'application/json', 'x-store-domain': domain },
    });
    if (!res.ok) return none;
    const store = (await res.json())?.data?.store;
    return {
      id: (store?.id as string | undefined) ?? null,
      slug: (store?.slug as string | undefined) ?? null,
      domain: (store?.domain as string | undefined) ?? null,
      defaultLanguage: store?.settings?.defaultLanguage as string | undefined,
    };
  } catch {
    return none;
  }
}

export async function serveCatalogueFeed(kind: FeedKind, request: Request): Promise<Response> {
  const h = await headers();
  const domain = h.get('x-store-domain');
  if (!domain) return new Response('Not found', { status: 404 });

  const url = new URL(request.url);
  const langParam = url.searchParams.get('lang');
  const partParam = url.searchParams.get('part');
  if (langParam !== null && langParam !== 'ar' && langParam !== 'en') {
    return new Response('lang must be ar or en', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (partParam !== null && !/^[1-9]\d{0,2}$/.test(partParam)) {
    return new Response('part must be a positive integer', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const resolved = await resolveStore(domain);
  // `/en/feeds/google.xml`: the URL's language wins over the default (an explicit `?lang=` still wins over both).
  const lang =
    (langParam as 'ar' | 'en' | null) ?? machineFileLocale(h.get(LOCALE_PATH_HEADER)) ?? 'ar';
  const qs = new URLSearchParams({ lang, ...(partParam ? { part: partParam } : {}) });
  const upstream = await fetch(`${API_URL}/public/feed/${kind}?${qs}`, {
    headers: { 'x-store-domain': domain },
    next: resolved.id
      ? { revalidate: 300, tags: [`products:${resolved.id}`] }
      : { revalidate: 300 },
  });
  // Only the API's definitive 404 is "no feed here" (feature off / no such part). Any other failure means the API
  // could not be asked: 503 + no-store makes the platform retry and caches nothing.
  if (upstream.status === 404) return new Response('Not found', { status: 404 });
  if (upstream.status === 400)
    return new Response('Bad request', { status: 400, headers: { 'Cache-Control': 'no-store' } });
  if (!upstream.ok) {
    return new Response('Product feed temporarily unavailable', {
      status: 503,
      headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
    });
  }

  let body = await upstream.text();
  if (localePathsOn(storeKeyForHost(domain))) {
    const origins = [
      `https://${domain}`,
      ...(resolved.domain ? [`https://${resolved.domain}`] : []),
      ...(resolved.slug ? [storeOrigin(resolved.slug)] : []),
    ];
    // the feed language decides the prefix: an English feed links to /en/..., an Arabic one to /ar/...
    body = localizeUrlsInText(body, origins, resolveDefaultLanguage(lang));
  }
  const out: Record<string, string> = {
    'Content-Type':
      upstream.headers.get('content-type') ??
      (kind === 'tiktok.csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8'),
    'Cache-Control': upstream.headers.get('cache-control') ?? 'public, s-maxage=300',
  };
  const next = upstream.headers.get('x-feed-next-part');
  if (next) out['X-Feed-Next-Part'] = next;
  return new Response(body, { status: 200, headers: out });
}
