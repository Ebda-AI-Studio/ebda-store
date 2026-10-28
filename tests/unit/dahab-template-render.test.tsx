/**
 * Dahab template (builder Phase 3 pilot): render snapshots for the four new
 * builder sections and the Dahab skin, server-rendered to static HTML.
 *
 *  - the Dahab home document (hero slides, collection list, featured grid,
 *    image-with-text, product spotlight, testimonials, trust badges,
 *    newsletter) on the `dahab` skin, Arabic and English;
 *  - the same new sections on the `qamar` skin (they are platform sections,
 *    so they must render on every skin);
 *  - the Dahab product page presentation component.
 *
 * Same mocking as the homepage characterization test (store / language /
 * cart contexts, next/navigation, ShopChrome); everything else is real.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import {
  getTemplateTheme,
  layoutToDefinition,
  resolveLayoutSettings,
  sectionFromPreset,
  validateDefinitionSync,
  type PageDefinition,
  type TemplateId,
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

const { HomePageContent } = await import('../../apps/web/src/app/HomePageContent');
const { DahabProductDetail } = await import('../../apps/web/src/templates/dahab/ProductDetail');

const SNAP_DIR = path.join(__dirname, '..', 'fixtures', 'builder', '__snapshots__');
const IMG = 'https://media.example/dahab';

/** The Dahab demo composition (scripts/dahab-demo/seed-dahab.mjs) on fixture data. */
function dahabDocument(template: TemplateId): PageDefinition {
  const layout = resolveLayoutSettings({}, template);
  const base = layoutToDefinition(layout);
  const node = (
    type: string,
    id: string,
    settings: Record<string, unknown>,
    blocks?: unknown[]
  ) => {
    const n = sectionFromPreset(type, 0, id);
    n.settings = { ...n.settings, ...settings };
    if (blocks) n.blocks = blocks as never;
    return n;
  };
  return {
    ...base,
    sections: [
      node('hero', 'hero', { mode: 'slider' }, [
        {
          id: 'slide-1',
          type: 'slide',
          settings: {
            image: `${IMG}/hero-1.webp`,
            imageMobile: `${IMG}/hero-1-mobile.webp`,
            headline: 'Gold you live in',
            headlineAr: 'دهب يتلبس كل يوم',
            ctaText: 'Shop the collection',
            ctaTextAr: 'تسوق المجموعة',
            ctaHref: '/products',
          },
        },
        {
          id: 'slide-2',
          type: 'slide',
          settings: {
            image: `${IMG}/hero-2.webp`,
            headline: 'Fine chains',
            headlineAr: 'سلاسل رفيعة',
          },
        },
      ]),
      node(
        'collection-list',
        'collections',
        { heading: 'Shop by collection', headingAr: 'تسوق حسب المجموعة' },
        [
          {
            id: 'c1',
            type: 'collection',
            settings: { categorySlug: 'nuts', image: `${IMG}/c1.webp` },
          },
          {
            id: 'c2',
            type: 'collection',
            settings: { categorySlug: 'dates', label: 'Dates', labelAr: 'تمور' },
          },
          {
            id: 'c3',
            type: 'collection',
            settings: { categorySlug: 'not-in-store', label: 'Gone' },
          },
        ]
      ),
      node('featured-collection', 'new-in', {
        heading: 'New in',
        headingAr: 'وصل حديثاً',
        productSource: 'newest',
        limit: 4,
        columns: 4,
      }),
      node('image-text', 'craft', {
        image: `${IMG}/craft.webp`,
        heading: 'Made at the bench',
        headingAr: 'شغل إيد',
      }),
      node('product-spotlight', 'gifts', {
        image: `${IMG}/gifts.webp`,
        heading: 'Gift ideas',
        headingAr: 'أفكار للهدايا',
        productSource: 'manual',
        manualProductIds: [PRODUCTS[2].id, PRODUCTS[0].id],
        limit: 3,
        imagePosition: 'end',
      }),
      node('testimonials', 'testimonials', { title: 'In their words', titleAr: 'قالوا عننا' }),
      node('trust-badges', 'trust', {}),
      node('newsletter', 'newsletter', {}),
    ],
  };
}

function renderDoc(template: TemplateId, language: 'en' | 'ar'): string {
  ctx.store = {
    ...STORES.A,
    template,
    theme: template === 'dahab' ? getTemplateTheme('dahab') : STORES.A.theme,
  };
  ctx.language = language;
  const layout = resolveLayoutSettings({}, template);
  const def = dahabDocument(template);
  return renderToStaticMarkup(
    <HomePageContent
      templateId={template}
      featuredProducts={PRODUCTS as never}
      newArrivals={PRODUCTS as never}
      bestSellers={PRODUCTS as never}
      categories={CATEGORIES as never}
      testimonials={TESTIMONIALS}
      extraProducts={PRODUCTS as never}
      storeName="Dahab"
      layout={layout}
      definition={def}
    />
  );
}

