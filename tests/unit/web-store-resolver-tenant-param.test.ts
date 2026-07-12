import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for `getStoreByTenantParam()` — the params-based sibling of
 * `getStoreOrNotFound()` added for the tenant-cacheable routing Phase 1
 * work (see docs/plans/2026-07-12-tenant-cacheable-routing.md §3.6). Does
 * NOT exercise `getStore()`/`getStoreOrNotFound()` — those are unchanged.
 */

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

describe('getStoreByTenantParam', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        // Custom-domain resolution hits the SAME /public/store/resolve URL
        // for every domain — the domain itself travels in the
        // `x-store-domain` header, so the mock must branch on that header,
        // not the URL, to distinguish a known vs. unknown domain.
        if (url.includes('/public/store/resolve')) {
          const requestedDomain = init?.headers?.['x-store-domain'];
          if (requestedDomain === 'wadyaljuz.com') {
            return {
              ok: true,
              json: async () => ({
                success: true,
                data: { store: { id: 'store-domain-1', slug: 'wadyaljuz', name: 'Wady Aljuz' } },
              }),
            } as Response;
          }
          return { ok: false, json: async () => ({}) } as Response;
        }
        if (url.includes('/public/stores/palora')) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              data: { store: { id: 'store-slug-1', slug: 'palora', name: 'Palora' } },
            }),
          } as Response;
        }
        return { ok: false, json: async () => ({}) } as Response;
      })
    );
  });

  it('resolves a bare tenant string as a custom domain', async () => {
    const { getStoreByTenantParam } = await import('@web/lib/store-resolver');
    const store = await getStoreByTenantParam('wadyaljuz.com');
    expect(store.id).toBe('store-domain-1');
    expect(store.slug).toBe('wadyaljuz');
  });

  it('resolves a `slug:<slug>` tenant string as a platform-path store', async () => {
    const { getStoreByTenantParam } = await import('@web/lib/store-resolver');
    const store = await getStoreByTenantParam('slug:palora');
    expect(store.id).toBe('store-slug-1');
    expect(store.slug).toBe('palora');
  });

  it('triggers notFound() when the custom domain does not resolve', async () => {
    const { getStoreByTenantParam } = await import('@web/lib/store-resolver');
    await expect(getStoreByTenantParam('unknown-domain.com')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('triggers notFound() when the slug does not resolve', async () => {
    const { getStoreByTenantParam } = await import('@web/lib/store-resolver');
    await expect(getStoreByTenantParam('slug:unknown-slug')).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
