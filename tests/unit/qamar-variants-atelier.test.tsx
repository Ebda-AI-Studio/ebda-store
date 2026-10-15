import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { storeLayoutSchema, imageTextSchema, getTemplateTheme, getLook } from '@ebda/shared';
import { CATEGORIES, STORES } from '../fixtures/builder/homepage-data';

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
    total: 0,
    addItem: () => {},
    removeItem: () => {},
    updateQuantity: () => {},
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

const { CategoryChips } = await import('../../apps/web/src/templates/shared/CategoryChips');
const { ImageTextSection, FULL_BLEED_SCRIM } =
  await import('../../apps/web/src/builder/sections/ImageTextSection');

describe('category chips', () => {
  it('the layout schema accepts chips (no silent strip)', () => {
    const r = storeLayoutSchema.shape.categories.unwrap().safeParse({
      enabled: true,
      layout: 'chips',
      layoutMobile: 'chips',
      captionPosition: 'below',
      desktopColumns: 4,
      mobileColumns: 2,
    });
    expect(r.success).toBe(true);
  });
  it('renders one link per category, text only, in a scroll row, RTL-safe', () => {
    const html = renderToStaticMarkup(<CategoryChips categories={CATEGORIES} urlPrefix="" isRtl />);
    expect(html.match(/<a /g)?.length).toBe(CATEGORIES.length);
    expect(html).not.toContain('<img');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('snap-x');
    expect(html).not.toMatch(/text-\[\d+px\]/);
    expect(html).toContain('مكسرات');
    expect(html).not.toMatch(/\b(ml|mr|pl|pr)-\d/);
  });
});

describe('image-text full-bleed', () => {
  it('schema accepts layout full-bleed', () => {
    expect(imageTextSchema.safeParse({ layout: 'full-bleed' }).success).toBe(true);
  });
  it('exposes a solid scrim colour and opacity for the contrast test', () => {
    expect(FULL_BLEED_SCRIM).toEqual({ color: '#141414', opacity: 0.88 });
  });
  for (const skin of ['minimal', 'dahab', 'qamar'] as const)
    it(`renders edge to edge with text over a scrim on ${skin}`, () => {
      ctx.store = { ...STORES.A, template: skin, theme: getTemplateTheme(skin) };
      const html = renderToStaticMarkup(
        <ImageTextSection
          settings={{
            layout: 'full-bleed',
            image: 'https://x/a.webp',
            headingAr: 'المجموعة',
            heading: 'Collection',
          }}
        />
      );
      expect(html).toContain('data-layout="full-bleed"');
      expect(html).toContain('w-full');
      expect(html).not.toContain('md:grid-cols-2');
      expect(html).toContain('min-h-[60svh]');
      expect(html).toContain('rgb(20 20 20 / 0.88)');
      expect(html).toContain('data-part="full-bleed-panel"');
      // the photo is never washed: no absolute inset-0 overlay besides the <img> itself
      expect(html.match(/absolute inset-0/g)?.length).toBe(1);
      expect(html).not.toContain('aria-hidden="true"');
      expect(html).toContain('justify-start');
    });
  it('falls back to the split layout without an image', () => {
    ctx.store = { ...STORES.A, template: 'qamar', theme: getTemplateTheme('qamar') };
    const html = renderToStaticMarkup(
      <ImageTextSection settings={{ layout: 'full-bleed', heading: 'Hi' }} />
    );
    expect(html).not.toContain('data-layout="full-bleed"');
  });
});

describe('Atelier mix', () => {
  it('uses chips for categories and a full-bleed image break', () => {
    const mix = getLook('qamar.atelier')!.sections!;
    expect(mix.find(x => x.type === 'category-grid')?.design).toEqual({
      layout: 'chips',
      layoutMobile: 'chips',
      // STOP 1 critique (B1-26): a chip row sits right under the hero, not in 200px of air.
      paddingTop: 'tight',
      paddingBottom: 'none',
    });
    expect(mix.find(x => x.type === 'image-text')?.design).toEqual({ layout: 'full-bleed' });
  });
});
