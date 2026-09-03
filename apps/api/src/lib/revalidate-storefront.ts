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
 * Config — this is a TWO-SIDED contract and both sides must agree:
 *  - STOREFRONT_REVALIDATE_URL (API): storefront base, e.g. https://store.force-ai.co
 *  - REVALIDATE_SECRET (API **and** the storefront Worker): shared secret.
 *
 * If the secret is missing on the STOREFRONT, this endpoint answers 503 and
 * every purge is silently dropped — the API side looks perfectly healthy while
 * nothing is ever invalidated and all freshness quietly falls back to the TTL.
 * That is exactly what happened in production up to 2026-09-02: the API had
 * both vars, the Worker had neither, and every purge since the feature shipped
 * was rejected. The symptom reaching merchants was "I save and the storefront
 * doesn't change, so I save again" — the second save never fixed anything, the
 * TTL simply expired.
 *
 * A misconfiguration that only ever produced a warn-level log went unnoticed
 * for months, so a rejected purge now escalates: see the response handler.
 *
 * NEVER throws and NEVER awaits in the request path — a revalidation hiccup
 * must not affect the save that already committed.
 */
export function revalidateStorefront(opts: {
  slug?: string | null;
  domain?: string | null;
  /**
   * Extra cache tags to purge, for content that is not the store record
   * itself — e.g. `products:<storeId>` after a product or variant write.
   * The storefront tags its data fetches with these.
   */
  tags?: string[];
}): void {
  const base = process.env.STOREFRONT_REVALIDATE_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!base || !secret) return; // not configured → no-op

  const tags: string[] = [...(opts.tags ?? [])];
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
      if (r.ok) return;
      // 503 = the storefront has no REVALIDATE_SECRET, i.e. the purge pipeline
      // is DEAD, not flaky. 401 = the two sides hold different secrets. Both
      // are configuration faults that silently disable every invalidation, so
      // they are errors (Sentry-visible), not warnings.
      const dead = r.status === 503 || r.status === 401;
      const log = dead ? logger.error.bind(logger) : logger.warn.bind(logger);
      log(
        { status: r.status, tags, storefront: base },
        dead
          ? '[revalidate] storefront REJECTED the purge — cache invalidation is DISABLED; ' +
              'check REVALIDATE_SECRET matches on BOTH the API and the storefront Worker'
          : '[revalidate] storefront purge non-2xx'
      );
    })
    .catch(err => logger.warn({ err: err?.message, tags }, '[revalidate] storefront purge failed'))
    .finally(() => clearTimeout(timer));
}
