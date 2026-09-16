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
          // A DEFINITIVE miss must carry the API's real status. `/store/resolve`
          // answers an unknown domain with a genuine
          // `404 {success:false, error:{code:'STORE_NOT_FOUND'}}`, and since
          // 2026-09-16 the resolver keys on that: only a 404 (or a well-formed
          // store-less body) is "no such store", while any OTHER non-OK
          // response — a 429 from storeResolveLimiter, a 5xx — is transient and
          // must NOT become a 404. A statusless `{ok:false}` stub no longer
          // describes anything the API can actually return.
          // See docs/plans/2026-09-16-store-resolve-transient-not-404.md.
          return {
            ok: false,
            status: 404,
            json: async () => ({
              success: false,
              error: {
                code: 'STORE_NOT_FOUND',
                message: 'No store found for the specified domain',
              },
            }),
          } as Response;
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
        // Unknown slug → the same definitive 404 the API really returns
        // (`/stores/:slugOrId` throws `AppError(404,'NOT_FOUND')`).
        return {
          ok: false,
          status: 404,
          json: async () => ({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Store not found' },
          }),
        } as Response;
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
