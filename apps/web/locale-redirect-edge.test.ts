import { describe, it, expect } from 'vitest';
import { edgeLocaleRedirect, type RedirectCache } from './locale-redirect-edge';

const env = { STOREFRONT_LOCALE_PATHS: 'true', STOREFRONT_LOCALE_PATHS_STORES: 'all' };
const req = (path: string, cookie?: string) =>
  new Request(`https://shop.ebda.app${path}`, { headers: cookie ? { cookie } : {} });
const memCache = () => {
  const m = new Map<string, Response>();
  const store: RedirectCache = {
    match: async k => m.get(k)?.clone(),
    put: async (k, r) => void m.set(k, r),
  };
  return { m, store };
};

describe('edgeLocaleRedirect (WEB-COLD-4)', () => {
  it.each([
    ['ar', '/products/x', '/ar/products/x'],
    ['en', '/products/x', '/en/products/x'],
    ['en', '/', '/en'],
  ] as const)('default %s: %s -> %s, browser-cacheable 308', async (lang, path, target) => {
    const res = await edgeLocaleRedirect(req(path), env, async () => lang);
    expect(res?.status).toBe(308);
    expect(res?.headers.get('location')).toBe(target);
    expect(res?.headers.get('cache-control')).toBe('private, max-age=300');
    expect(res?.headers.get('vary')).toBe('Cookie');
  });

  it('a cold isolate answers from the cache without asking the resolver', async () => {
    const { store } = memCache();
    const pending: Promise<unknown>[] = [];
    const cache = { store, waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    let calls = 0;
    const lang = async () => (calls++, 'en' as const);
    const a = await edgeLocaleRedirect(req('/products/x?a=1'), env, lang, cache);
    await Promise.all(pending);
    const b = await edgeLocaleRedirect(req('/products/x?a=1'), env, lang, cache);
    expect(calls).toBe(1);
    expect(b?.status).toBe(308);
    expect(b?.headers.get('location')).toBe('/en/products/x?a=1');
    expect(b?.headers.get('location')).toBe(a?.headers.get('location'));
  });

  it('keys per host: another store with another default language is never served the first one', async () => {
    const { store } = memCache();
    const pending: Promise<unknown>[] = [];
    const cache = { store, waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    await edgeLocaleRedirect(req('/about'), env, async () => 'ar', cache);
    await Promise.all(pending);
    const other = await edgeLocaleRedirect(
      new Request('https://other.ebda.app/about'),
      env,
      async () => 'en',
      cache
    );
    expect(other?.headers.get('location')).toBe('/en/about');
  });

  it('a force-language cookie bypasses the cache and gets the private no-store 307', async () => {
    const { store, m } = memCache();
    const pending: Promise<unknown>[] = [];
    const cache = { store, waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    await edgeLocaleRedirect(req('/about'), env, async () => 'ar', cache);
    await Promise.all(pending);
    expect(m.size).toBe(1);
    const res = await edgeLocaleRedirect(
      req('/about', 'force-language=en'),
      env,
      async () => 'ar',
      cache
    );
    expect(res?.status).toBe(307);
    expect(res?.headers.get('location')).toBe('/en/about');
    expect(res?.headers.get('cache-control')).toBe('private, no-store');
  });

  it('falls through (null) when the store is unknown', async () => {
    expect(await edgeLocaleRedirect(req('/about'), env, async () => null)).toBeNull();
  });
});
