/**
 * Phase B5 Task 1: characterisation of the OLD Dahab skin, written BEFORE any edit.
 *
 * Markup is serialised with `class` and `style` attributes stripped, so the re-skin of Task 2
 * (arch frames, gold rule, fonts, tokens) may change every class and still be held to the same
 * DOM: tags, text, aria, hrefs, order. After Task 2 the snapshots must be identical except for the
 * short ALLOWLIST at the bottom of this file (a deliberate markup removal, named with a reason).
 * The behavioural checks do not depend on markup at all.
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
  type PageDefinition,
} from '@ebda/shared';
import { STORES, PRODUCTS, CATEGORIES, TESTIMONIALS } from '../fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
  store: null as unknown as Record<string, unknown>,
  language: 'en' as 'en' | 'ar',
  items: [] as Array<Record<string, unknown>>,
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
    items: ctx.items,
    bundles: [],
    itemCount: ctx.items.length,
    total: ctx.items.reduce((s, i) => s + (i.price as number) * (i.quantity as number), 0),
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
const { default: DahabHeader } = await import('../../apps/web/src/templates/dahab/Header');
const { default: DahabFooter } = await import('../../apps/web/src/templates/dahab/Footer');
const { DahabCartDrawer } = await import('../../apps/web/src/templates/dahab/CartDrawer');
const { default: DahabProductCard } =
  await import('../../apps/web/src/templates/dahab/ProductCard');

const SNAP_DIR = path.join(__dirname, '__snapshots__');
const IMG = 'https://media.example/dahab';

/** Serialise with class and style stripped (the DOM the re-skin must preserve). */
export function stripPaint(html: string): string {
  return html
    .replace(/\sclass="[^"]*"/g, '')
    .replace(/\sstyle="[^"]*"/g, '')
    .replace(/></g, '>\n<');
}

function setCtx(language: 'en' | 'ar') {
  ctx.store = { ...STORES.A, template: 'dahab', theme: getTemplateTheme('dahab') };
  ctx.language = language;
}

function homeDoc(): PageDefinition {
  const base = layoutToDefinition(resolveLayoutSettings({}, 'dahab'));
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
          id: 's1',
          type: 'slide',
          settings: {
            image: `${IMG}/h1.webp`,
            headline: 'Gold you live in',
            headlineAr: 'دهب يتلبس كل يوم',
            ctaText: 'Shop',
            ctaTextAr: 'تسوق',
            ctaHref: '/products',
          },
        },
      ]),
      node('collection-list', 'cols', { heading: 'Collections', headingAr: 'مجموعات' }, [
        {
          id: 'c1',
          type: 'collection',
          settings: { categorySlug: 'nuts', image: `${IMG}/c1.webp` },
        },
      ]),
      node('featured-collection', 'new', {
        heading: 'New',
        headingAr: 'جديد',
        productSource: 'newest',
        limit: 4,
        columns: 4,
      }),
      node('testimonials', 't', { title: 'Words', titleAr: 'قالوا' }),
    ],
  };
}

const baseDetail = {
  images: [
    { id: 'i1', url: `${IMG}/r1.webp`, alt: 'Ring' },
    { id: 'i2', url: `${IMG}/r2.webp` },
  ],
  categoryHref: '/products?category=rings',
  homeHref: '/',
  productsHref: '/products',
  shippingHref: '/shipping',
  returnsHref: '/returns',
  excerpt: 'A single brilliant.',
  description: 'Four claws on a slim band.',
  compareText: null,
  badges: ['New'],
  onVariantSelect: () => {},
  onShopperSelect: () => {},
  quantity: 1,
  setQuantity: () => {},
  maxQuantity: 10,
  onAddToCart: () => {},
  isAdding: false,
  addDisabled: false,
  isWishlisted: false,
  onToggleWishlist: () => {},
  sku: 'DH-01',
  selectedImage: 0,
  onSelectImage: () => {},
};
const variants = [
  { id: 'v1', price: 1875000, inventory: 3, options: { Metal: 'Silver', Size: '52' } },
  { id: 'v2', price: 1940000, inventory: 0, options: { Metal: 'Rose gold', Size: '52' } },
] as never;
const options = [
  {
    name: 'Metal',
    nameAr: 'المعدن',
    values: [
      { value: 'Silver', valueAr: 'فضة' },
      { value: 'Rose gold', valueAr: 'ذهب وردي' },
    ],
  },
] as never;

function pdp(language: 'en' | 'ar', extra: Record<string, unknown> = {}) {
  setCtx(language);
  return renderToStaticMarkup(
    <DahabProductDetail
      {...baseDetail}
      name={language === 'ar' ? 'خاتم سوليتير' : 'Solitaire ring'}
      categoryName={language === 'ar' ? 'خواتم' : 'Rings'}
      priceText={language === 'ar' ? '18,750 ج.م' : 'EGP 18,750'}
      variants={variants}
      options={options}
      addLabel={language === 'ar' ? 'إضافة للسلة' : 'Add to bag'}
      {...(extra as object)}
    />
  );
}

