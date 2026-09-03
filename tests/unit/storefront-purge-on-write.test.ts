/**
 * Product/category writes must purge the STOREFRONT cache, not just Redis (unit)
 *
 * Merchants reported saving a product or variant and not seeing the change on
 * the storefront until they saved "a few more times". The repeat saves did
 * nothing — the Next.js data cache on the storefront Worker holds the API's
 * response for 60s, and nothing purged it. Clearing the API's Redis cache (as
 * every writer already did) leaves that outer layer untouched.
 *
 * The purge is wired into `invalidateStoreProductCaches` /
 * `invalidateStoreCategoriesCaches` rather than into each of their ~20 callers,
 * so a future write path cannot forget it. This test pins that: the choke point
 * must emit the tag the storefront fetches are tagged with.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const revalidateSpy = vi.fn();

vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({
  revalidateStorefront: (...args: unknown[]) => revalidateSpy(...args),
}));

// The cache layer itself is not under test here — only the purge wiring.
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    getClient: () => null,
    isAvailable: () => false,
    del: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
  },
}));

const { invalidateStoreProductCaches, invalidateStoreCategoriesCaches } =
  await import('../../apps/api/src/lib/public-cache');

const STORE = 'store-abc';

describe('storefront purge on product/category writes', () => {
  beforeEach(() => revalidateSpy.mockClear());

  it('purges the products tag the storefront fetches are tagged with', async () => {
    await invalidateStoreProductCaches(STORE);

    const tags = revalidateSpy.mock.calls.flatMap(
      ([arg]) => (arg as { tags?: string[] })?.tags ?? []
    );
    expect(tags).toContain(`products:${STORE}`);
  });

  it('purges the categories tag too — a product write can change category pages', async () => {
    await invalidateStoreProductCaches(STORE);

    const tags = revalidateSpy.mock.calls.flatMap(
      ([arg]) => (arg as { tags?: string[] })?.tags ?? []
    );
    expect(tags).toContain(`categories:${STORE}`);
  });

  it('purges on a categories-only write', async () => {
    await invalidateStoreCategoriesCaches(STORE);

    const tags = revalidateSpy.mock.calls.flatMap(
      ([arg]) => (arg as { tags?: string[] })?.tags ?? []
    );
    expect(tags).toContain(`categories:${STORE}`);
  });

  it('scopes the tag to the store, so one merchant’s save cannot purge another’s cache', async () => {
    await invalidateStoreProductCaches(STORE);

    const tags = revalidateSpy.mock.calls.flatMap(
      ([arg]) => (arg as { tags?: string[] })?.tags ?? []
    );
    expect(tags.every(t => t.endsWith(`:${STORE}`))).toBe(true);
  });
});
