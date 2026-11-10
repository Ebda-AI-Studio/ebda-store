/**
 * Ruling LOCALE-REDIRECT-EDGE-1: an unprefixed URL of a locale-path store is an EMPTY-body redirect decided by the Worker,
 * never the Next error shell a layout `permanentRedirect()` renders (measured 2026-11-09 on storedemo-lamma.ebda.app/:
 * 308 with an 82 KB `__next_error__` body; lamma/dahab returned 500 for the same request earlier that day).
 */
import { describe, it, expect } from 'vitest';
import { edgeLocaleRedirect } from '../../apps/web/locale-redirect-edge';

const ON = { STOREFRONT_LOCALE_PATHS: 'true', STOREFRONT_LOCALE_PATHS_STORES: 'all' };
const ar = async () => 'ar' as const;
const get = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(url, { method, headers });

describe('edge locale redirect', () => {
  it('bare host -> 308 /ar (the store default), empty body, browser-cacheable for 5 min only (Ruling ICEBERG-EDGE-308-1)', async () => {
    const res = (await edgeLocaleRedirect(get('https://storedemo-lamma.ebda.app/'), ON, ar))!;
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/ar');
    // private: never a shared/edge copy; Vary: Cookie: a visitor who later picks the other language is asked again
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(res.headers.get('vary')).toBe('Cookie');
    expect(await res.text()).toBe('');
  });
  it('the cookie-driven 307 is never cached (it follows a visitor choice, not the store default)', async () => {
    const c = (await edgeLocaleRedirect(
      get('https://s.ebda.app/', { cookie: 'force-language=en' }),
      ON,
      ar
    ))!;
    expect(c.status).toBe(307);
    expect(c.headers.get('cache-control')).toBe('private, no-store');
  });
  it('keeps the path and query; a visitor cookie in the other language gets a temporary 307 there', async () => {
    const p = (await edgeLocaleRedirect(
      get('https://s.ebda.app/products/x?utm_source=ig'),
      ON,
      ar
    ))!;
    expect([p.status, p.headers.get('location')]).toEqual([308, '/ar/products/x?utm_source=ig']);
    const c = (await edgeLocaleRedirect(
      get('https://s.ebda.app/', { cookie: 'a=1; force-language=en' }),
      ON,
      ar
    ))!;
    expect([c.status, c.headers.get('location')]).toEqual([307, '/en']);
  });
  it('HEAD is redirected too; POST is not', async () => {
    expect((await edgeLocaleRedirect(get('https://s.ebda.app/', {}, 'HEAD'), ON, ar))?.status).toBe(
      308
    );
    expect(await edgeLocaleRedirect(get('https://s.ebda.app/', {}, 'POST'), ON, ar)).toBeNull();
  });
  it.each([
    [
      'locale paths off',
      'https://s.ebda.app/',
      { STOREFRONT_LOCALE_PATHS: 'false', STOREFRONT_LOCALE_PATHS_STORES: 'all' },
    ],
    [
      'store not in the list',
      'https://s.ebda.app/',
      { STOREFRONT_LOCALE_PATHS: 'true', STOREFRONT_LOCALE_PATHS_STORES: 'other' },
    ],
    ['admin preview iframe', 'https://s.ebda.app/?_preview=1', ON],
    ['already prefixed', 'https://s.ebda.app/ar', ON],
    ['a non-locale route (cart)', 'https://s.ebda.app/cart', ON],
  ])('%s falls through to Next', async (_n, url, env) => {
    expect(await edgeLocaleRedirect(get(url), env, ar)).toBeNull();
  });
  it('an unknown / inactive store or a resolver failure falls through to Next (fail open to the old path)', async () => {
    expect(await edgeLocaleRedirect(get('https://x.ebda.app/'), ON, async () => null)).toBeNull();
    expect(
      await edgeLocaleRedirect(get('https://x.ebda.app/'), ON, async () => {
        throw new Error('api down');
      })
    ).toBeNull();
  });
  it('an English-default store goes to /en', async () => {
    const res = (await edgeLocaleRedirect(get('https://s.ebda.app/'), ON, async () => 'en'))!;
    expect(res.headers.get('location')).toBe('/en');
  });
});