const snapshotAll = async (name: string, render: (l: 'en' | 'ar') => string) => {
  const parts = (['ar', 'en'] as const).map(l => `<!-- ${l} -->\n${stripPaint(render(l))}`);
  await expect(parts.join('\n\n') + '\n').toMatchFileSnapshot(path.join(SNAP_DIR, name));
};

describe('Dahab characterisation (class and style stripped)', () => {
  it('home document: hero, collection tiles, product cards, testimonials', async () => {
    await snapshotAll('dahab-characterization.home.snap', l => {
      setCtx(l);
      return renderToStaticMarkup(
        <HomePageContent
          templateId="dahab"
          featuredProducts={PRODUCTS as never}
          newArrivals={PRODUCTS as never}
          bestSellers={PRODUCTS as never}
          categories={CATEGORIES as never}
          testimonials={TESTIMONIALS}
          extraProducts={PRODUCTS as never}
          storeName="Dahab"
          layout={resolveLayoutSettings({}, 'dahab')}
          definition={homeDoc()}
        />
      );
    });
  });

  it('PDP: swatch option, facts, lead time, personalisation, size chart slot, media slot', async () => {
    await snapshotAll('dahab-characterization.pdp.snap', l =>
      pdp(l, {
        facts: [
          { label: 'Karat', labelAr: 'العيار', value: '21', valueAr: '21', onCard: true },
          { label: 'Width', labelAr: 'العرض', value: '4 mm', valueAr: '4 مم', onCard: true },
        ],
        leadTimeDays: 5,
        personalisation: {
          enabled: true,
          label: 'Letters',
          labelAr: 'الحروف',
          maxLength: 12,
          required: true,
        },
        note: 'AB',
        onNoteChange: () => {},
        mediaSlot: <div data-test="media-slot">3d</div>,
        stockText: l === 'ar' ? 'متاح' : 'In stock',
      })
    );
  });

  it('PDP: backorder shows the pre-order label and out-of-stock disables add', () => {
    const preorder = pdp('en', { addLabel: 'Pre-order', stockText: 'Made to order' });
    expect(preorder).toContain('Pre-order');
    const oos = pdp('en', { addDisabled: true, addLabel: 'Sold out' });
    expect(oos).toMatch(/disabled/);
  });

  it('pinned buy bar label equals the main button label', () => {
    const html = pdp('en', { addLabel: 'Add to bag' });
    expect((html.match(/Add to bag/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('PDP quantity is clamped to maxQuantity in the rendered controls', () => {
    const html = pdp('en', { quantity: 10, maxQuantity: 10 });
    expect(html).toMatch(/disabled=""[^>]*>(?:(?!<\/button>).)*<svg/s);
  });

  it('header (menu + bag), footer and the bag drawer with two lines', async () => {
    ctx.items = [
      {
        id: 'l1',
        productId: 'p1',
        name: 'Ring',
        price: 100000,
        quantity: 1,
        image: `${IMG}/r1.webp`,
        note: 'AB',
        variantName: 'Silver / 52',
        maxQuantity: 5,
      },
      {
        id: 'l2',
        productId: 'p2',
        name: 'Chain',
        price: 250000,
        quantity: 2,
        image: `${IMG}/r2.webp`,
        maxQuantity: 5,
      },
    ];
    await snapshotAll('dahab-characterization.chrome.snap', l => {
      setCtx(l);
      const branding = { name: 'Dahab', nameAr: 'دهب' };
      return [
        renderToStaticMarkup(
          <DahabHeader
            branding={branding}
            navigation={
              [{ label: 'Rings', labelAr: 'خواتم', href: '/products?category=rings' }] as never
            }
            cartItemCount={2}
          />
        ),
        renderToStaticMarkup(
          <DahabFooter
            branding={branding}
            contact={{ email: 'a@b.co' } as never}
            socials={{} as never}
            navigation={[]}
          />
        ),
        renderToStaticMarkup(<DahabCartDrawer open onClose={() => {}} urlPrefix="" />),
      ].join('\n');
    });
    ctx.items = [];
  });

  it('product card: sale, fact chips, swatches', async () => {
    await snapshotAll('dahab-characterization.card.snap', l => {
      setCtx(l);
      const product = {
        ...PRODUCTS[0],
        compareAtPrice: (PRODUCTS[0] as { price: number }).price + 5000,
        facts: [
          { label: 'Karat', labelAr: 'العيار', value: '21', valueAr: '21', onCard: true },
          { label: 'Width', labelAr: 'العرض', value: '4 mm', valueAr: '4 مم', onCard: true },
        ],
      };
      return renderToStaticMarkup(
        <DahabProductCard product={product as never} isRtl={l === 'ar'} />
      );
    });
  });
});

/**
 * ALLOWLIST for Task 2 (deliberate markup differences after the re-skin). Empty until Task 2
 * names an entry here with a reason; a snapshot change outside this list is a bug in the code.
 */
export const ALLOWLIST: string[] = [];
