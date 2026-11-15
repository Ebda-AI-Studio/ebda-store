/**
 * STORE-EDGE-4: DURABLE storefront purges.
 *
 * The storefront HTML edge copy may be served stale for 6 h (apps/web/store-edge-cache.ts), so a purge that
 * is lost must not stay lost. `revalidateStorefrontWithRetry` is the fast path (3 tries inside the request's
 * waitUntil); when it ends `failed` or `rejected` it calls {@link enqueueStorefrontPurge}, which hands the SAME purge
 * to the job layer (`storefront-purge-retry`, a jobs-queue job: retries with backoff, then the DLQ, which raises the
 * P1 platform alert + Sentry through lib/jobs/failure.ts). Timed events with no write (a bundle sale window starting
 * or ending) are scheduled the same way: see `storefront-bundle-boundary`.
 */
import { prisma } from '@ebda/database';
import logger from './logger';
import { inngest } from './inngest/client';
import { withStoreDb } from './jobs/store-db';
import { revalidateStorefront, type RevalidateOptions } from './revalidate-storefront';

export const PURGE_RETRY_EVENT = 'storefront/purge.retry';
export const BUNDLE_BOUNDARY_EVENT = 'storefront/bundle.boundary';

/** Queue a purge the fast path could not land. Never throws: an enqueue miss is logged at error level (alertable). */
export async function enqueueStorefrontPurge(opts: RevalidateOptions): Promise<boolean> {
  try {
    await inngest.send({
      name: PURGE_RETRY_EVENT,
      data: { tags: opts.tags ?? [], slug: opts.slug ?? null, domain: opts.domain ?? null },
    });
    return true;
  } catch (err) {
    logger.error(
      { err, tags: opts.tags },
      '[revalidate] storefront purge LOST and could not be queued: copies stay until their TTL'
    );
    return false;
  }
}

/**
 * The next instant a bundle's sale window changes buyability for this store: the earliest future `startsAt` or
 * `expiresAt` of an active bundle, as epoch ms, or null. Buyability is computed per request from the clock
 * (bundle.routes.ts `withinSaleWindow`), so crossing one of these is not a write and purges nothing by itself.
 */
export async function nextBundleBoundary(storeId: string, now: number): Promise<number | null> {
  const at = new Date(now);
  const rows = await withStoreDb(storeId, async db =>
    (db as unknown as typeof prisma).bundle.findMany({
      where: {
        storeId,
        isActive: true,
        OR: [{ startsAt: { gt: at } }, { expiresAt: { gt: at } }],
      },
      select: { startsAt: true, expiresAt: true },
      take: 500,
    })
  );
  let next: number | null = null;
  for (const r of rows) {
    for (const d of [r.startsAt, r.expiresAt]) {
      const t = d ? new Date(d).getTime() : NaN;
      if (Number.isFinite(t) && t > now && (next === null || t < next)) next = t;
    }
  }
  return next;
}

/**
 * Schedule the purge for the store's next bundle boundary (call after a bundle is created, updated or deactivated).
 * Idempotent: the workflow instance id is `<store>:<at>`, so a repeat for the same instant is a no-op. Never throws.
 */
export async function scheduleBundleBoundary(storeId: string): Promise<void> {
  try {
    const at = await nextBundleBoundary(storeId, Date.now());
    if (at === null) return;
    // Cap cached pages at this instant even if the scheduled purge below never runs (apps/web store-edge-cache.ts).
    revalidateStorefront({ tags: [bundleBoundaryTag(storeId, at)] });
    await inngest.send({
      name: BUNDLE_BOUNDARY_EVENT,
      data: { storeId, at, key: `${storeId}:${at}` },
    });
  } catch (err) {
    logger.error({ err, storeId }, '[bundle-boundary] could not schedule the sale-window purge');
  }
}

/** The tag that tells the storefront Worker the store's next boundary (it caps cached pages there). */
export const bundleBoundaryTag = (storeId: string, at: number): string =>
  `bundle-boundary:${storeId}:${at}`;
