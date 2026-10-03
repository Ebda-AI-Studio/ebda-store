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

/** Resolve the host to a store id (for the purge tag). */
async function resolveStoreIdFromDomain(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/public/store/resolve`, {
      next: {
        revalidate: 600,
        tags: [`store-domain:${domain.toLowerCase().replace(/^www\./, '')}`],
      },
      headers: { 'Content-Type': 'application/json', 'x-store-domain': domain },
    });
    if (!res.ok) return null;
    const json = await res.json();
    // The endpoint answers { data: { store: {...}, enabledFeatures, ... } } —
    // reading data.id was always undefined, so the custom-domain branch (the
    // majority of real storefronts) silently fell back to an untagged fetch.
    return (json?.data?.store?.id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const h = await headers();
  const domain = h.get('x-store-domain');
  if (!domain) return new Response('Not found', { status: 404 });

  const feedHeaders: Record<string, string> = { 'x-store-domain': domain };

  // The cache tag has to key on the store ID because that is what the API
  // purges with, so resolve one for the host.
  const storeId = await resolveStoreIdFromDomain(domain);

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

  return new Response(await upstream.text(), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400',
    },
  });
}
