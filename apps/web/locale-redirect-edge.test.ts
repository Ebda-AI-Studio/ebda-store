import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  edgeLocaleRedirect,
  REDIRECT_CACHE_STALE_S,
  type RedirectCache,
} from './locale-redirect-edge';

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

  describe('stale-while-revalidate (WEB-COLD-6)', () => {
    afterEach(() => vi.useRealTimers());
    const warmUp = async (lang: () => Promise<'ar' | 'en'>) => {
      const { store } = memCache();
      const pending: Promise<unknown>[] = [];
      const cache = { store, waitUntil: (p: Promise<unknown>) => void pending.push(p) };
      await edgeLocaleRedirect(req('/about'), env, lang, cache);
      await Promise.all(pending.splice(0));
      return { cache, pending };
    };

    it('an entry older than 60 s is served at once and refreshed in the background', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
      let language: 'ar' | 'en' = 'ar';
      let calls = 0;
      const lang = async () => (calls++, language);
      const { cache, pending } = await warmUp(lang);
      expect(calls).toBe(1);
      vi.setSystemTime(Date.now() + 10 * 60_000);
      language = 'en';
      const stale = await edgeLocaleRedirect(req('/about'), env, lang, cache);
      expect(stale?.headers.get('location')).toBe('/ar/about'); // no resolver wait for the visitor
      await Promise.all(pending.splice(0));
      expect(calls).toBe(2); // refreshed behind the response
      const next = await edgeLocaleRedirect(req('/about'), env, lang, cache);
      expect(next?.headers.get('location')).toBe('/en/about');
      expect(calls).toBe(2);
    });

    it('the visitor does not wait for a slow resolver', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
      const { cache } = await warmUp(async () => 'ar');
      vi.setSystemTime(Date.now() + 5 * 60_000);
      const never = () => new Promise<'ar' | 'en'>(() => {});
      const res = await edgeLocaleRedirect(req('/about'), env, never, cache);
      expect(res?.status).toBe(308);
    });

    it('a failing refresh keeps serving the old entry and never throws', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
      const { cache, pending } = await warmUp(async () => 'ar');
      vi.setSystemTime(Date.now() + 5 * 60_000);
      const res = await edgeLocaleRedirect(
        req('/about'),
        env,
        async () => {
          throw new Error('api down');
        },
        cache
      );
      await Promise.all(pending.splice(0));
      expect(res?.headers.get('location')).toBe('/ar/about');
    });

    it('an entry past the stale window is decided live again', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
      let calls = 0;
      const lang = async () => (calls++, 'ar' as const);
      const { cache } = await warmUp(lang);
      vi.setSystemTime(Date.now() + (REDIRECT_CACHE_STALE_S + 1) * 1000);
      await edgeLocaleRedirect(req('/about'), env, lang, cache);
      expect(calls).toBe(2);
    });
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
