/**
 * Characterization of the storefront homepage body (visual builder Phase 1).
 *
 * Written against the PRE-builder `HomePageContent` (hard-coded section
 * sequence) and committed with its snapshots BEFORE the PageRenderer refactor,
 * so the snapshots are the evidence that the refactor changes no output:
 * 6 layout fixtures x 2 stores x 5 templates x 2 languages, server-rendered
 * to static HTML and compared byte-for-byte (`toMatchFileSnapshot`).
 *
 * A layout reaches the component the way production delivers it: the API
 * resolves `stores.layout_settings` against the store's template baseline
 * (`public-store-layout.routes.ts`), and the storefront re-resolves the JSON
 * it receives (`HomePageBody.fetchLayoutSettings`).
 *
 * Mocked: the three client contexts (store, language, cart) — their providers
 * touch `document`/`localStorage` — `next/navigation`, and `ShopChrome`
 * (header/footer chrome is not part of the builder body and has its own
 * render tests). Everything else (5 template packs, shared sections, dividers,
 * spacing/bg/typography helpers) is the real code.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import { resolveLayoutSettings, type TemplateId } from '@force/shared';
import {
  LAYOUT_FIXTURES,
  TEMPLATES,
  STORES,
  PRODUCTS,
  CATEGORIES,
  TESTIMONIALS,
  loadLayoutFixture,
} from '../fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
  store: null as unknown as Record<string, unknown>,
  language: 'en' as 'en' | 'ar',
}));

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ctx.store.theme,
  useStoreTemplate: () => ctx.store.template,
  useIsPlatform: () => false,
  useStoreBranding: () => ({ name: ctx.store.name }),
  useStoreContact: () => ({}),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: ctx.language,
      direction: ctx.language === 'ar' ? 'rtl' : 'ltr',
      isRtl: ctx.language === 'ar',
      setLanguage: () => {},
      t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
    }),
  };
});
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({
    items: [],
    bundles: [],
    itemCount: 0,
    subtotal: 0,
    addItem: () => {},
    removeItem: () => {},
    updateQuantity: () => {},
    clearCart: () => {},
    isOpen: false,
    openCart: () => {},
    closeCart: () => {},
  }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../apps/web/src/components/ShopChrome', () => ({
  ShopChrome: ({ children }: { children?: React.ReactNode }) => (
    <div data-test="shop-chrome">{children}</div>
  ),
}));

const { HomePageContent } = await import('../../apps/web/src/app/HomePageContent');

const SNAP_DIR = path.join(__dirname, '..', 'fixtures', 'builder', '__snapshots__');

function renderHome(
  fixture: (typeof LAYOUT_FIXTURES)[number],
  storeKey: keyof typeof STORES,
  template: TemplateId,
  language: 'en' | 'ar',
  extraProps: Record<string, unknown> = {}
): string {
  ctx.store = { ...STORES[storeKey], template };
  ctx.language = language;
  // API: resolve against the template baseline. Storefront: re-resolve the JSON.
  const apiLayout = resolveLayoutSettings(loadLayoutFixture(fixture), template);
  const layout = resolveLayoutSettings(JSON.parse(JSON.stringify(apiLayout)));
  return renderToStaticMarkup(
    <HomePageContent
      templateId={template}
      featuredProducts={PRODUCTS as never}
      newArrivals={PRODUCTS.slice(0, 2) as never}
      bestSellers={[PRODUCTS[2], PRODUCTS[0]] as never}
      categories={CATEGORIES as never}
      testimonials={TESTIMONIALS}
      extraProducts={PRODUCTS as never}
      storeName={STORES[storeKey].name}
      layout={layout}
      {...extraProps}
    />
  );
}

describe('storefront homepage body: characterization (pins pre-builder output)', () => {
  for (const fixture of LAYOUT_FIXTURES) {
    it(`${fixture}: 2 stores x 5 templates x en/ar render exactly as before`, async () => {
      const parts: string[] = [];
      for (const storeKey of Object.keys(STORES) as Array<keyof typeof STORES>) {
        for (const template of TEMPLATES) {
          for (const language of ['en', 'ar'] as const) {
            const html = renderHome(fixture, storeKey, template, language);
            // Sanity: every render produced a homepage body, not an empty shell.
            expect(html.length).toBeGreaterThan(40);
            parts.push(
              `<!-- ${fixture} | store ${storeKey} | ${template} | ${language} -->\n${html}`
            );
          }
        }
      }
      await expect(parts.join('\n\n') + '\n').toMatchFileSnapshot(
        path.join(SNAP_DIR, `${fixture}.html`)
      );
    });
  }
});
