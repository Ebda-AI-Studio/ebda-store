/**
 * #904 — `GET /public/redirects/resolve` sits on every storefront 404, which is
 * what crawlers hit in volume. `resolveSlugRedirectCached` must absorb repeat
 * lookups (misses included) for REDIRECT_CACHE_TTL_MS, per store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
vi.mock('@ebda/database', () => ({
  prisma: { slugRedirect: { findUnique: (...a: unknown[]) => findUnique(...a) } },
  SlugEntityType: { PRODUCT: 'PRODUCT', BLOG: 'BLOG', CATEGORY: 'CATEGORY', PAGE: 'PAGE' },
}));

import {
  resolveSlugRedirectCached,
  clearSlugRedirectCache,
  REDIRECT_CACHE_TTL_MS,
} from '../../apps/api/src/services/slug-redirect.service';

const PRODUCT = 'PRODUCT' as never;

describe('resolveSlugRedirectCached', () => {
  beforeEach(() => {
    findUnique.mockReset();
    clearSlugRedirectCache();
  });

  it('a repeated MISS inside the TTL does not hit the database again', async () => {
    findUnique.mockResolvedValue(null);
    const t0 = 1_000_000;
    expect(await resolveSlugRedirectCached('s1', PRODUCT, 'ghost', t0)).toBeNull();
    expect(await resolveSlugRedirectCached('s1', PRODUCT, 'ghost', t0 + 1000)).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('a hit is cached too, and re-read after the TTL', async () => {
    findUnique
      .mockResolvedValueOnce({ toSlug: 'new' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ toSlug: 'newer' })
      .mockResolvedValueOnce(null);
    const t0 = 2_000_000;
    expect(await resolveSlugRedirectCached('s1', PRODUCT, 'old', t0)).toBe('new');
    expect(await resolveSlugRedirectCached('s1', PRODUCT, 'old', t0 + 5)).toBe('new');
    expect(findUnique).toHaveBeenCalledTimes(2); // one chain walk: old→new, new→(none)
    expect(
      await resolveSlugRedirectCached('s1', PRODUCT, 'old', t0 + REDIRECT_CACHE_TTL_MS + 1)
    ).toBe('newer');
  });

  it('is keyed per store — one store’s answer never leaks to another', async () => {
    findUnique.mockResolvedValueOnce({ toSlug: 'b' }).mockResolvedValueOnce(null);
    expect(await resolveSlugRedirectCached('s1', PRODUCT, 'a', 1)).toBe('b');
    findUnique.mockResolvedValue(null);
    expect(await resolveSlugRedirectCached('s2', PRODUCT, 'a', 2)).toBeNull();
  });
});

// The route half (GET /redirects/resolve answers through the cached resolver) runs the real handler in
// tests/unit/slug-redirect-resolve-route-cached.test.ts (this file mocks the database, not the service).
