import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCfBindings, setCfBindings, type CfBindings } from '../../apps/api/src/cf/bindings';
import {
  revalidateStorefrontNow,
  SERVICE_BINDING_BASE,
} from '../../apps/api/src/lib/revalidate-storefront';

// Ruling HOST-STORE-1: store.ebda.app is the merchant app now, so the storefront
// purge must not depend on a public hostname. On Workers it goes over the
// `STOREFRONT` Service Binding to ebda-web; the URL env is the Node fallback only.
describe('revalidateStorefrontNow transport', () => {
  const env = { ...process.env };
  const globalFetch = vi.fn(async () => new Response('{}', { status: 200 }));

  beforeEach(() => {
    process.env.REVALIDATE_SECRET = 's3cret';
    process.env.STOREFRONT_REVALIDATE_URL = 'https://store.ebda.app';
    vi.stubGlobal('fetch', globalFetch);
  });
  afterEach(() => {
    process.env = { ...env };
    clearCfBindings();
    vi.unstubAllGlobals();
    globalFetch.mockClear();
  });

  it('uses the STOREFRONT service binding when present, never the public URL', async () => {
    const bindingFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    setCfBindings({
      STOREFRONT: { fetch: bindingFetch },
    } as unknown as CfBindings);

    await expect(revalidateStorefrontNow({ tags: ['layout:s1'] })).resolves.toBe('ok');
    expect(globalFetch).not.toHaveBeenCalled();
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    const [url, init] = bindingFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SERVICE_BINDING_BASE}/api/revalidate`);
    expect(JSON.parse(String(init.body))).toEqual({ secret: 's3cret', tags: ['layout:s1'] });
  });

  it('works over the binding even with no STOREFRONT_REVALIDATE_URL set', async () => {
    delete process.env.STOREFRONT_REVALIDATE_URL;
    const bindingFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    setCfBindings({ STOREFRONT: { fetch: bindingFetch } } as unknown as CfBindings);
    await expect(revalidateStorefrontNow({ slug: 'amelia' })).resolves.toBe('ok');
    expect(bindingFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to STOREFRONT_REVALIDATE_URL over public fetch outside a Worker (Node)', async () => {
    process.env.STOREFRONT_REVALIDATE_URL = 'https://amelia.ebda.app/';
    await expect(revalidateStorefrontNow({ tags: ['layout:s1'] })).resolves.toBe('ok');
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect((globalFetch.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://amelia.ebda.app/api/revalidate'
    );
  });

  it('is not-configured without a binding and without a URL', async () => {
    delete process.env.STOREFRONT_REVALIDATE_URL;
    await expect(revalidateStorefrontNow({ tags: ['x'] })).resolves.toBe('not-configured');
  });
});
