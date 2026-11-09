// @vitest-environment jsdom
// T7: the five signature sections (one per template). Each renders in Arabic and English, falls
// back gracefully with NO photo, renders nothing publicly when its list is unfilled (a hint in the
// editor), and lays out with logical properties only so Arabic mirrors.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ctx = vi.hoisted(() => ({ language: 'ar' as 'en' | 'ar' }));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: 's', look: 'souq.night', theme: {} }, isPlatform: false }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: ctx.language,
      isRtl: ctx.language === 'ar',
      t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
    }),
  };
});

const { SignatureSection, SIGNATURE_TYPES } =
  await import('../../apps/web/src/builder/sections/SignatureSection');
type T = (typeof SIGNATURE_TYPES)[number];

const IMG = 'https://pub-test.r2.dev/p/photo.jpg';
const b = (type: string, i: number, settings: Record<string, unknown>) => ({
  id: `${type}-${i}`,
  type,
  settings,
});
const TEXT = {
  title: 'Signature',
  titleAr: 'لحظة مميزة',
  ctaText: 'Shop',
  ctaTextAr: 'تسوّق',
  ctaHref: '/products',
};
const FILLED: Record<T, { settings: Record<string, unknown>; blocks: ReturnType<typeof b>[] }> = {
  'editorial-collage': {
    settings: TEXT,
    blocks: [1, 2, 3].map(i => b('photo', i, { image: `${IMG}?${i}`, alt: `Look ${i}` })),
  },
  'piece-window': { settings: { ...TEXT, image: IMG, alt: 'A ring', altAr: 'خاتم' }, blocks: [] },
  'spec-sheet': {
    settings: { ...TEXT, image: IMG },
    blocks: [
      b('spec', 1, { value: '6.7', label: 'inch screen', labelAr: 'بوصة الشاشة' }),
      b('spec', 2, { value: '5000', label: 'mAh battery', labelAr: 'مللي أمبير' }),
    ],
  },
  'key-ingredients': {
    settings: { ...TEXT, image: IMG },
    blocks: [
      b('ingredient', 1, { name: 'Rose water', nameAr: 'ماء ورد', benefit: 'Calms' }),
      b('ingredient', 2, { name: 'Shea', nameAr: 'زبدة الشيا', benefitAr: 'بترطّب' }),
    ],
  },
  'kitchen-days': {
    settings: TEXT,
    blocks: [
      b('day', 1, { day: 'Saturday', dayAr: 'السبت', dish: 'Molokhia', dishAr: 'ملوخية' }),
      b('day', 2, { day: 'Sunday', dayAr: 'الحد', dish: 'Stuffed vine', dishAr: 'محشي ورق عنب' }),
    ],
  },
};

const render = (
  type: T,
  input: { settings: Record<string, unknown>; blocks: ReturnType<typeof b>[] },
  language: 'en' | 'ar' = 'ar',
  editorMode = false
) => {
  ctx.language = language;
  return renderToStaticMarkup(
    <SignatureSection
      type={type}
      settings={input.settings}
      blocks={input.blocks as never}
      pack="qamar"
      editorMode={editorMode}
    />
  );
};
const withoutImages = (x: (typeof FILLED)[T]) => ({
  settings: { ...x.settings, image: undefined },
  blocks: x.blocks.map(bl => ({ ...bl, settings: { ...bl.settings, image: undefined } })),
});

describe.each(SIGNATURE_TYPES)('%s', type => {
  it('renders in Arabic with the Arabic copy, and in English with the English copy', () => {
    const ar = render(type, FILLED[type], 'ar');
    expect(ar).toContain(`data-section="${type}"`);
    expect(ar).toContain('لحظة مميزة');
    expect(ar).toContain('تسوّق');
    const en = render(type, FILLED[type], 'en');
    expect(en).toContain('Signature');
    expect(en).toContain('href="/products"');
  });
  it('with no photo it still renders (no broken image box, no <img>)', () => {
    const html = render(type, withoutImages(FILLED[type]));
    expect(html).toContain(`data-section="${type}"`);
    expect(html).not.toContain('<img');
    expect(html).toContain('لحظة مميزة');
  });
  it('lays out with logical properties only (Arabic mirrors), and animates no text', () => {
    const html = render(type, FILLED[type]);
    expect(html).not.toMatch(/\b(?:left|right)-\[|\b(?:ml|mr|pl|pr)-\d/);
    expect(html).not.toMatch(/animate-/);
  });
});

describe('unfilled sections render nothing publicly and a hint in the editor', () => {
  const EMPTY: Record<T, string> = {
    'editorial-collage': 'collage',
    'piece-window': 'pieceWindow',
    'spec-sheet': 'specSheet',
    'key-ingredients': 'keyIngredients',
    'kitchen-days': 'kitchenDays',
  };
  it.each(SIGNATURE_TYPES)('%s', type => {
    const empty = { settings: {}, blocks: [] };
    expect(render(type, empty)).toBe('');
    expect(render(type, empty, 'ar', true)).toContain(`data-empty-section="${EMPTY[type]}"`);
  });
  it('a list with one filled row is not a list: spec / ingredients / days need two', () => {
    for (const type of ['spec-sheet', 'key-ingredients', 'kitchen-days'] as const)
      expect(render(type, { ...FILLED[type], blocks: FILLED[type].blocks.slice(0, 1) })).toBe('');
  });
  it('the kitchen-days preset (day names, no dishes) shows nothing: dishes are never invented', () => {
    const days = ['السبت', 'الحد', 'الاتنين'].map((dayAr, i) => b('day', i, { dayAr }));
    expect(render('kitchen-days', { settings: TEXT, blocks: days })).toBe('');
  });
  it('a spec with a label but no figure is left out', () => {
    const html = render('spec-sheet', {
      settings: TEXT,
      blocks: [...FILLED['spec-sheet'].blocks, b('spec', 9, { labelAr: 'جيجا مساحة' })],
    });
    expect(html).not.toContain('جيجا مساحة');
  });
});

describe('layout details', () => {
  it('the collage lays its tiles on the inline end (mirrors in Arabic)', () => {
    const html = render('editorial-collage', FILLED['editorial-collage']);
    expect(html).toContain('start-0');
    expect(html).toContain('end-0');
    expect((html.match(/<img/g) ?? []).length).toBe(3);
  });
  it('the window with no photo holds the words inside its frame', () => {
    const html = render('piece-window', withoutImages(FILLED['piece-window']));
    expect(html).toMatch(/border border-border[^>]*>.*لحظة مميزة/s);
  });
  it('spec figures are isolated numbers (bdi) beside their label in a definition list', () => {
    const html = render('spec-sheet', FILLED['spec-sheet']);
    expect(html).toContain('<dl');
    expect(html).toContain('<bdi>5000</bdi>');
    expect(html).toContain('بوصة الشاشة');
  });
  it('kitchen days scroll on a phone as a focusable, labelled region', () => {
    const html = render('kitchen-days', FILLED['kitchen-days']);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="لحظة مميزة"');
    expect(html).toContain('محشي ورق عنب');
  });
  it('editor mode marks blocks and the CTA so the canvas can select and edit them', () => {
    const html = render('spec-sheet', FILLED['spec-sheet'], 'ar', true);
    expect(html).toContain('data-builder-block="spec-1"');
    expect(html).toContain('data-builder-setting="ctaTextAr"');
    expect(html).toContain('data-builder-image="image"');
  });
});