describe('Dahab home document', () => {
  it('is a valid PageDefinition (the editor and the API accept it)', () => {
    for (const t of ['dahab', 'qamar'] as const) {
      const res = validateDefinitionSync(JSON.parse(JSON.stringify(dahabDocument(t))));
      expect(res.errors).toEqual([]);
    }
  });

  for (const template of ['dahab', 'qamar'] as const) {
    it(`renders every new section on the ${template} skin (en + ar snapshot)`, async () => {
      const parts: string[] = [];
      for (const language of ['ar', 'en'] as const) {
        const html = renderDoc(template, language);
        for (const section of [
          'collection-list',
          'featured-collection',
          'product-spotlight',
          'trust-badges',
        ])
          expect(html).toContain(`data-section="${section}"`);
        // Western digits by default (Ruling NUMERALS-1): no Arabic-Indic digit anywhere.
        expect(html).not.toMatch(/[٠-٩]/);
        parts.push(`<!-- ${template} | ${language} -->\n${html}`);
      }
      await expect(parts.join('\n\n') + '\n').toMatchFileSnapshot(
        path.join(SNAP_DIR, `dahab-sections-${template}.html`)
      );
    });
  }

  it('Dahab skin: its own cards, rectangular tiles (no arch), hero and testimonials', () => {
    const html = renderDoc('dahab', 'ar');
    expect(html).toContain('data-pack-card="dahab"');
    // Ruling B5-3: the arch frame and the drawn hero rule are retired with the old skin.
    expect(html).not.toContain('rounded-t-[999px]');
    expect(html).not.toContain('dahab-hero-copy');
    expect(html).not.toContain('dahab-draw');
    expect(html).toContain('دهب يتلبس كل يوم');
    // The "Featured products" fallback is not appended under a document that already shows products.
    expect(html).not.toContain('منتجات مميزة');
  });

  it('a tile pointing at a category the store does not have opens the full catalogue', () => {
    const html = renderDoc('dahab', 'en');
    expect(html).toMatch(/href="\/products"[^>]*>(?:(?!<\/a>).)*Gone/s);
    expect(html).toContain('href="/products?category=nuts"');
  });

  it('hand-picked spotlight products keep their order', () => {
    const html = renderDoc('qamar', 'en');
    const spot = html.slice(html.indexOf('data-section="product-spotlight"'));
    expect(spot.indexOf(PRODUCTS[2].slug)).toBeLessThan(spot.indexOf(PRODUCTS[0].slug));
  });
});

describe('Dahab product page presentation', () => {
  it('renders gallery, price, swatches, accordions and the pinned buy bar (en + ar snapshot)', async () => {
    const parts: string[] = [];
    for (const language of ['ar', 'en'] as const) {
      ctx.store = { ...STORES.A, template: 'dahab', theme: getTemplateTheme('dahab') };
      ctx.language = language;
      const html = renderToStaticMarkup(
        <DahabProductDetail
          images={[
            { id: 'i1', url: `${IMG}/ring-1.webp`, alt: 'Ring' },
            { id: 'i2', url: `${IMG}/ring-2.webp` },
          ]}
          name={language === 'ar' ? 'خاتم سوليتير' : 'Solitaire ring'}
          categoryName={language === 'ar' ? 'خواتم' : 'Rings'}
          categoryHref="/products?category=rings"
          homeHref="/"
          productsHref="/products"
          shippingHref="/shipping"
          returnsHref="/returns"
          excerpt="A single brilliant."
          description="Four claws on a slim 18K band."
          priceText={language === 'ar' ? '18,750 ج.م' : 'EGP 18,750'}
          compareText={null}
          badges={['New']}
          variants={
            [
              { id: 'v1', price: 1875000, inventory: 3, options: { Colour: 'Yellow gold' } },
              { id: 'v2', price: 1940000, inventory: 0, options: { Colour: 'White gold' } },
            ] as never
          }
          options={
            [
              {
                name: 'Colour',
                nameAr: 'اللون',
                values: [
                  { value: 'Yellow gold', valueAr: 'ذهب أصفر' },
                  { value: 'White gold', valueAr: 'ذهب أبيض' },
                ],
              },
            ] as never
          }
          onVariantSelect={() => {}}
          onShopperSelect={() => {}}
          quantity={1}
          setQuantity={() => {}}
          maxQuantity={10}
          onAddToCart={() => {}}
          isAdding={false}
          addDisabled={false}
          addLabel={language === 'ar' ? 'إضافة للسلة' : 'Add to bag'}
          isWishlisted={false}
          onToggleWishlist={() => {}}
          sku="DH-01"
          selectedImage={0}
          onSelectImage={() => {}}
        />
      );
      expect(html).toContain('<details');
      expect(html).toContain('aria-pressed');
      expect(html).not.toMatch(/[٠-٩]/);
      // useId is a process-wide counter: normalise it so the snapshot does not depend on test order.
      parts.push(`<!-- pdp | ${language} -->\n${html.replace(/:R[0-9a-z]+:/g, ':R:')}`);
    }
    await expect(parts.join('\n\n') + '\n').toMatchFileSnapshot(
      path.join(SNAP_DIR, 'dahab-pdp.html')
    );
  });
});
