import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLATFORM_MARKETING_URL } from '../../apps/web/src/lib/platform';

// generateMetadata harness (same shape as storefront-head-metadata.test.ts); the builder is a spy
// around the real one so the platform sentinel test can prove it never reaches it.
const h = vi.hoisted(() => ({ builder: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => (k === 'host' ? 'ebda.app' : null) }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('next/font/google', () => {
  const font = () => ({ className: 'f', variable: '--f', style: { fontFamily: 'f' } });
  return { Plus_Jakarta_Sans: font, IBM_Plex_Sans_Arabic: font, Amiri: font, Marcellus: font };
});
vi.mock('../../apps/web/src/lib/store-resolver', async importOriginal => ({
  ...(await importOriginal<typeof import('../../apps/web/src/lib/store-resolver')>()),
  getStore: async () => ({ id: 'demo', slug: 'demo', name: 'Force', settings: {} }),
}));
vi.mock('../../apps/web/src/lib/storefront-metadata', async importOriginal => {
  const real = await importOriginal<typeof import('../../apps/web/src/lib/storefront-metadata')>();
  return {
    ...real,
    buildStorefrontMetadata: (...a: Parameters<typeof real.buildStorefrontMetadata>) => {
      h.builder();
      return real.buildStorefrontMetadata(...a);
    },
  };
});

const web = (p: string) => readFileSync(resolve(__dirname, '../../apps/web/src', p), 'utf8');

/**
 * The platform host (`ebda.app`) sends its bare root to the marketing
 * site instead of serving a second marketing page of its own.
 *
 * The rule these guard is a TENANT-ISOLATION rule, not a styling one: a
 * merchant's customer must never be moved from that merchant's storefront onto
 * the Ebda pitch (which links to competitors' stores). So the marketing URL
 * is allowed on exactly two surfaces — the bare-root branch and the platform
 * 404 — and nowhere a merchant's customer can reach.
 */
describe('platform root redirect', () => {
  it('points at the marketing site, not a merchant or platform host', () => {
    expect(PLATFORM_MARKETING_URL).toBe('https://ebda.app');
    expect(PLATFORM_MARKETING_URL).not.toMatch(new RegExp('store\\.' + 'for' + 'ce-ai\\.co'));
  });

  it('redirects the bare-root sentinel instead of rendering a landing page', () => {
    const src = web('app/HomePageBody.tsx');
    expect(src).toMatch(/if \(store\.id === 'demo'\) \{\s*redirect\(PLATFORM_MARKETING_URL\);/);
    // The platform landing must no longer render on this host.
    expect(src).not.toMatch(/<EditorialLanding/);
  });

  it('keeps the merchant 404 branded and free of the platform pitch', () => {
    const src = web('app/not-found.tsx');
    // Store context still gets the merchant's own not-found …
    expect(src).toMatch(
      /if \(notFoundKind\(storeDomain, store\) === 'store'\) \{\s*return <StoreNotFound store=\{store\} \/>;/
    );
    // … and the platform landing is gone from the 404 path entirely.
    expect(src).not.toMatch(/EditorialLanding/);
    expect(src).toMatch(/<UnknownHostNotFound /);
  });

  it('never lets a merchant-facing component link to the platform pitch', () => {
    // Comments are where this rule is DOCUMENTED (StoreNotFound explains it),
    // so strip them first — otherwise the guard fires on its own documentation
    // and has to be weakened, which is how a real check turns into a dead one.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const merchantSurfaces = [
      'components/StoreNotFound.tsx',
      'components/StoreNotFoundBody.tsx',
      'app/HomePageContent.tsx',
    ];
    for (const file of merchantSurfaces) {
      const code = stripComments(web(file));
      expect(code, `${file} imports the platform pitch URL`).not.toContain(
        'PLATFORM_MARKETING_URL'
      );
      expect(code, `${file} links out to ebda.app`).not.toMatch(new RegExp('for' + 'ce-ai\\.co'));
    }
  });

  it('serves a real 404, not a redirect, for an unknown slug', () => {
    // A redirect on a non-existent URL is a soft-404. UnknownHostNotFound renders;
    // it must not call redirect().
    const src = web('components/UnknownHostNotFound.tsx');
    expect(src).not.toContain('redirect(');
    expect(web('lib/unknown-store-page.ts')).toContain('BRAND_MARKETING_URL');
  });

  it('titles the platform sentinel as a 404, not as a merchant store', async () => {
    // DEFAULT_STORE is named "Force", so the shared storefront metadata builder
    // produced "Force - Online Shopping in Egypt" — a merchant title for a
    // store that does not exist, on a page whose body is a 404. The tab kept
    // making a promise the page had stopped making.
    // Behaviour: run the real generateMetadata for the sentinel store.
    const { generateMetadata } = await import('../../apps/web/src/app/layout');
    const meta = await generateMetadata();
    expect(String(meta.title)).toMatch(/^Page not found — /);
    expect(meta.robots).toEqual({ index: false, follow: false });
    // It must short-circuit BEFORE the storefront builder, not after (the builder is never reached).
    expect(h.builder).not.toHaveBeenCalled();
  });
});
