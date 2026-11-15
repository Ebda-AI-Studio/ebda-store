import type { JobDef } from '../../jobs/types';
import logger from '../../logger';
import { inngest } from '../client';
import { revalidateStorefrontNow } from '../../revalidate-storefront';
import {
  BUNDLE_BOUNDARY_EVENT,
  PURGE_RETRY_EVENT,
  bundleBoundaryTag,
  nextBundleBoundary,
} from '../../storefront-purge-jobs';

/**
 * STORE-EDGE-4. Two jobs that make the storefront purge durable (see lib/storefront-purge-jobs.ts).
 *
 * `storefront-purge-retry`: a purge the in-request attempt could not land. Throws on `failed` / `rejected`, so the
 * jobs queue retries with backoff; when the retries are spent the job layer's final-failure path raises the P1 alert
 * (reportJobFailure) and the message lands in the dead-letter queue. `not-configured` (dev) and `nothing-to-purge` are done.
 *
 * `storefront-bundle-boundary`: a bundle sale window starts or ends with no write. A Workflow sleeps until that instant,
 * purges the store (products + categories + bundles, and the new boundary marker for the edge cap), then schedules the
 * store's next boundary. The instance id is the `key`, so a repeated schedule for one instant is a no-op.
 */
type PurgeData = { tags?: string[]; slug?: string | null; domain?: string | null };

export async function runPurgeRetry(data: PurgeData): Promise<{ outcome: string }> {
  const outcome = await revalidateStorefrontNow({
    tags: data.tags ?? [],
    slug: data.slug ?? null,
    domain: data.domain ?? null,
  });
  if (outcome === 'failed' || outcome === 'rejected')
    throw new Error(`storefront purge ${outcome}`);
  return { outcome };
}

export const storefrontPurgeRetry: JobDef = inngest.createFunction(
  {
    id: 'storefront-purge-retry',
    name: 'Storefront: durable retry of a lost cache purge',
    retries: 6,
    triggers: [{ event: PURGE_RETRY_EVENT }],
    onFailure: ({ event }) => {
      logger.error(
        { tags: event?.data?.event?.data?.tags },
        '[storefront-purge-retry] purge could not be delivered after every retry: dead-lettered'
      );
    },
  },
  async ({ event, step }) => step.run('purge', () => runPurgeRetry((event.data ?? {}) as PurgeData))
);

type BoundaryData = { storeId?: string; at?: number };
type Step = {
  sleepUntil(id: string, until: number): Promise<unknown>;
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sendEvent(id: string, payload: { name: string; data: Record<string, unknown> }): Promise<unknown>;
};

/** Settle after the boundary so `now >= at` on every clock the per-request window check uses. */
export const BOUNDARY_SETTLE_MS = 2_000;

export async function runBundleBoundary(data: BoundaryData, step: Step) {
  const { storeId, at } = data;
  if (!storeId || typeof at !== 'number' || !Number.isFinite(at)) return { skipped: 'bad-event' };
  await step.sleepUntil('wait-for-boundary', at + BOUNDARY_SETTLE_MS);
  const next = await step.run('next-boundary', () => nextBundleBoundary(storeId, Date.now()));
  await step.run('purge', async () => {
    const tags = [`products:${storeId}`, `categories:${storeId}`, `bundles:${storeId}`];
    if (next !== null) tags.push(bundleBoundaryTag(storeId, next));
    const outcome = await revalidateStorefrontNow({ tags });
    if (outcome === 'failed' || outcome === 'rejected')
      throw new Error(`storefront purge ${outcome}`);
    return { outcome };
  });
  if (next !== null)
    await step.sendEvent('schedule-next', {
      name: BUNDLE_BOUNDARY_EVENT,
      data: { storeId, at: next, key: `${storeId}:${next}` },
    });
  return { purgedAt: at, next };
}

export const storefrontBundleBoundary: JobDef = inngest.createFunction(
  {
    id: 'storefront-bundle-boundary',
    name: 'Storefront: purge at a bundle sale-window boundary',
    retries: 5,
    idempotency: 'event.data.key',
    triggers: [{ event: BUNDLE_BOUNDARY_EVENT }],
  },
  async ({ event, step }) => runBundleBoundary((event.data ?? {}) as BoundaryData, step as never)
);
