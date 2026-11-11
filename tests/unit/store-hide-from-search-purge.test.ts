/**
 * NEVER-stale: the "hide from search engines" write must purge every cache layer that holds the store's public payload
 * or HTML (Redis public:store keys, the storefront data-cache tags that also move the edge-HTML epoch), and must merge the
 * flag into `settings` without clobbering its other keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  update: vi.fn(),
  findUnique: vi.fn(),
  invalidateCached: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('@api/lib/public-cache', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invalidateCached: m.invalidateCached,
  invalidateCachedPrefix: vi.fn(),
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: m.revalidate }));
vi.mock('@api/lib/store-directory', () => ({ invalidateStoreDirectory: vi.fn() }));
vi.mock('@api/lib/cors-cache', () => ({ bustCorsCache: vi.fn() }));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const tx = { store: { update: m.update, findUnique: m.findUnique } };
  return { ...actual, withStore: async (_id: string, fn: any) => fn(tx), prisma: tx };
});

import { StoreService } from '@api/services/store.service';

describe('PUT seo hideFromSearchEngines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(StoreService, 'getById').mockResolvedValue({
      id: 's1',
      slug: 'shop',
      domain: 'shop.example',
      ogImage: null,
    } as never);
    m.findUnique.mockResolvedValue({ settings: { defaultLanguage: 'ar', navMenu: [1] } });
    m.update.mockImplementation(async (a: any) => ({
      id: 's1',
      slug: 'shop',
      domain: 'shop.example',
      ...a.data,
    }));
  });

  it('merges the flag into settings, keeping the other keys', async () => {
    await StoreService.updateSeo('s1', { hideFromSearchEngines: true });
    expect(m.update.mock.calls[0][0].data.settings).toEqual({
      defaultLanguage: 'ar',
      navMenu: [1],
      hideFromSearchEngines: true,
    });
  });

  it('leaves settings untouched when the flag is absent', async () => {
    await StoreService.updateSeo('s1', { metaTitle: 'T' });
    expect(m.update.mock.calls[0][0].data.settings).toBeUndefined();
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it('purges the public payload keys and the storefront tags for slug AND custom domain', async () => {
    await StoreService.updateSeo('s1', { hideFromSearchEngines: true });
    const keys = m.invalidateCached.mock.calls.map(c => c[0]);
    expect(keys).toEqual(
      expect.arrayContaining([
        'public:store:s1',
        'public:store:shop',
        'public:store:resolve:shop.example',
      ])
    );
    expect(m.revalidate).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'shop', domain: 'shop.example', tags: ['layout:s1'] })
    );
  });
});
