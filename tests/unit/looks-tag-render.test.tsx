import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  resolveLayoutSettings,
  layoutToDefinition,
  sectionFromPreset,
  type PageDefinition,
} from '@ebda/shared';
import { STORES, PRODUCTS, CATEGORIES, TESTIMONIALS } from '../fixtures/builder/homepage-data';

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

/** A page with one image-text section per Qamar look plus an untagged one (C10). */
function taggedPage(): PageDefinition {
  const page = layoutToDefinition(resolveLayoutSettings({}, 'qamar', null));
  const it = (id: string, heading: string, lookTag?: string) => {
    const n = sectionFromPreset('image-text', 0, id);
    n.settings = { ...n.settings, heading, headingAr: heading, image: 'https://x/a.webp' };
    return lookTag ? { ...n, lookTag } : n;
  };
  return {
    ...page,
    sections: [
      ...page.sections,
      it('story-atelier', 'Atelier story', 'qamar.atelier'),
      it('story-lookbook', 'Lookbook story', 'qamar.lookbook'),
      it('story-all', 'Everyone story'),
    ],
  };
}

function render(look: string | null): string {
  ctx.store = { ...STORES.A, template: 'qamar', look };
  ctx.language = 'en';
  const layout = resolveLayoutSettings({}, 'qamar', look);
  return renderToStaticMarkup(
    <HomePageContent
      templateId="qamar"
      featuredProducts={PRODUCTS as never}
      newArrivals={PRODUCTS.slice(0, 2) as never}
      bestSellers={[PRODUCTS[2], PRODUCTS[0]] as never}
      categories={CATEGORIES as never}
      testimonials={TESTIMONIALS}
      extraProducts={PRODUCTS as never}
      storeName={STORES.A.name}
      layout={layout}
      definition={taggedPage()}
    />
  );
}

describe('page renderer: lookTag sections render only under their look (C10)', () => {
  it("under a look with a mix: its own tagged section and the untagged ones, never another look's", () => {
    const html = render('qamar.atelier');
    expect(html).toContain('Atelier story');
    expect(html).toContain('Everyone story');
    expect(html).not.toContain('Lookbook story');
  });

  it('under a look with no mix, or no look: every section renders as before', () => {
    for (const look of ['souq.catalogue', null]) {
      const html = render(look);
      expect(html, String(look)).toContain('Atelier story');
      expect(html, String(look)).toContain('Lookbook story');
      expect(html, String(look)).toContain('Everyone story');
    }
  });
});
