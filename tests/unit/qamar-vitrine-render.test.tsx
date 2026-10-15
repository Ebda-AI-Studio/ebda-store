/**
 * Phase B1 Task 8 — Vitrine: occasion bands (collection-list `tileShape: 'band'` + block `tone`),
 * one customer line (testimonials `layout: 'single'`), the framed hero's drawn hairline and the
 * Vitrine look data (champagne `line`, centred wordmark, occasion-first mix). The bands and the
 * single quote are platform variants (Ruling B1-2): rendered on minimal, dahab and qamar.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  collectionListSchema,
  collectionBlockSchema,
  storeLayoutSchema,
  getLook,
  getSectionDefinition,
  getTemplateTheme,
} from '@ebda/shared';
import { CATEGORIES, STORES, TESTIMONIALS } from '../fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
  store: null as unknown as Record<string, unknown>,
  language: 'ar' as 'en' | 'ar',
}));

vi.mock('next/image', () => ({
  __esModule: true,
  default: ({
    src,
    alt,
    sizes,
    className,
  }: {
    src: string;
    alt?: string;
    sizes?: string;
    className?: string;
  }) => React.createElement('img', { src, alt, sizes, className }),
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

const { CollectionListSection, BAND_TONES } =
  await import('../../apps/web/src/builder/sections/CollectionListSection');
const { TestimonialRow, pickSingleTestimonial } =
  await import('../../apps/web/src/templates/shared/TestimonialRow');
const { DahabTestimonialRow } = await import('../../apps/web/src/templates/dahab/TestimonialRow');
const { HeroBanner } = await import('../../apps/web/src/templates/shared/HeroBanner');

const setStore = (template: 'minimal' | 'dahab' | 'qamar', language: 'ar' | 'en' = 'ar') => {
  ctx.language = language;
  ctx.store = {
    ...STORES.A,
    template,
    look: null,
    currency: 'EGP',
    theme: getTemplateTheme(template),
  };
};
setStore('qamar');

const blocks = [
  {
    id: 'o1',
    type: 'collection',
    settings: {
      categorySlug: CATEGORIES[0].slug,
      label: 'Wedding',
      labelAr: 'فرح',
      tone: 'primary',
    },
  },
  {
    id: 'o2',
    type: 'collection',
    settings: {
      categorySlug: CATEGORIES[1].slug,
      label: 'Engagement',
      labelAr: 'خطوبة',
      tone: 'accent',
    },
  },
  {
    id: 'o3',
    type: 'collection',
    settings: { categorySlug: CATEGORIES[0].slug, label: 'Evening', labelAr: 'سهرة', tone: 'line' },
  },
];
const bands = (b: unknown[] = blocks, settings: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <CollectionListSection
      settings={{ tileShape: 'band', headingAr: 'تسوّق حسب المناسبة', ...settings }}
      blocks={b as any}
      categories={CATEGORIES as any}
    />
  );

describe('occasion bands', () => {
  it('schema: band shape + tone', () => {
    expect(collectionListSchema.safeParse({ tileShape: 'band' }).success).toBe(true);
    expect(collectionBlockSchema.safeParse({ tone: 'line' }).success).toBe(true);
    expect(collectionBlockSchema.safeParse({ tone: 'pink' }).success).toBe(false);
  });

  it('the editor offers the band shape and the block tone', () => {
    const def = getSectionDefinition('collection-list')!;
    const shape = def.settings.find(s => s.id === 'tileShape') as { options: { value: unknown }[] };
    expect(shape.options.map(o => o.value)).toContain('band');
    const block = def.blocks!.find(b => b.type === 'collection')!;
    const tone = block.settings.find(s => s.id === 'tone') as { options: { value: unknown }[] };
    expect(tone.options.map(o => o.value)).toEqual(['primary', 'accent', 'line']);
  });

  it('every fill is paired with its on-token (quality bar K-02)', () =>
    expect(BAND_TONES).toEqual({
      primary: 'bg-primary text-primary-foreground',
      accent: 'bg-accent text-accent-foreground',
      line: 'bg-border text-foreground',
    }));

  for (const skin of ['minimal', 'dahab', 'qamar'] as const)
    it(`each block is a full-width band on its tone, text on the matching foreground (${skin})`, () => {
      setStore(skin);
      const html = bands();
      expect(html).toContain('data-tile-shape="band"');
      expect(html).toContain('bg-primary text-primary-foreground');
      expect(html).toContain('bg-accent text-accent-foreground');
      expect(html).toContain('bg-border text-foreground');
      // one link per band, to its category; labels in Arabic
      expect(html.match(/<a /g)?.length).toBe(3);
      expect(html).toContain('href="/products?category=nuts"');
      expect(html).toContain('فرح');
      // the photo goes through the image pipeline with sizes, decorative (the label names it)
      expect(html).toMatch(/<img[^>]*alt=""[^>]*sizes="\(min-width: 640px\) 112px, 80px"/);
      // no counted-noun meta on a band (quality bar Y-01, Y-05)
      expect(html).not.toContain('قطعة');
    });

  it('a block with no tone cycles primary, accent, line', () => {
    setStore('qamar');
    const html = bands(blocks.map(b => ({ ...b, settings: { ...b.settings, tone: undefined } })));
    expect([...html.matchAll(/data-tone="(\w+)"/g)].map(m => m[1])).toEqual([
      'primary',
      'accent',
      'line',
    ]);
  });

  it('the heading follows the pack alignment: start on qamar, centred on minimal', () => {
    setStore('qamar');
    expect(bands()).not.toContain('text-center');
    setStore('minimal');
    expect(bands()).toContain('text-center');
  });

  it('no band label → no band; nothing to show → nothing rendered', () => {
    setStore('qamar');
    expect(bands([])).toBe('');
  });

  it('the band label uses the display face at >= 24px only (decision a)', () => {
    setStore('qamar');
    expect(bands()).toMatch(/font-display text-3xl/);
  });

  it('the tile shapes are unchanged when the list is not a band', () => {
    setStore('qamar');
    const html = bands(blocks, { tileShape: 'arch' });
    expect(html).not.toContain('data-tile-shape');
    expect(html).not.toContain('bg-border');
  });
});

describe('single customer line', () => {
  it('renders exactly one quote, no cards', () => {
    const html = renderToStaticMarkup(
      <TestimonialRow testimonials={TESTIMONIALS as any} isRtl layout="single" />
    );
    expect(html.match(/<blockquote/g)?.length).toBe(1);
    expect(html).toContain('data-layout="single"');
    expect(html).not.toContain('<article');
    expect(html).toContain('Fresh and fast.');
    // the section keeps a name for screen readers
    expect(html).toMatch(/<h2 class="sr-only">آراء العملاء<\/h2>/);
  });

  it('row layout unchanged when layout is absent or row', () => {
    const a = renderToStaticMarkup(<TestimonialRow testimonials={TESTIMONIALS as any} isRtl />);
    const b = renderToStaticMarkup(
      <TestimonialRow testimonials={TESTIMONIALS as any} isRtl layout="row" />
    );
    expect(a).not.toContain('data-layout="single"');
    expect(a.match(/<article/g)?.length).toBe(TESTIMONIALS.length);
    expect(b).toBe(a);
  });

  it('quote marks follow the quote script, not the page direction', () => {
    const en = renderToStaticMarkup(
      <TestimonialRow testimonials={[TESTIMONIALS[1]] as any} isRtl={false} layout="single" />
    );
    expect(en).toContain('«جيد جداً»');
    const ar = renderToStaticMarkup(
      <TestimonialRow testimonials={[TESTIMONIALS[0]] as any} isRtl layout="single" />
    );
    expect(ar).toContain('“Fresh and fast.”');
  });

  it('picks the first quote short enough to set large', () => {
    const long = { ...TESTIMONIALS[0], id: 'long', comment: 'x'.repeat(400) };
    expect(pickSingleTestimonial([long, TESTIMONIALS[1]] as any)?.id).toBe('t2');
    expect(pickSingleTestimonial([long] as any)?.id).toBe('long');
    expect(pickSingleTestimonial([])).toBeUndefined();
  });

  it('Dahab honours the same layout (platform variant)', () => {
    setStore('dahab');
    const html = renderToStaticMarkup(
      <DahabTestimonialRow testimonials={TESTIMONIALS as any} isRtl layout="single" />
    );
    expect(html.match(/<blockquote/g)?.length).toBe(1);
    expect(html).toContain('data-layout="single"');
    const row = renderToStaticMarkup(
      <DahabTestimonialRow testimonials={TESTIMONIALS as any} isRtl />
    );
    expect(row.match(/<blockquote/g)?.length).toBe(TESTIMONIALS.length);
  });

  it('schema, editor and renderer carry the layout', () => {
    const t = storeLayoutSchema.shape.testimonials;
    const base = { enabled: true, minRating: 4, verifiedOnly: true };
    expect(t.safeParse({ ...base, layout: 'single' }).success).toBe(true);
    expect(t.safeParse({ ...base, layout: 'grid' }).success).toBe(false);
    const def = getSectionDefinition('testimonials')!;
    expect(def.settings.some(s => s.id === 'layout')).toBe(true);
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/builder/render/PageRenderer.tsx'),
      'utf8'
    );
    expect(src).toContain('layout={layout.testimonials.layout}');
  });
});

describe('framed hero hairline (Rulings B1-5, B1-7, B1-41)', () => {
  const hero = (p: Record<string, unknown>) =>
    renderToStaticMarkup(
      <HeroBanner image="a.webp" headline="Night" isRtl pack="qamar" presentation="framed" {...p} />
    );

  it('a look store gets the drawn hairline in the line colour, decorative', () => {
    const html = hero({ frameLine: true });
    expect(html).toContain('data-frame-draw=""');
    expect(html).toMatch(
      /<span aria-hidden="true" data-part="frame-line" class="pointer-events-none absolute [^"]*border border-border/
    );
    // frame and hairline share the look's radius
    expect(html).toContain('overflow-hidden rounded-[var(--radius)] bg-muted');
    // a shop window: the photo fills the frame (no letterbox on the muted ground)
    expect(html).toContain('object-cover');
    expect(html).not.toContain('object-contain');
  });

  it('a legacy framed hero (no look) and a full-bleed hero render as before', () => {
    for (const html of [hero({}), hero({ frameLine: false })]) {
      expect(html).not.toContain('data-frame-draw');
      expect(html).not.toContain('frame-line');
      expect(html).toContain('overflow-hidden rounded-2xl bg-muted');
      expect(html).toContain('object-contain');
    }
    expect(hero({ presentation: 'full-bleed', frameLine: true })).not.toContain('frame-line');
  });

  it('the renderer turns it on for registered-look stores only', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/builder/render/PageRenderer.tsx'),
      'utf8'
    );
    expect(src).toContain('const heroFrameLine = !!getLook(store.look);');
    expect(src.match(/frameLine=\{heroFrameLine\}/g)?.length).toBe(2);
  });

  it('the draw is 600ms ease-out-quint, from the centre, motion-safe only', () => {
    const css = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/styles/globals.css'),
      'utf8'
    );
    expect(css).toMatch(
      /@keyframes frame-draw \{\s*from \{\s*clip-path: inset\(50% 50% 50% 50%\);\s*\}\s*to \{\s*clip-path: inset\(0 0 0 0\);/
    );
    const block = css.slice(css.indexOf('@keyframes frame-draw'));
    expect(block).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) \{\s*\[data-frame-draw\] > \[data-part='frame-line'\] \{\s*animation: frame-draw 600ms cubic-bezier\(0\.22, 1, 0\.36, 1\) both;/
    );
  });
});

describe('vitrine look data', () => {
  it('champagne line, centred wordmark, occasion-first mix (Rulings B1-5, B1-4)', () => {
    const v = getLook('qamar.vitrine')!;
    expect(v.tokens.line).toBe('#D8B96A');
    expect(v.chrome?.header.logoPlacement).toBe('centre');
    expect(v.sections!.map(s => s.type).slice(0, 2)).toEqual(['hero', 'collection-list']);
    expect(v.sections![0].design).toMatchObject({ presentation: 'framed' });
    expect(v.sections![0].design).not.toHaveProperty('mode'); // C6: hero mode is content
    expect(v.sections![1].design).toMatchObject({ tileShape: 'band' });
    expect(v.sections!.find(s => s.type === 'testimonials')!.design).toEqual({ layout: 'single' });
  });

  it('presets speak in neutral noun forms (decision e)', () => {
    const v = getLook('qamar.vitrine')!;
    const text = JSON.stringify(v.sections);
    expect(text).not.toMatch(/تسوقي|تسوّقي|اختاري|اطلبي/);
  });
});
