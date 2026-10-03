import { describe, expect, it, afterEach } from 'vitest';
import { storeAbsoluteUrl, getSiteUrl } from './structured-data';
import type { ResolvedStore } from './store-resolver';

/**
 * REGRESSION GUARD (2026-07-29). Every pre-existing test below `delete`s
 * NEXT_PUBLIC_SITE_URL first — so the suite never exercised the PRODUCTION
 * condition, where that env var is always set (`https://ebda.app`,
 * inlined at build time). That blind spot is exactly why a broken canonical
 * shipped: with the env var set, `getSiteUrl` returned the platform host for
 * EVERY store, so every custom-domain page advertised a canonical on
 * ebda.app — a URL that resolves to the demo store. The
 * `describe` block at the bottom pins the env-var-SET behavior; do not
 * "simplify" it by deleting the env var.
 */
describe('storeAbsoluteUrl', () => {
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  afterEach(() => {
    if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  });

  it('roots a store with no custom domain at https://<slug>.ebda.app (no /<slug> path prefix)', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const store = {
      id: 'store-1',
      slug: 'my-store',
      domain: undefined,
    } as unknown as ResolvedStore;

    expect(storeAbsoluteUrl(store, '/products/widget')).toBe(
      'https://my-store.ebda.app/products/widget'
    );
  });

  it('roots a custom-domain store at its own domain (byte-identical to bare getSiteUrl + path)', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const store = {
      id: 'store-1',
      slug: 'my-store',
      domain: 'example.com',
    } as unknown as ResolvedStore;

    expect(storeAbsoluteUrl(store, '/products/widget')).toBe('https://example.com/products/widget');
  });

  it('handles a path with no leading slash the same as one with a leading slash', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const store = {
      id: 'store-1',
      slug: 'my-store',
      domain: undefined,
    } as unknown as ResolvedStore;

    expect(storeAbsoluteUrl(store, 'products/widget')).toBe(
      storeAbsoluteUrl(store, '/products/widget')
    );
  });

  it('resolves an empty or "/" path to the bare store root', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const store = {
      id: 'store-1',
      slug: 'my-store',
      domain: undefined,
    } as unknown as ResolvedStore;

    expect(storeAbsoluteUrl(store, '')).toBe('https://my-store.ebda.app');
    expect(storeAbsoluteUrl(store, '/')).toBe('https://my-store.ebda.app/');
  });
});

describe('getSiteUrl / storeAbsoluteUrl with NEXT_PUBLIC_SITE_URL SET (production shape)', () => {
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const PLATFORM = 'https://ebda.app';

  afterEach(() => {
    if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  });

  const storeWithDomain = {
    id: 'store-1',
    slug: 'pecannbee',
    domain: 'pecannbee.com.kw',
  } as unknown as ResolvedStore;

  const platformPathStore = {
    id: 'store-2',
    slug: 'palora',
    domain: undefined,
  } as unknown as ResolvedStore;

  it("a merchant's custom domain WINS over the platform env var", () => {
    process.env.NEXT_PUBLIC_SITE_URL = PLATFORM;
    expect(getSiteUrl(storeWithDomain)).toBe('https://pecannbee.com.kw');
  });

  it('custom-domain canonical stays on the merchant domain (the shipped bug)', () => {
    process.env.NEXT_PUBLIC_SITE_URL = PLATFORM;
    // Regression: this returned https://ebda.app/products/widget —
    // a platform URL with no /<slug> prefix, which resolves to the DEMO store.
    expect(storeAbsoluteUrl(storeWithDomain, '/products/widget')).toBe(
      'https://pecannbee.com.kw/products/widget'
    );
  });

  it('a store with no custom domain gets its own <slug>.ebda.app origin — the env var never wins, no path prefix', () => {
    process.env.NEXT_PUBLIC_SITE_URL = PLATFORM;
    expect(getSiteUrl(platformPathStore)).toBe('https://palora.ebda.app');
    expect(storeAbsoluteUrl(platformPathStore, '/products/widget')).toBe(
      'https://palora.ebda.app/products/widget'
    );
  });

  it('store-less callers (robots.txt, platform pages) still get the platform host', () => {
    process.env.NEXT_PUBLIC_SITE_URL = PLATFORM;
    expect(getSiteUrl()).toBe(PLATFORM);
  });

  it('trims whitespace and a trailing slash on both branches', () => {
    process.env.NEXT_PUBLIC_SITE_URL = `${PLATFORM}/\n`;
    expect(getSiteUrl()).toBe(PLATFORM);
    expect(getSiteUrl({ domain: ' pecannbee.com.kw ' } as ResolvedStore)).toBe(
      'https://pecannbee.com.kw'
    );
  });
});
