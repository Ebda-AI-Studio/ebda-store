import { resolveDefaultLanguage, storeOrigin } from '@ebda/shared';
import {
  LOCALE_PATH_HEADER,
  localePathsOn,
  localizeJsonLdUrls,
  machineFileLocale,
  storeKeyForHost,
} from '../../../lib/locale-paths';
import { headers } from 'next/headers';
import { API_URL } from '../../../lib/api';

/**
 * Public AI product feed passthrough (agent_feed; all paid plans).
 *
 * Tenant comes from the middleware's `x-store-domain` header — the request HOST
 * (`<slug>.ebda.app` or a merchant's custom domain), exactly like
 * `llms.txt/route.ts`. The feed itself is built and gated in the API — this
 * handler only resolves the tenant and forwards. 404 in every not-available
 * case (fail closed — a public URL must not reveal whether the add-on exists
 * for a given store).
 *
 * The API's `getStoreIdFromRequest` understands `x-store-domain` for both host
 * shapes (slug subdomain or custom domain), so the host is forwarded straight
 * through and the feed is keyed per host.
 */

/** Resolve the host to the store (id for the purge tag, slug/domain/default language for the URLs). */
async function resolveStoreFromDomain(domain: string): Promise<{
  id: string | null;
  slug: string | null;
  domain: string | null;
  defaultLanguage: string | undefined;
}> {
  const none = { id: null, slug: null, domain: null, defaultLanguage: undefined };
  try {
    const res = await fetch(`${API_URL}/public/store/resolve`, {
      next: {
        revalidate: 600,
        tags: [`store-domain:${domain.toLowerCase().replace(/^www\./, '')}`],
      },
      headers: { 'Content-Type': 'application/json', 'x-store-domain': domain },
    });
    if (!res.ok) return none;
    const json = await res.json();
    // The endpoint answers { data: { store: {...}, enabledFeatures, ... } } —
    // reading data.id was always undefined, so the custom-domain branch (the
    // majority of real storefronts) silently fell back to an untagged fetch.
    const store = json?.data?.store;
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

/**
 * A store with language-in-the-URL ON (LOCALE-PATHS-1) publishes the CANONICAL product URLs (the default-language prefix),
 * so a shopping agent never follows an old URL through a redirect. Every string on the store's own origin is localized
 * like an href; off, or a body that is not JSON, the feed is forwarded byte for byte.
 */
async function localizedFeed(
  text: string,
  host: string,
  store: { slug: string | null; domain: string | null; defaultLanguage: string | undefined },
  urlLocale: 'ar' | 'en' | null = null
): Promise<string> {
  if (!localePathsOn(storeKeyForHost(host))) return text;
  try {
    const origins = [
      `https://${host}`,
      ...(store.domain ? [`https://${store.domain}`] : []),
      ...(store.slug ? [storeOrigin(store.slug)] : []),
    ];
    return JSON.stringify(
      localizeJsonLdUrls(
        JSON.parse(text),
        origins,
        urlLocale ?? resolveDefaultLanguage(store.defaultLanguage)
      )
    );
  } catch {
    return text;
  }
}

export async function GET() {
  const h = await headers();
  const domain = h.get('x-store-domain');
  if (!domain) return new Response('Not found', { status: 404 });

  const feedHeaders: Record<string, string> = { 'x-store-domain': domain };

  // The cache tag has to key on the store ID because that is what the API
  // purges with, so resolve one for the host.
  const resolved = await resolveStoreFromDomain(domain);
  const storeId = resolved.id;

  const upstream = await fetch(`${API_URL}/public/feed/products.json`, {
    headers: feedHeaders,
    // 10-minute TTL was the only freshness control here; the tag lets a
    // product save purge the feed immediately (agentic-commerce consumers
    // read this).
    next: storeId ? { revalidate: 600, tags: [`products:${storeId}`] } : { revalidate: 600 },
  });
  // Only the API's definitive 404 is "no feed here". Any other failure (429,
  // 5xx) means the API could not be asked (#2224's class): answering 404 would
  // tell a feed consumer the store has no feed, and `.json` is on Cloudflare's
  // default-cacheable list, so the edge could hold that false 404. 503 +
  // no-store makes the consumer retry and caches nothing.
  if (upstream.status === 404) return new Response('Not found', { status: 404 });
  if (!upstream.ok) {
    return new Response('Product feed temporarily unavailable', {
      status: 503,
      headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
    });
  }

  // Ruling B5-21 (item 9): a store that sells gold-rate products is held to the BOUNDED-stale window of
  // at most 60 s with no stale-while-revalidate tail. A rate write cannot purge the CDN or a shopping
  // feed's own cache, so the window is what keeps a displayed price within a minute of the rate.
  // Checkout re-prices from the database, so no one is charged the old figure. Other stores: unchanged.
  const gold = upstream.headers.get('x-gold-pricing') === '1';
  return new Response(
    await localizedFeed(
      await upstream.text(),
      domain,
      resolved,
      machineFileLocale(h.get(LOCALE_PATH_HEADER))
    ),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': gold
          ? 'public, s-maxage=60'
          : 'public, s-maxage=600, stale-while-revalidate=86400',
      },
    }
  );
}
