import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import {
  resolveLayoutSettings,
  layoutToDefinition,
  reduceDocument,
  type TemplateId,
} from '@force/shared';
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

const _SNAP_DIR = path.join(__dirname, '..', 'fixtures', 'builder', '__snapshots__');

function renderHome(
  fixture: (typeof LAYOUT_FIXTURES)[number],
  storeKey: keyof typeof STORES,
  template: TemplateId,
  language: 'en' | 'ar',
  extraProps: Record<string, unknown> = {}
): string {
  ctx.store = { ...STORES[storeKey], template, look: ctx.look };
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

describe('home page: unset section spacing is marked on look stores only', () => {
  const marked = (html: string, section: string) => {
    const m = html.match(new RegExp(`<section[^>]*data-section="${section}"[^>]*>`));
    expect(m, section).not.toBeNull();
    return m![0];
  };
  for (const section of ['testimonials', 'categories', 'newArrivals', 'bestSellers']) {
    it(`${section}: marker on a look store, absent on a legacy store`, () => {
      ctx.look = 'qamar.atelier';
      const lookHtml = renderHome('pecannbee-flow', 'A', 'modern', 'en');
      ctx.look = null;
      const legacyHtml = renderHome('pecannbee-flow', 'A', 'modern', 'en');
      expect(marked(lookHtml, section)).toContain('sp-top-default');
      expect(marked(legacyHtml, section)).not.toContain('sp-');
    });
  }
});

describe('home page: a stored look id that is not registered renders as legacy', () => {
  it('no spacing markers, markup byte-identical to a store with no look', () => {
    ctx.look = 'qamar.removed';
    const unknown = renderHome('pecannbee-flow', 'A', 'modern', 'en');
    ctx.look = null;
    const legacy = renderHome('pecannbee-flow', 'A', 'modern', 'en');
    expect(unknown).not.toContain('sp-top-default');
    expect(unknown).toBe(legacy);
  });
});
