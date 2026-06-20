import logger from './logger';

/**
 * Fire-and-forget storefront cache purge. After a store mutation (theme,
 * branding, layout, settings…) the API calls the storefront's
 * `POST /api/revalidate` so the merchant sees the change within ~a second
 * instead of waiting out the data-cache TTL.
 *
 * The storefront resolver tags its store fetches `store-domain:<domain>` and
 * `store-slug:<slug>`; we purge both so a store is refreshed whether visitors
 * reach it via its custom domain or the platform slug path.
 *
 * Config (both optional — unset = silently skip, never block a save):
 *  - STOREFRONT_REVALIDATE_URL: storefront base, e.g. https://store.forcemediakw.com
 *  - REVALIDATE_SECRET: shared secret, also set on the storefront.
 *
 * NEVER throws and NEVER awaits in the request path — a revalidation hiccup
 * must not affect the save that already committed.
 */
export function revalidateStorefront(opts: { slug?: string | null; domain?: string | null }): void {
  const base = process.env.STOREFRONT_REVALIDATE_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!base || !secret) return; // not configured → no-op

  const tags: string[] = [];
  if (opts.domain) tags.push(`store-domain:${opts.domain.toLowerCase().replace(/^www\./, '')}`);
  if (opts.slug) tags.push(`store-slug:${opts.slug}`);
  if (tags.length === 0) return;

  const url = `${base.replace(/\/$/, '')}/api/revalidate`;
  // Bounded so a hung storefront can't pile up sockets on the API.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, tags }),
    signal: ctrl.signal,
  })
    .then(r => {
      if (!r.ok) logger.warn({ status: r.status, tags }, '[revalidate] storefront purge non-2xx');
    })
    .catch(err => logger.warn({ err: err?.message, tags }, '[revalidate] storefront purge failed'))
    .finally(() => clearTimeout(timer));
}
