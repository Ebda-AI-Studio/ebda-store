import { headers } from 'next/headers';
import { API_URL } from '../../../lib/api';

/**
 * Public AI product feed passthrough (agent_feed; all paid plans).
 *
 * Tenant comes from middleware headers exactly like `llms.txt/route.ts`:
 * `x-store-slug` on the platform path (store.force-ai.co/<slug>/feeds/...)
 * or `x-store-domain` on a merchant's custom domain. The feed itself is
 * built and gated in the API — this handler only resolves the tenant and
 * forwards. 404 in every not-available case (fail closed — a public URL
 * must not reveal whether the add-on exists for a given store).
 *
 * `getStoreIdFromRequest` on the API side only accepts `X-Store-ID` or
 * `x-store-domain` (no slug support), so the slug path resolves to a store
 * id first via the same `/public/stores/<slug>` lookup `llms.txt` uses,
 * then calls the feed endpoint with `X-Store-ID`. The domain path forwards
 * `x-store-domain` straight through since the API already understands it.
 */

async function resolveStoreIdFromSlug(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/public/stores/${encodeURIComponent(slug)}`, {
      next: { revalidate: 600 },
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.store?.id ?? null;
  } catch {
    return null;
  }
}

/** Same shape as resolveStoreIdFromSlug, for the custom-domain branch. */
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
    return (json?.data?.id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const h = await headers();
  const domain = h.get('x-store-domain');
  const slug = h.get('x-store-slug');
  if (!domain && !slug) return new Response('Not found', { status: 404 });

  const feedHeaders: Record<string, string> = domain
    ? { 'x-store-domain': domain }
    : { 'X-Store-ID': (await resolveStoreIdFromSlug(slug!)) ?? '' };

  if (!domain && !feedHeaders['X-Store-ID']) {
    return new Response('Not found', { status: 404 });
  }

  // The cache tag has to key on the store ID because that is what the API
  // purges with. The slug branch already resolved one; the domain branch has
  // to resolve one too, or custom-domain storefronts (the majority) would keep
  // the untagged, TTL-only behaviour this fix exists to remove.
  const storeId = domain ? await resolveStoreIdFromDomain(domain) : feedHeaders['X-Store-ID'];

  const upstream = await fetch(`${API_URL}/public/feed/products.json`, {
    headers: feedHeaders,
    // 10-minute TTL was the only freshness control here; the tag lets a
    // product save purge the feed immediately (agentic-commerce consumers
    // read this).
    next: storeId ? { revalidate: 600, tags: [`products:${storeId}`] } : { revalidate: 600 },
  });
  if (!upstream.ok) return new Response('Not found', { status: 404 });

  return new Response(await upstream.text(), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400',
    },
  });
}
