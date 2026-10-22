// @vitest-environment jsdom
// Phase B5 Task 3: the gift-finder section (Ruling B5-7). Two chip rows over the product list's URL
// filters: budgets are real links before any script runs, occasions are toggle buttons, every
// target is 44px, an occasion naming a category the store lacks is hidden, an empty finder renders
// nothing (the editor shows a hint).
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render as rtl, screen, fireEvent, cleanup } from '@testing-library/react';

const ctx = vi.hoisted(() => ({ language: 'ar' as 'en' | 'ar' }));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: 's', look: 'dahab.giftbox', theme: {} }, isPlatform: false }),
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
vi.mock('../../apps/web/src/hooks/useLocalePrice', () => ({
  useLocalePrice: () => (minor: number) => `EGP ${minor / 100}`,
}));

const { GiftFinderSection } = await import('../../apps/web/src/builder/sections/GiftFinderSection');

const cats = [
  { id: 'c1', slug: 'engagement', name: 'Engagement', nameAr: 'خطوبة' },
  { id: 'c2', slug: 'birthday', name: 'Birthday', nameAr: 'عيد ميلاد' },
] as never;
const blocks = [
  { id: 'o1', type: 'occasion', settings: { categorySlug: 'engagement' } },
  { id: 'o2', type: 'occasion', settings: { categorySlug: 'birthday', labelAr: 'يوم ميلاد' } },
  { id: 'o3', type: 'occasion', settings: { categorySlug: 'not-in-store', label: 'Ghost' } },
  { id: 'b1', type: 'budget', settings: { maxPrice: 2000, labelAr: 'لحد 2,000' } },
  { id: 'b2', type: 'budget', settings: { maxPrice: 5000 } },
  { id: 'b3', type: 'budget', settings: { maxPrice: 0 } },
] as never;
const render = (b = blocks, language: 'en' | 'ar' = 'ar', editorMode = false) => {
  ctx.language = language;
  return renderToStaticMarkup(
    <GiftFinderSection
      settings={{ headingAr: 'اختار الهدية', heading: 'Pick' }}
      blocks={b}
      categories={cats}
      editorMode={editorMode}
    />
  );
};

describe('GiftFinderSection', () => {
  it('budgets are links carrying the cap in MINOR units (2000 pounds = 200000)', () => {
    const html = render();
    expect(html).toContain('href="/products?maxPrice=200000"');
    expect(html).toContain('href="/products?maxPrice=500000"');
  });
  it('an occasion label falls back to the category name, in the page language', () => {
    expect(render()).toContain('خطوبة');
    expect(render(blocks, 'en')).toContain('Engagement');
    expect(render()).toContain('يوم ميلاد');
  });
  it('an occasion naming a category the store lacks is hidden; a zero or missing cap makes no budget', () => {
    const html = render();
    expect(html).not.toContain('Ghost');
    expect((html.match(/href="\/products\?maxPrice=/g) ?? []).length).toBe(2);
  });
  it('occasions are toggle buttons (aria-pressed), nothing picked on the server', () => {
    const html = render();
    expect((html.match(/aria-pressed="false"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('data-gift-show');
  });
  it('every chip is a 44px target and uses the input boundary, not the decorative line', () => {
    const html = render();
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('border-input');
    expect(html).not.toMatch(/border-border/);
  });
  it('an empty finder renders nothing publicly and a hint in the editor', () => {
    expect(render([] as never)).toBe('');
    expect(render([] as never, 'ar', true)).toContain('data-empty-section="giftFinder"');
  });
  it('the budget label falls back to the formatted cap when the merchant wrote none', () => {
    expect(render(blocks, 'en')).toContain('Up to EGP 5000');
  });
});

describe('GiftFinderSection interaction', () => {
  it('picking an occasion shows one "Show gifts" link and adds the category to every budget link; picking again clears', () => {
    ctx.language = 'en';
    rtl(<GiftFinderSection settings={{}} blocks={blocks} categories={cats} />);
    expect(document.querySelector('[data-gift-show]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Engagement' }));
    const show = document.querySelector('[data-gift-show]') as HTMLAnchorElement;
    expect(show.getAttribute('href')).toBe('/products?category=engagement');
    const hrefs = [...document.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/products?category=engagement&maxPrice=200000');
    expect(screen.getByRole('button', { name: 'Engagement' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Engagement' }));
    expect(document.querySelector('[data-gift-show]')).toBeNull();
    // switching occasion replaces, never accumulates
    fireEvent.click(screen.getByRole('button', { name: 'Engagement' }));
    fireEvent.click(screen.getByRole('button', { name: 'يوم ميلاد' }));
    expect(document.querySelector('[data-gift-show]')!.getAttribute('href')).toBe(
      '/products?category=birthday'
    );
    cleanup();
  });
});
