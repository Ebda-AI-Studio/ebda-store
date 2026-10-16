/**
 * Phase B1 Task 7 — Lookbook: the collage hero (hero `presentation: 'collage'`), the new
 * document-only `shop-the-look` section, its catalogue refs (C11) and the Lookbook mix.
 * Both variants are platform sections (Ruling B1-2): they render on every skin.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  shopTheLookSchema,
  shopTheLookBlockSchema,
  storeLayoutSchema,
  getLook,
  getSectionDefinition,
  sectionFromPreset,
  collectRefs,
  validateDefinition,
  validateDefinitionSync,
  PAGE_DEFINITION_SCHEMA_VERSION,
  LOOK_DESIGN_KEYS,
  type PageDefinition,
} from '@ebda/shared';
import { PRODUCTS, STORES } from '../fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
  store: null as unknown as Record<string, unknown>,
  language: 'ar' as 'en' | 'ar',
}));

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ctx.store.theme,
  useStoreTemplate: () => ctx.store.template,
  useStoreNumerals: () => undefined,
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

const { HeroCollage, HERO_COLLAGE_TEXT_PANEL } =
  await import('../../apps/web/src/templates/shared/HeroCollage');
const { ShopTheLookSection } =
  await import('../../apps/web/src/builder/sections/ShopTheLookSection');

const setStore = (template = 'qamar', language: 'ar' | 'en' = 'ar') => {
  ctx.language = language;
  ctx.store = { ...STORES.A, template, look: null, currency: 'EGP', theme: {} };
};
setStore();

const slides = [1, 2, 3].map(i => ({
  image: `https://x/${i}.webp`,
  alt: `look ${i}`,
  headlineAr: 'لوك الأسبوع',
  headline: 'Look of the week',
  ctaText: 'Shop the looks',
  ctaTextAr: 'تسوّق اللوكات',
  ctaHref: '/products',
}));

const look = (productIds: string[], extra: Record<string, unknown> = {}) => ({
  id: `l-${productIds.join('-')}`,
  type: 'look',
  settings: {
    image: 'https://x/l.webp',
    titleAr: 'لوك الكتان',
    title: 'Linen',
    productIds,
    ...extra,
  },
});
const render = (blocks: unknown[], settings: Record<string, unknown> = {}, products = PRODUCTS) =>
  renderToStaticMarkup(
    <ShopTheLookSection
      settings={{ headingAr: 'تسوّق اللوك', heading: 'Shop the look', ...settings }}
      blocks={blocks as any}
      products={products as any}
    />
  );

describe('hero collage', () => {
  it('schema accepts presentation collage (no silent strip)', () => {
    const hero = storeLayoutSchema.shape.hero.unwrap();
    const r = hero.safeParse({
      enabled: true,
      mode: 'single',
      autoplayMs: 5000,
      presentation: 'collage',
      slides: [],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.presentation).toBe('collage');
  });

  it('the registry offers collage as a hero presentation', () => {
    const sel = getSectionDefinition('hero')!.settings.find(s => s.id === 'presentation')!;
    expect((sel as { options: { value: string }[] }).options.map(o => o.value)).toContain(
      'collage'
    );
  });

  it('renders three overlapping photos and one headline; first image is eager (LCP)', () => {
    const html = renderToStaticMarkup(<HeroCollage slides={slides} isRtl urlPrefix="" />);
    expect(html.match(/<img /g)?.length).toBe(3);
    expect(html.match(/<h1/g)?.length).toBe(1);
    expect(html).toMatch(
      /loading="eager"[^>]*fetchpriority="high"|fetchpriority="high"[^>]*loading="eager"/i
    );
    expect(html.match(/loading="lazy"/g)?.length).toBe(2);
    expect(html).toContain('data-collage-settle');
    expect(html).toContain('لوك الأسبوع');
    // Every photo goes through the image pipeline with `sizes` (quality bar §5).
    expect(html.match(/sizes="/g)?.length).toBe(3);
  });

  it('never nests a second hero section (the renderer wrapper owns data-section="hero")', () => {
    const html = renderToStaticMarkup(<HeroCollage slides={slides} isRtl urlPrefix="" />);
    expect(html).not.toContain('data-section="hero"');
    expect(html).toContain('data-presentation="collage"');
  });

  it('CTA is a real link with the store prefix; whole-collage link via HeroBannerLink', () => {
    const html = renderToStaticMarkup(
      <HeroCollage
        slides={[{ ...slides[0], link: '/collections/x' }, slides[1], slides[2]]}
        isRtl={false}
        urlPrefix="/s/demo"
      />
    );
    expect(html).toContain('href="/s/demo/products"');
    expect(html).toContain('Shop the looks');
    expect(html).toContain('href="/s/demo/collections/x"'); // stretched banner link
    expect(html).not.toMatch(/javascript:/);
  });

  it('the headline sits on the opaque text panel, never over a photo (C28)', () => {
    const html = renderToStaticMarkup(<HeroCollage slides={slides} isRtl urlPrefix="" />);
    expect(HERO_COLLAGE_TEXT_PANEL).toEqual({ token: 'background', opacity: 1 });
    expect(html).toMatch(/data-part="collage-text"[^>]*class="[^"]*\bbg-background\b/);
  });

  it('logical layout only (mirrors in Arabic), no sub-12px text', () => {
    const html = renderToStaticMarkup(<HeroCollage slides={slides} isRtl urlPrefix="" />);
    expect(html).not.toMatch(/\b(ml|mr|pl|pr|left|right)-\d/);
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
    expect(html).not.toMatch(/flex-row-reverse/);
  });

  it('fewer than 3 images returns null (the caller falls back to the banner)', () => {
    expect(
      renderToStaticMarkup(<HeroCollage slides={slides.slice(0, 2)} isRtl urlPrefix="" />)
    ).toBe('');
  });
});

describe('shop-the-look', () => {
  it('is a registered document-only template section with ≤ 6 look blocks of ≤ 4 products', () => {
    const d = getSectionDefinition('shop-the-look')!;
    expect(d.legacyKey).toBeNull();
    expect(d.group).toBe('template');
    expect(d.blocks[0].type).toBe('look');
    expect(d.blocks[0].maxCount).toBe(6);
    expect(
      shopTheLookBlockSchema.safeParse({ productIds: ['a', 'b', 'c', 'd', 'e'] }).success
    ).toBe(false);
    expect(shopTheLookBlockSchema.safeParse({ productIds: ['a'] }).success).toBe(true);
    expect(shopTheLookSchema.safeParse({ heading: 'x', unknown: 1 }).success).toBe(false); // strict
    expect(shopTheLookSchema.safeParse({ heading: 'x', bgColor: 'token:card' }).success).toBe(true);
  });

  it('labels use neutral noun forms (quality bar §2, ruling e)', () => {
    const d = getSectionDefinition('shop-the-look')!;
    expect(d.labelAr).toBe('تسوّق اللوك');
    expect(d.presets[0].settings).toMatchObject({ headingAr: 'تسوّق اللوك' });
  });

  it('renders each look with its items as links + prices, no add-to-cart (Ruling B1-6)', () => {
    const html = render([look([PRODUCTS[0].id, PRODUCTS[2].id])]);
    expect(html).toContain('snap-x');
    expect(html).toContain('snap-mandatory');
    expect(html).toContain(`/products/${PRODUCTS[0].slug}`);
    expect(html).toContain(`/products/${PRODUCTS[2].slug}`);
    expect(html).toContain('لوك الكتان');
    expect(html).toContain('كاجو');
    // The row's own prev/next pair (P2-13) is navigation, not a buy control.
    expect(html.match(/<button[^>]*data-scroll-(prev|next)/g)).toHaveLength(2);
    const buyable = html.replace(
      /<button[^>]*data-scroll-(prev|next)[^>]*>[\s\S]*?<\/button>/g,
      ''
    );
    expect(buyable).not.toMatch(/add-to-cart|data-cta|<button/i);
    expect(html).toContain('data-section="shop-the-look"');
  });

  it('prices print through the shared formatter; compare-at in full format, struck', () => {
    const html = render([look([PRODUCTS[0].id])]);
    expect(html).toContain('250 ج.م');
    expect(html).toMatch(/line-through[^>]*>300 ج.م/);
    setStore('qamar', 'en');
    const en = render([look([PRODUCTS[0].id])]);
    expect(en).toContain('EGP 250');
    setStore();
  });

  it('a variant product shows its "from" price like every card path', () => {
    const html = render([look([PRODUCTS[2].id])]);
    expect(html).toMatch(/من\s*(<!-- -->)?\s*420 ج.م/);
  });

  it('a sold-out item keeps its link and shows the shared sold-out label', () => {
    const html = render([look([PRODUCTS[1].id, PRODUCTS[0].id])]);
    expect(html).toContain(`/products/${PRODUCTS[1].slug}`);
    expect(html).toContain('نفدت الكمية');
    expect(html.match(/نفدت الكمية/g)?.length).toBe(1);
  });

  it('look total sums the pieces that can be bought, bidi-isolated', () => {
    const html = render([look([PRODUCTS[0].id, PRODUCTS[2].id, PRODUCTS[1].id])]);
    // 250 + 420 (variant "from") — the sold-out Medjool is not in the total.
    expect(html).toMatch(/مجموع اللوك/);
    expect(html).toMatch(/<bdi[^>]*>من 670 ج.م<\/bdi>|<bdi[^>]*>670 ج.م<\/bdi>/);
  });

  it('a store that hides card prices hides row prices and the total', () => {
    const html = renderToStaticMarkup(
      <ShopTheLookSection
        settings={{}}
        blocks={[look([PRODUCTS[0].id, PRODUCTS[2].id])] as any}
        products={PRODUCTS as any}
        showPrice={false}
      />
    );
    expect(html).not.toContain('ج.م');
    expect(html).not.toContain('مجموع اللوك');
    expect(html).toContain(`/products/${PRODUCTS[0].slug}`);
  });

  it('a look whose products are all missing renders nothing (no empty card)', () => {
    const blocks = [
      { id: 'l1', type: 'look', settings: { image: 'https://x/l.webp', productIds: ['gone'] } },
    ];
    expect(
      renderToStaticMarkup(
        <ShopTheLookSection settings={{}} blocks={blocks as any} products={[]} />
      )
    ).toBe('');
  });

  it('a foreign / unknown product id never renders (store-scoped pool, C11)', () => {
    const html = render([look(['foreign-store-product', PRODUCTS[0].id])]);
    expect(html).not.toContain('foreign-store-product');
    expect(html.match(/href="\/products\//g)?.length).toBe(1);
  });

  it('a look with no photo still lists its pieces; a block of the wrong type is ignored', () => {
    const html = render([
      { id: 'x', type: 'collection', settings: { productIds: [PRODUCTS[0].id] } },
      look([PRODUCTS[0].id], { image: undefined }),
    ]);
    expect(html.match(/data-part="look"/g)?.length).toBe(1);
    expect(html).toContain(`/products/${PRODUCTS[0].slug}`);
  });

  it('editor canvas shows a dashed placeholder for an empty section', () => {
    const html = renderToStaticMarkup(
      <ShopTheLookSection settings={{}} blocks={[]} products={[]} editorMode />
    );
    expect(html).toContain('border-dashed');
  });

  it('logical layout only, no sub-12px text, no letter-spacing on Arabic', () => {
    const html = render([look([PRODUCTS[0].id, PRODUCTS[1].id])]);
    expect(html).not.toMatch(/\b(ml|mr|pl|pr|left|right)-\d/);
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
    expect(html).not.toMatch(/tracking-(wide|wider|widest)/);
    expect(html).not.toMatch(/rounded-(sm|md|lg|xl|2xl)\b/);
  });

  for (const template of ['minimal', 'dahab', 'qamar'])
    it(`renders on the ${template} skin (Review Focus 5)`, () => {
      setStore(template);
      const hero = renderToStaticMarkup(<HeroCollage slides={slides} isRtl urlPrefix="" />);
      const stl = render([look([PRODUCTS[0].id])]);
      expect(hero.length).toBeGreaterThan(0);
      expect(stl).toContain(`/products/${PRODUCTS[0].slug}`);
      setStore();
    });
});

describe('shop-the-look catalogue refs (C11)', () => {
  const doc = (): PageDefinition => {
    const n = sectionFromPreset('shop-the-look', 0, 'stl');
    n.blocks = [
      { id: 'a', type: 'look', settings: { productIds: ['p1', 'p-other-store'] } },
      { id: 'b', type: 'look', settings: { productIds: ['p1'] } },
    ];
    return {
      schemaVersion: PAGE_DEFINITION_SCHEMA_VERSION,
      pageKey: 'home',
      sectionGroups: { header: [], footer: [] },
      sections: [n],
      siteSettings: {},
    };
  };

  it('collects the product ids every look block names', () => {
    expect(collectRefs(doc()).productIds.sort()).toEqual(['p-other-store', 'p1']);
  });

  it('an unknown or cross-store id is a REF_NOT_FOUND warning at its block path', async () => {
    const res = await validateDefinition(doc(), {
      resolveRefs: async () => ({ categorySlugs: new Set(), productIds: new Set(['p1']) }),
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.map(w => [w.code, w.path])).toEqual([
      ['REF_NOT_FOUND', '/sections/0/blocks/0/settings/productIds/1'],
    ]);
  });

  it('a look with more than 4 pieces or more than 6 looks is refused', () => {
    const d = doc();
    d.sections[0].blocks![0].settings.productIds = ['1', '2', '3', '4', '5'];
    expect(validateDefinitionSync(d).ok).toBe(false);
    const many = doc();
    many.sections[0].blocks = Array.from({ length: 7 }, (_, i) => ({
      id: `l${i}`,
      type: 'look',
      settings: { productIds: ['p1'] },
    }));
    expect(validateDefinitionSync(many).ok).toBe(false);
  });
});

describe('Lookbook mix', () => {
  it('uses the collage hero and shop-the-look first, never sets hero mode', () => {
    const lb = getLook('qamar.lookbook')!;
    const mix = lb.sections!.map(s => s.type);
    expect(mix.slice(0, 2)).toEqual(['hero', 'shop-the-look']);
    expect(lb.sections![0].design).toMatchObject({ presentation: 'collage' });
    expect(lb.sections![0].design).not.toHaveProperty('mode');
    for (const s of lb.sections!)
      for (const k of Object.keys(s.design ?? {})) expect(LOOK_DESIGN_KEYS).toContain(k);
    expect(lb.chrome).toEqual({ header: { logoPlacement: 'start' } });
  });
});

describe('showroom seed: the Lookbook shop-the-look node', async () => {
  // @ts-expect-error plain .mjs script
  const { buildQamarHome } = await import('../../scripts/storedemo/qamar-home.mjs');
  // @ts-expect-error plain .mjs data module
  const { QAMAR_PRODUCTS } = await import('../../scripts/qamar-demo/catalogue.mjs');
  const { applyTemplateFamily, layoutToDefinition, resolveLayoutSettings } =
    await import('@ebda/shared');
  const ids = new Map<string, string>(
    (QAMAR_PRODUCTS as { slug: string }[]).map(p => [p.slug, `id-${p.slug}`])
  );
  const doc: PageDefinition = buildQamarHome(
    layoutToDefinition(resolveLayoutSettings({}, 'qamar')),
    { img: (f: string) => `/__qamar-demo/${f}`, video: null, productIdBySlug: ids }
  );

  it('is a valid document with one Lookbook-tagged shop-the-look of three 3-piece looks', () => {
    expect(validateDefinitionSync(doc).ok).toBe(true);
    const stl = doc.sections.filter(s => s.type === 'shop-the-look');
    expect(stl).toHaveLength(1);
    expect(stl[0].lookTag).toBe('qamar.lookbook');
    expect(stl[0].blocks).toHaveLength(3);
    for (const b of stl[0].blocks!) {
      expect((b.settings.productIds as string[]).every(id => id.startsWith('id-'))).toBe(true);
      expect(b.settings.altAr).toBeTruthy();
      expect(b.settings.alt).toBeTruthy();
    }
  });

  it('applying the Lookbook look orders the collage hero and shop-the-look first', () => {
    const lb = applyTemplateFamily(doc, 'qamar', getLook('qamar.lookbook'));
    expect(lb.sections.slice(0, 2).map(s => [s.type, s.id])).toEqual([
      ['hero', 'hero-lookbook'],
      ['shop-the-look', 'shop-the-look'],
    ]);
    expect(lb.sections[0].settings.presentation).toBe('collage');
    expect(lb.sections[0].settings.mode).toBe('slider'); // content, untouched by the look
    expect(lb.sections[1].settings.bgColor).toBe('token:card');
    // Atelier never shows the Lookbook-tagged section.
    const at = applyTemplateFamily(doc, 'qamar', getLook('qamar.atelier'));
    expect(at.sections.some(s => s.type === 'shop-the-look')).toBe(false);
  });

  it('one Arabic register: no gendered imperative anywhere in the demo copy (quality bar §2)', async () => {
    // @ts-expect-error plain .mjs data module
    const cat = await import('../../scripts/qamar-demo/catalogue.mjs');
    const text = JSON.stringify([doc, cat]);
    expect(text).not.toMatch(/(تسوقي|اختاري|اطلبي|خليكي|شوفي|جربي|اكتشفي)/);
    expect(text).toContain('تسوّق حسب القسم');
  });

  it('refuses to seed a look whose piece is missing from the catalogue', () => {
    expect(() =>
      buildQamarHome(layoutToDefinition(resolveLayoutSettings({}, 'qamar')), {
        img: (f: string) => f,
        video: null,
        productIdBySlug: new Map(),
      })
    ).toThrow(/shop-the-look/);
  });
});

describe('section headings measure contrast against the PAINTED page (resolveBackgroundPreset)', async () => {
  const { SectionHeading } = await import('../../apps/web/src/templates/shared/SectionHeading');
  const { composeStoreTheme } = await import('@ebda/shared');
  const heading = (theme: Record<string, unknown>, zoneColor?: string) => {
    ctx.store = { ...STORES.A, template: 'qamar', currency: 'EGP', theme };
    const html = renderToStaticMarkup(
      <SectionHeading
        title="Shop by category"
        isRtl={false}
        headingZone={zoneColor ? { color: zoneColor } : undefined}
      />
    );
    setStore();
    return html.match(/data-zone="sectionTitle"[^>]*style="color:(#[0-9a-f]{6})"/i)?.[1];
  };
  it('the Lookbook theme (a dark bgPage/bgSectionAlt pair) gets a light heading', () => {
    const t = composeStoreTheme({ template: 'qamar', look: 'qamar.lookbook', theme: {} });
    expect(heading(t as unknown as Record<string, unknown>)).toBe('#ffffff');
    expect(heading({ bgPage: '231 36% 18%', bgSectionAlt: '231 40% 25%' })).toBe('#ffffff');
  });
  it('(a) a legacy dark backgroundColor with no pair paints a WHITE page: heading stays dark', () => {
    expect(heading({ backgroundColor: '231 36% 18%' })).toBe('#000000');
    expect(heading({ bgPage: '231 36% 18%' })).toBe('#000000'); // half a pair is ignored too
  });
  it('(b) a stale near-white zone colour on an off-white page is still corrected', () => {
    expect(heading({ bgPage: '36 33% 96%', bgSectionAlt: '36 33% 91%' }, '#ffffff')).toBe(
      '#000000'
    );
    expect(heading({ backgroundPreset: 'warmSand' }, '#ffffff')).toBe('#000000');
  });
  it('a real tint is honoured; a light tint on a dark look page is honoured', () => {
    expect(heading({}, '#6e1f2a')).toBe('#6e1f2a');
    expect(heading({ bgPage: '231 36% 18%', bgSectionAlt: '231 40% 25%' }, '#f4f1fa')).toBe(
      '#f4f1fa'
    );
  });
  it('a light page, or a theme with no page colour, keeps the dark heading (unchanged)', () => {
    expect(heading({ bgPage: '0 0% 100%', bgSectionAlt: '0 0% 98%' })).toBe('#000000');
    expect(heading({})).toBe('#000000');
  });
});

describe('one section-heading alignment per page on qamar (T-03)', async () => {
  const { SectionHeading } = await import('../../apps/web/src/templates/shared/SectionHeading');
  const h2 = (pack: string, align?: 'start' | 'center' | 'end') =>
    renderToStaticMarkup(
      <SectionHeading
        title="Shop by category"
        isRtl
        pack={pack as any}
        headingZone={align ? { textAlign: align } : undefined}
      />
    ).match(/<h2 class="([^"]*)"/)?.[1] ?? '';
  it('qamar start-aligns by default; legacy skins stay centred; a merchant align wins', () => {
    expect(h2('qamar')).toMatch(/\btext-start\b/);
    for (const p of ['minimal', 'modern', 'dahab']) expect(h2(p)).toMatch(/\btext-center\b/);
    expect(h2('qamar', 'center')).toMatch(/\btext-center\b/);
  });
});

describe('product grids centre an incomplete last row and never hide a product (L-05, B1-40)', async () => {
  const { centredGrid, FeaturedCollectionSection } =
    await import('../../apps/web/src/builder/sections/FeaturedCollectionSection');
  const { toTemplateProduct } = await import('../../apps/web/src/templates/adapters');
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...PRODUCTS[0],
      id: `m${i}`,
      slug: `pick-${i}`,
      name: `Pick ${i}`,
    }));
  const render = (n: number, settings: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <FeaturedCollectionSection
        settings={{ productSource: 'manual', columns: 4, mobileColumns: 2, ...settings } as any}
        products={many(n).map(p => toTemplateProduct(p as any))}
        pack="qamar"
        onAddToCart={async () => {}}
      />
    );
  const cards = (html: string) => html.match(/href="\/products\/pick-\d+"/g)?.length ?? 0;

  it('3 hand-picked products on a 2-column phone grid: all 3 render, the last one centred', () => {
    const html = render(3);
    expect(new Set(html.match(/pick-\d+/g)).size).toBe(3);
    expect(cards(html)).toBeGreaterThanOrEqual(3);
    expect(html).not.toMatch(/\bhidden\b[^"]*"[^>]*>\s*<[^>]*pick/);
    // two tracks per card; the third card starts at track 2 of 4 (centred) on a phone
    expect(html).toContain('grid-cols-4 md:grid-cols-6 lg:grid-cols-8');
    const items = [...html.matchAll(/<div class="(col-span-2[^"]*)">/g)].map(m => m[1]);
    expect(items).toHaveLength(3);
    expect(items[2]).toMatch(/(^| )col-start-2( |$)/);
    expect(items[0]).toMatch(/lg:col-start-2/); // 3 of 4 on desktop: the row is centred too
  });

  it('7 picks render 7; no card is ever hidden or spans full width', () => {
    const html = render(7);
    expect(new Set(html.match(/pick-\d+/g)).size).toBe(7);
    expect(html).not.toMatch(/col-span-full|md:hidden|lg:hidden|class="hidden/);
  });

  it('a count that fills every breakpoint renders the plain grid, unchanged', () => {
    expect(centredGrid(12, { base: 2, md: 3, lg: 4 })).toBeNull();
    const html = render(12);
    expect(html).toContain('grid-cols-2 md:grid-cols-3 lg:grid-cols-4');
    expect(html).not.toContain('col-span-2');
  });

  it('the shifted card resets its start at a breakpoint where its row is full', () => {
    const g = centredGrid(5, { base: 2, md: 3, lg: 4 })!; // phone 2+2+1, md 3+2, lg 4+1
    expect(g.item(4)).toBe('col-span-2 col-start-2 md:col-start-auto lg:col-start-4');
    expect(g.item(3)).toBe('col-span-2 md:col-start-2 lg:col-start-auto');
    expect(g.item(0)).toBe('col-span-2');
  });
});

describe('homepage piece fetch is never capped below the referenced ids', async () => {
  const { idChunks, MANUAL_IDS_PER_FETCH } =
    await import('../../apps/web/src/builder/sections/section-products');
  it('splits 2 x 6 x 4 shop-the-look pieces + 10 picks into whole chunks of <= 50', () => {
    const ids = Array.from({ length: 58 }, (_, i) => `p${i}`);
    const chunks = idChunks(ids);
    expect(chunks.map(c => c.length)).toEqual([50, 8]);
    expect(chunks.flat()).toEqual(ids);
    expect(MANUAL_IDS_PER_FETCH).toBe(50);
    expect(idChunks([])).toEqual([]);
  });
  it('HomePageBody fetches every chunk', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../apps/web/src/app/HomePageBody.tsx', import.meta.url),
      'utf8'
    );
    expect(src).toMatch(/idChunks\(manualIds\)\.map/);
    expect(src).not.toMatch(/ids=\$\{encodeURIComponent\(manualIds/);
  });
});

describe('the category strip centres a short row (quality bar L-05)', async () => {
  const { CategoryStrip } = await import('../../apps/web/src/templates/shared/CategoryStrip');
  const { CATEGORIES } = await import('../fixtures/builder/homepage-data');
  it('the scroll row is `justify-content: safe center` (start when it overflows)', () => {
    const html = renderToStaticMarkup(
      <CategoryStrip categories={CATEGORIES as any} isRtl urlPrefix="" pack="qamar" />
    );
    expect(html).toMatch(/<ul class="[^"]*\[justify-content:safe_center\]/);
  });
});

describe('qamar display headings are not shrunk/grown by the Arabic font-size-adjust', () => {
  it('h1-h3 and .font-display reset it under the qamar pack; the collage motion has a reduced-motion end state', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(
      new URL('../../apps/web/src/styles/globals.css', import.meta.url),
      'utf8'
    );
    expect(css).toMatch(
      /\[data-pack='qamar'\] :is\(h1, h2, h3, \.font-display\) \{\s*font-size-adjust: none;/
    );
    // the settle animation only exists inside a no-preference block
    const i = css.indexOf('[data-collage-settle] > :nth-child(1)');
    expect(css.lastIndexOf('@media (prefers-reduced-motion: no-preference)', i)).toBeGreaterThan(
      css.lastIndexOf('}\n}', i)
    );
    expect(css).toMatch(/collage-settle-lead 280ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
  });
});
