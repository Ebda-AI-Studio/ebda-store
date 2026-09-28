import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Issue #1857 — the Arabic PWA manifest description fallback
 * (`تسوق في ${store.name}`) interpolated the ENGLISH store name under
 * `<html lang="ar">` even though `store.nameAr` was available. Locked down
 * here against the mutation of reverting to `store.name` unconditionally.
 *
 * `getStore` and `cookies()` are mocked so this exercises `manifest()`'s
 * own locale/name-selection logic in isolation, the same pattern
 * `tests/unit/sitemap-fanout.test.ts` uses for another `app/*.ts` special
 * file that calls `next/headers` directly.
 */

const storeRef: { current: Record<string, unknown> | null } = { current: null };
const cookieRef: { lang: string | undefined } = { lang: undefined };

vi.mock('../lib/store-resolver', () => ({
  getStore: async () => storeRef.current,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (k: string) =>
      k === 'force-language' && cookieRef.lang ? { value: cookieRef.lang } : undefined,
  }),
}));

const { default: manifest } = await import('./manifest');

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    id: 'store-1',
    name: 'Wady Aljuz',
    nameAr: 'وادي الجوز',
    slug: 'wady-aljuz',
    domain: undefined,
    favicon: undefined,
    theme: {},
    settings: {},
    ...overrides,
  };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  storeRef.current = null;
  cookieRef.lang = undefined;
  vi.clearAllMocks();
});

describe('manifest — localized store name in the description fallback (#1857)', () => {
  it('ar locale: description uses the Arabic store name, never the English one', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'ar';
    // fetchStoreManifest short-circuits on a non-ok response → basic-manifest
    // branch; the store fixture has no description/descriptionAr, so
    // pickMetaDescription also falls through to this fallback string.
    global.fetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;

    const result = await manifest();

    expect(result.description).toContain('وادي الجوز');
    expect(result.description).not.toContain('Wady Aljuz');
  });

  it('en locale (same store data): description stays English', async () => {
    storeRef.current = makeStore();
    cookieRef.lang = 'en';
    global.fetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;

    const result = await manifest();

    expect(result.description).toContain('Wady Aljuz');
  });

  it('ar locale, no nameAr set: falls back to the English name rather than going blank', async () => {
    storeRef.current = makeStore({ nameAr: undefined });
    cookieRef.lang = 'ar';
    global.fetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;

    const result = await manifest();

    expect(result.description).toContain('Wady Aljuz');
  });
});
