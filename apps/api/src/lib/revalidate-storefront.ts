import { storeHost } from '@ebda/shared';
import logger from './logger';
import { enqueueStorefrontPurge } from './storefront-purge-jobs';
import { cfBindings, cfWaitUntil } from '../cf/bindings';

/**
 * Fire-and-forget storefront cache purge. After a store mutation (theme,
 * branding, layout, settings…) the API calls the storefront's
 * `POST /api/revalidate` so the merchant sees the change within ~a second
 * instead of waiting out the data-cache TTL.
 *
 * The storefront resolver tags its store fetches `store-domain:<domain>` and
 * `store-slug:<slug>`; a slug purge also hits `store-domain:<slug>.ebda.app`, so a
 * store is refreshed whether visitors reach it at its free subdomain or its
 * custom domain.
 *
 * Config — this is a TWO-SIDED contract and both sides must agree:
 *  - On Workers: the `STOREFRONT` Service Binding to `ebda-web` (apps/api/wrangler.jsonc).
 *    It wins over the URL — the storefront is reached Worker-to-Worker, never via a
 *    public host (Ruling HOST-STORE-1: `store.ebda.app`, the old purge host, is now
 *    the merchant app, so a hostname here can silently start hitting the wrong Worker).
 *  - STOREFRONT_REVALIDATE_URL (API, Node only): storefront base, e.g. https://<slug>.ebda.app
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
/** Placeholder origin for Service Binding requests (the binding routes by binding, not host). */
export const SERVICE_BINDING_BASE = 'https://ebda-web.service-binding';

export function revalidateStorefront(opts: RevalidateOptions): void {
  // Kept alive past the response (`ctx.waitUntil`, 30 s grace) so the retries below can run on Workers.
  cfWaitUntil(revalidateStorefrontWithRetry(opts));
}

/**
 * Retry schedule for a purge that did not land (network error, timeout, 429, 5xx other than 503). Bounded so the
 * whole attempt fits the Worker's 30 s waitUntil grace: 3 tries x 4 s timeout + 1 s + 4 s of backoff = 17 s worst case.
 * Ruling RESOLVE-BULLETPROOF-1: a dropped purge is what lets a suspended store keep resolving from the storefront's
 * caches (60 s fresh, up to 24 h during an outage), because the per-store epoch is written only when this lands.
 * A configuration fault (401 / 503 = secret missing or mismatched) is not retried: it cannot heal in seconds.
 */
export const PURGE_RETRY_DELAYS_MS = [1_000, 4_000];

export async function revalidateStorefrontWithRetry(
  opts: RevalidateOptions,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<RevalidateOutcome> {
  let outcome = await revalidateStorefrontNow(opts);
  for (const delay of PURGE_RETRY_DELAYS_MS) {
    if (outcome !== 'failed') break;
    await sleep(delay);
    outcome = await revalidateStorefrontNow(opts);
  }
  if (outcome === 'failed') {
    logger.error(
      { tags: opts.tags, slug: opts.slug, domain: opts.domain },
      '[revalidate] storefront purge failed after retries: queued for durable retry'
    );
  }
  // STORE-EDGE-4: the edge copy lives up to 6 h, so a purge the fast path could not land goes to the job layer
  // (retries with backoff, then a dead-letter alert). `rejected` (401/503) is a config fault that can heal in minutes.
  if (outcome === 'failed' || outcome === 'rejected') {
    await enqueueStorefrontPurge(opts);
  }
  return outcome;
}

export interface RevalidateOptions {
  slug?: string | null;
  domain?: string | null;
  /**
   * Extra cache tags to purge, for content that is not the store record
   * itself — e.g. `products:<storeId>` after a product or variant write.
   * The storefront tags its data fetches with these.
   */
  tags?: string[];
}

export type RevalidateOutcome =
  | 'ok'
  | 'not-configured'
  | 'nothing-to-purge'
  | 'rejected'
  | 'failed';

/**
 * The same purge, awaitable, with its outcome — for a one-off script that must
 * know the purge landed before it exits (issue 2351). Never throws. The request
 * path keeps using `revalidateStorefront`, which does not await this.
 */
export async function revalidateStorefrontNow(opts: RevalidateOptions): Promise<RevalidateOutcome> {
  const binding = cfBindings()?.STOREFRONT;
  // The binding ignores the hostname; this one only labels logs.
  const base = binding ? SERVICE_BINDING_BASE : process.env.STOREFRONT_REVALIDATE_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!base || !secret) return 'not-configured';

  const tags: string[] = [...(opts.tags ?? [])];
  if (opts.domain) tags.push(`store-domain:${opts.domain.toLowerCase().replace(/^www\./, '')}`);
  if (opts.slug) {
    tags.push(`store-slug:${opts.slug}`);
    // The storefront resolves `<slug>.ebda.app` BY HOST (`store-domain:<host>`),
    // so a slug purge must hit that tag too.
    tags.push(`store-domain:${storeHost(opts.slug)}`);
  }
  if (tags.length === 0) return 'nothing-to-purge';

  const url = `${base.replace(/\/$/, '')}/api/revalidate`;
  // Bounded so a hung storefront can't pile up sockets on the API.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);

  const send = binding ? binding.fetch.bind(binding) : fetch;
  return send(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, tags }),
    signal: ctrl.signal,
  })
    .then((r): RevalidateOutcome => {
      if (r.ok) return 'ok';
      // 503 = the storefront has no REVALIDATE_SECRET, i.e. the purge pipeline
      // is DEAD, not flaky. 401 = the two sides hold different secrets. Both
      // are configuration faults that silently disable every invalidation, so
      // they are errors (Sentry-visible), not warnings.
      const dead = r.status === 503 || r.status === 401;
      // 429 / other 5xx: the purge did not land but may on a retry (revalidateStorefrontWithRetry).
      if (!dead && (r.status === 429 || r.status >= 500)) {
        logger.warn(
          { status: r.status, tags, storefront: base },
          '[revalidate] storefront purge failed, retryable'
        );
        return 'failed';
      }
      const log = dead ? logger.error.bind(logger) : logger.warn.bind(logger);
      log(
        { status: r.status, tags, storefront: base },
        dead
          ? '[revalidate] storefront REJECTED the purge — cache invalidation is DISABLED; ' +
              'check REVALIDATE_SECRET matches on BOTH the API and the storefront Worker'
          : '[revalidate] storefront purge non-2xx'
      );
      return 'rejected';
    })
    .catch((err): RevalidateOutcome => {
      logger.warn({ err: err?.message, tags }, '[revalidate] storefront purge failed');
      return 'failed';
    })
    .finally(() => clearTimeout(timer));
}
