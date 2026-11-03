import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fitDesktopColumns } from './grid-helpers';
import { heroHeadlineFontSize, HERO_HEADLINE_SIZE } from './section-typography';
import { MissingImage, monogramOf } from './MissingImage';
import * as sizes from '../../lib/image-sizes';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('card image paths: real sizes on every path (PREMIUM-2)', () => {
  const CARD_FILES = [
    '../base/ProductCard.tsx',
    './StorefrontProductCard.tsx',
    './ProductCarousel.tsx',
    '../dahab/ProductCard.tsx',
    '../dahab/ProductCarousel.tsx',
    '../dahab/CategoryCard.tsx',
    '../base/CategoryCard.tsx',
  ];
  it.each(CARD_FILES)('%s uses the shared sizes constants and never a 100vw card', f => {
    const s = src(f);
    expect(s).toMatch(/CARD_GRID_SIZES|CARD_CAROUSEL_SIZES|CATEGORY_TILE_SIZES/);
    expect(s).not.toMatch(/sizes="[^"]*100vw/);
  });
  it('phones are told ~46vw, not the viewport', () => {
    expect(sizes.CARD_GRID_SIZES.startsWith('(max-width: 640px) 46vw')).toBe(true);
  });
  it('no card or section path keeps a raw <img> without srcset helpers', () => {
    for (const f of ['../base/CategoryCard.tsx', '../../builder/sections/ImageTextSection.tsx']) {
      expect(src(f)).not.toMatch(/<img\b/);
    }
  });
  it('every card path has the designed missing-image fallback, not an icon', () => {
    for (const f of [
      '../base/ProductCard.tsx',
      './StorefrontProductCard.tsx',
      './ProductCarousel.tsx',
      '../dahab/ProductCard.tsx',
      '../dahab/CategoryCard.tsx',
      '../base/CategoryCard.tsx',
      '../../app/products/ProductListItem.tsx',
      '../../app/products/[slug]/ProductDetailClient.tsx',
    ]) {
      const s = src(f);
      expect(s, f).toContain('<MissingImage');
      expect(s, f).not.toContain('M20 7l-8-4-8 4m16');
    }
  });
});

describe('MissingImage', () => {
  it('draws from store tokens only, with a monogram and no girih', () => {
    const html = renderToStaticMarkup(React.createElement(MissingImage, { label: 'عطر' }));
    expect(html).toContain('data-monogram="ع"');
    expect(html).toContain('hsl(var(--primary)');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/girih|#[0-9a-f]{6}/i);
  });
  it('monogram takes the first grapheme, upper-cased', () => {
    expect(monogramOf('  qamar')).toBe('Q');
    expect(monogramOf('')).toBe('');
  });
});

describe('hero headline scale (PREMIUM-3)', () => {
  it('never drops under 36px: a 14/20/40px zone pick yields the 36-72px clamp', () => {
    for (const z of [undefined, '14px', '20px', '40px', '72px'])
      expect(heroHeadlineFontSize(z)).toBe(HERO_HEADLINE_SIZE);
    expect(HERO_HEADLINE_SIZE).toBe('clamp(2.25rem, 1.2rem + 4.4vw, 4.5rem)');
  });
  it('a larger merchant pick raises only the ceiling', () => {
    expect(heroHeadlineFontSize('96px')).toBe('clamp(2.25rem, 1.2rem + 4.4vw, 6rem)');
  });
  it('36px at 390 wide, 72px at 1440 (computed)', () => {
    const at = (vw: number) => Math.min(72, Math.max(36, 19.2 + 0.044 * vw));
    expect(Math.round(at(390))).toBe(36);
    expect(at(1440)).toBe(72);
  });
  it('every template hero headline reads the scale', () => {
    for (const f of ['./HeroBanner.tsx', './HeroCollage.tsx'])
      expect(src(f)).toContain('heroHeadlineFontSize');
    expect(src('../dahab/Hero.tsx')).toContain('clamp(2.25rem,1.2rem+4.4vw,4.5rem)');
  });
});

describe('grid fill (PREMIUM-4)', () => {
  it.each([
    [6, 4, 3],
    [8, 4, 4],
    [5, 4, 5],
    [9, 4, 3],
    [3, 4, 4],
    [4, 4, 4],
    [7, 4, 4],
    [12, 3, 3],
  ])('%i products, %i requested -> %i columns', (n, req, want) => {
    expect(fitDesktopColumns(n, req)).toBe(want);
  });
  it('a count that fits some column count has no orphan row', () => {
    for (let n = 4; n <= 24; n++) {
      const c = fitDesktopColumns(n, 4);
      if ([2, 3, 4, 5].some(k => n % k === 0 && k <= n)) expect(n % c).toBe(0);
    }
  });
});

describe('pause control (PREMIUM-3/4)', () => {
  it('hero toggle is a small round disc, not the 44px grey square', () => {
    const s = src('./AutoplayToggle.tsx');
    expect(s).toContain('rounded-full');
    expect(s).not.toContain('bg-background/80');
  });
  it('is rendered only when the hero/carousel actually autoplays', () => {
    expect(src('./HeroSlider.tsx')).toMatch(/\{canAutoplay && \(\s*<AutoplayToggle/);
    expect(src('./ProductCarousel.tsx')).toMatch(/\{canAutoplay && \(/);
  });
  it('the carousel pause is labelled with visible text', () => {
    expect(src('./ProductCarousel.tsx')).toContain("'إيقاف'");
  });
});
