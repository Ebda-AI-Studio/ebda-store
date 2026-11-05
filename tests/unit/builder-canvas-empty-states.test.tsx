/**
 * Mobile-editor bugs 2 and 3: an image-less hero slide shows a deliberate placeholder in the editor (and
 * nothing publicly), and an empty product section carries its explanation and an add-products link in
 * the editor only.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';
import { PRODUCTS, CATEGORIES, TESTIMONIALS } from '../fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
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
  useCart: () => ({ addItem: () => {} }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { PageRenderer } = await import('../../apps/web/src/builder/render/PageRenderer');
const { ImageTextSection } = await import('../../apps/web/src/builder/sections/ImageTextSection');
const { translations } = await import('../../apps/web/src/contexts/LanguageContext');

const FRESH_STORE = {
  id: 'fresh',
  name: 'Fresh Store',
  nameAr: 'متجر جديد',
  template: 'qamar',
  theme: {},
  currency: 'EGP',
  blogEnabled: false,
  description: null,
  descriptionAr: null,
  heroImage: null,
};

const heroLayout = (slides: unknown[]) =>
  resolveLayoutSettings(
    { hero: { enabled: true, mode: 'slider', slides }, newArrivals: { enabled: true } } as never,
    'qamar'
  );

function render(opts: { slides?: unknown[]; editorMode?: boolean; products?: boolean }) {
  ctx.store = FRESH_STORE;
  ctx.language = 'ar';
  return renderToStaticMarkup(
    <PageRenderer
      definition={layoutToDefinition(heroLayout(opts.slides ?? []))}
      templateId="qamar"
      featuredProducts={[] as never}
      newArrivals={(opts.products ? PRODUCTS.slice(0, 2) : []) as never}
      bestSellers={[] as never}
      categories={CATEGORIES as never}
      testimonials={TESTIMONIALS}
      editorMode={opts.editorMode}
    />
  );
}

describe('hero slide without a picture (bug 2)', () => {
  const noImage = [{ headline: 'x' }, {}];
  it('editor: a placeholder that selects the first slide, with no empty button', () => {
    const html = render({ slides: noImage, editorMode: true });
    expect(html).toContain('data-empty-section="hero"');
    expect(html).toContain(translations['Add a picture to this slide']);
    expect(html).toContain('data-builder-block="slide-1"');
    expect(html).not.toContain('data-cta="button"');
  });
  it('storefront: no placeholder and no slide markup', () => {
    const html = render({ slides: noImage });
    expect(html).not.toContain('data-empty-section="hero"');
    expect(html).not.toContain('data-cta="button"');
  });
  it('a slide with a picture is not replaced by the placeholder', () => {
    const html = render({
      slides: [{ image: 'https://cdn.example.com/a.jpg', alt: 'a' }],
      editorMode: true,
    });
    expect(html).not.toContain('data-empty-section="hero"');
  });
});

describe('new arrivals with no products (bug 3)', () => {
  it('editor: the explanation, the editor-only note and an add-products link', () => {
    const html = render({ editorMode: true });
    expect(html).toContain('data-empty-section="newArrivals"');
    expect(html).toContain(translations['Add products and your newest ones will appear here.']);
    expect(html).toContain(
      translations['Only you see this in the editor. Visitors do not see an empty section.']
    );
    expect(html).toMatch(/data-builder-action="open-admin"[^>]*data-builder-target="products"/);
  });
  it('storefront: the section and the link are absent', () => {
    const html = render({});
    expect(html).not.toContain('data-section="newArrivals"');
    expect(html).not.toContain('data-empty-section');
    expect(html).not.toContain('open-admin');
  });
  it('with products there is no hint', () => {
    expect(render({ editorMode: true, products: true })).not.toContain(
      'data-empty-section="newArrivals"'
    );
  });
});
