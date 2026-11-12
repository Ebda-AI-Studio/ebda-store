/**
 * #663: the purge of the LAST order of a burst must not depend on any request's waitUntil. Every order enqueues a
 * per-store DEBOUNCED durable job; its handler runs in its own invocation and does the purge (with retries).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sent: [] as Array<{ name: string; data: { storeId: string } }>,
  outcome: 'ok' as 'ok' | 'failed',
  purged: [] as string[][],
}));
vi.mock('../../apps/api/src/lib/inngest/client', async () => {
  const { registerJob } = await import('../../apps/api/src/lib/jobs/registry');
  return {
    inngest: {
      createFunction: (o: any, fn: any) => registerJob(o, fn),
      send: async (p: any) => void h.sent.push(p),
    },
  };
});
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({
  revalidateStorefront: vi.fn(),
  revalidateStorefrontWithRetry: async (o: { tags: string[] }) => {
    h.purged.push(o.tags);
    return h.outcome;
  },
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { getClient: () => null, isAvailable: () => false, del: vi.fn(), keys: async () => [] },
}));

const { invalidateStoreProductCachesAfterOrder } =
  await import('../../apps/api/src/lib/public-cache');
const { storefrontOrderPurge, ORDER_PURGE_EVENT } =
  await import('../../apps/api/src/lib/inngest/functions/storefront-order-purge');
const { JOBS_MAP } = await import('../../apps/api/src/lib/jobs/jobs-map');

beforeEach(() => {
  h.sent.length = 0;
  h.purged.length = 0;
  h.outcome = 'ok';
});

const step = { run: async (_id: string, fn: () => unknown) => fn() } as any;

describe('durable trailing purge (#663)', () => {
  it('every order, including mid-window ones, enqueues the debounced job for its store', async () => {
    await invalidateStoreProductCachesAfterOrder('s-durable');
    await invalidateStoreProductCachesAfterOrder('s-durable'); // mid-window: last order of the burst
    expect(h.sent).toHaveLength(2);
    expect(h.sent.every(e => e.name === ORDER_PURGE_EVENT && e.data.storeId === 's-durable')).toBe(
      true
    );
  });

  it('the job purges the store tags in its own run, with no request context at all', async () => {
    await storefrontOrderPurge.handler({
      event: { name: ORDER_PURGE_EVENT, data: { storeId: 's-durable' } },
      step,
      runId: 'r',
      attempt: 0,
    });
    expect(h.purged).toEqual([['products:s-durable', 'categories:s-durable', 'bundles:s-durable']]);
  });

  it('a lost purge fails the run so the queue retries it', async () => {
    h.outcome = 'failed';
    await expect(
      storefrontOrderPurge.handler({
        event: { name: ORDER_PURGE_EVENT, data: { storeId: 's' } },
        step,
        runId: 'r',
        attempt: 0,
      })
    ).rejects.toThrow(/purge failed/);
  });

  it('is debounced per store and mapped to a Cloudflare runner', () => {
    expect(storefrontOrderPurge.options.debounce?.key).toBe('event.data.storeId');
    expect(JOBS_MAP['storefront-order-purge']).toMatchObject({ kind: 'queue', trigger: 'event' });
  });
});
