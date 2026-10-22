/**
 * W2a (quality bar L-04, VT-02): the hero section design key `textAnchor: 'bottom-start'`.
 * - The scrim covers the text block only and is measured BY IMPORT (HERO_TEXT_SCRIM): white text
 *   over it over a white photo is >= 4.5:1, so the headline (>= 3:1) and the line both pass.
 * - A single banner puts the copy under the photo below `xl` (no scrim at all there) and over the
 *   photo's bottom-start corner from `xl`; a slider does the same (W2a fix round 1, I-1): the
 *   active slide's copy sits under the track below `xl` and on the photo from `xl`.
 * - Absent / 'center' renders the centred overlay exactly as before (no copy block, no scrim).
 * - Atelier and Vitrine set it through their mix; Lookbook (collage) does not.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  contrastRatio,
  getLook,
  getSectionDefinition,
  storeLayoutSchema,
  LOOK_DESIGN_KEYS,
} from '@ebda/shared';
import { HERO_TEXT_SCRIM, getPackStyles } from '../../apps/web/src/templates/shared/pack-styles';

vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, className }: { src: string; alt?: string; className?: string }) =>
    React.createElement('img', { src, alt, className }),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));

const { HeroBanner } = await import('../../apps/web/src/templates/shared/HeroBanner');
const { HeroSlider } = await import('../../apps/web/src/templates/shared/HeroSlider');

const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
/** `fg` at `alpha` composited over the opaque `bg` (both #rrggbb). */
function over(fg: string, alpha: number, bg: string): string {
  const c = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return (
    '#' + [1, 3, 5].map(i => hex(c(fg, i) * alpha + c(bg, i) * (1 - alpha))).join('')
  ).toUpperCase();
}

const slide = {
  image: '/hero.webp',
  alt: 'A woman in a linen abaya',
  headline: 'Linen for the Cairo summer',
  headlineAr: 'كتان لصيف القاهرة',
  subtitle: 'New pieces every week',
  ctaText: 'Shop abayas',
  ctaHref: '/products',
};

describe('the anchored hero scrim, measured by import', () => {
  const [r, g, b] = HERO_TEXT_SCRIM.rgb.split(' ').map(Number);
  it('the rgb channels and the hex name the same colour', () => {
    expect(`#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase()).toBe(HERO_TEXT_SCRIM.hex);
  });
  it('white text over the solid part on a WHITE photo pixel is >= 4.5:1 (the worst photo)', () => {
    const bg = over(HERO_TEXT_SCRIM.hex, HERO_TEXT_SCRIM.alpha, '#FFFFFF');
    expect(contrastRatio(bg, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });
  it('the line (white/90) over the same pixel is >= 4.5:1; the headline is far above 3:1', () => {
    const bg = over(HERO_TEXT_SCRIM.hex, HERO_TEXT_SCRIM.alpha, '#FFFFFF');
    expect(contrastRatio(bg, over('#FFFFFF', 0.9, bg))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(bg, '#FFFFFF')).toBeGreaterThanOrEqual(3);
  });
  it('the button (#141414 on white) is >= 4.5:1', () => {
    expect(contrastRatio('#FFFFFF', '#141414')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('HeroBanner textAnchor', () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      React.createElement(HeroBanner, { ...slide, isRtl: false, pack: 'qamar', ...props } as never)
    );

  it('absent: the centred overlay as before (no copy block, no anchored scrim)', () => {
    const html = render({});
    expect(html).not.toContain('data-part="hero-copy"');
    expect(html).not.toContain('data-hero-anchor');
    expect(html).toContain(getPackStyles('qamar').heroOverlay);
    expect(render({ textAnchor: 'center' })).toBe(html);
  });

  it('bottom-start on a single banner: copy follows the photo, scrim only from xl, no whole-photo wash', () => {
    const html = render({ textAnchor: 'bottom-start' });
    expect(html).toContain('data-hero-anchor="bottom-start"');
    expect(html).toContain('data-anchor="stacked"');
    expect(html).not.toContain(getPackStyles('qamar').heroOverlay);
    // the copy block sits AFTER the photo's <section> (in flow below xl), not inside it
    expect(html.indexOf('data-part="hero-copy"')).toBeGreaterThan(html.indexOf('</section>'));
    // the scrim element is hidden until xl and paints exactly the constant
    const scrim = html.match(/<span[^>]*data-part="hero-scrim"[^>]*>/)![0];
    expect(scrim).toContain('hidden xl:block');
    expect(scrim).toContain(`rgb(${HERO_TEXT_SCRIM.rgb} / ${HERO_TEXT_SCRIM.alpha})`);
    expect(scrim).toContain(`calc(100% - ${HERO_TEXT_SCRIM.fade})`);
    // below xl the copy is page text on the page: ink headline, primary button
    expect(html).toMatch(
      /<h1[^>]*class="[^"]*text-foreground[^"]*xl:text-\[color:var\(--hero-ink\)\]/
    );
    expect(html).toMatch(/<h1[^>]*class="[^"]*text-balance/);
    const button = html.match(/<a[^>]*data-cta="button"[^>]*>/)![0];
    expect(button).toContain('bg-primary text-primary-foreground');
    expect(button).toContain('xl:bg-white xl:text-[#141414]');
  });

  it('bottom-start in a slider: the copy is on the photo from xl ONLY (never on a phone/tablet slide)', () => {
    const html = render({ textAnchor: 'bottom-start', inSlider: true });
    const copy = html.match(/<div[^>]*data-part="hero-copy"[^>]*>/)![0];
    expect(copy).toContain('data-anchor="corner"');
    // hidden below xl: a 390x292 / 820x299 slide could not keep >= 60% of the photo clear
    expect(copy).toMatch(/class="[^"]*\bhidden\b[^"]*\bxl:block\b/);
    expect(copy).toContain(`rgb(${HERO_TEXT_SCRIM.rgb} / ${HERO_TEXT_SCRIM.alpha})`);
    expect(html.indexOf('data-part="hero-copy"')).toBeLessThan(html.indexOf('</section>'));
  });

  it('copyOnly renders just the page-text copy, hidden from xl (HeroSlider below the track)', () => {
    const html = render({ textAnchor: 'bottom-start', inSlider: true, copyOnly: true });
    expect(html).not.toContain('<section');
    expect(html).not.toContain('<img');
    expect(html).toMatch(/^<div class="xl:hidden">/);
    expect(html).toContain('data-anchor="stacked"');
    expect(html).toMatch(/<h1[^>]*class="[^"]*text-foreground/);
  });

  it('the slider puts the active slide copy under the track below xl, the corner copy only from xl', () => {
    const html = renderToStaticMarkup(
      React.createElement(HeroSlider, {
        slides: [slide, { ...slide, image: '/b.webp', headline: 'Second slide' }],
        pack: 'qamar',
        textAnchor: 'bottom-start',
      } as never)
    );
    const corners = html.match(/<div[^>]*data-anchor="corner"[^>]*>/g) ?? [];
    expect(corners).toHaveLength(2);
    // RED on the old behaviour: no corner copy may be visible below xl
    for (const c of corners) expect(c).toMatch(/class="[^"]*\bhidden\b[^"]*\bxl:block\b/);
    // exactly one below-track block, for the active (first) slide, after the photo track
    const below = html.match(/<div class="xl:hidden">/g) ?? [];
    expect(below).toHaveLength(1);
    expect(html.lastIndexOf('data-anchor="stacked"')).toBeGreaterThan(html.lastIndexOf('<img'));
    expect(html).toContain('absolute bottom-4 end-4 z-20');
  });

  it('a centred slider keeps its dots where they were (unchanged markup)', () => {
    const html = renderToStaticMarkup(
      React.createElement(HeroSlider, {
        slides: [slide, { ...slide, image: '/b.webp' }],
        pack: 'qamar',
      } as never)
    );
    expect(html).not.toContain('xl:hidden');
    expect(html).toContain('absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2');
  });

  it('Arabic copy anchors at the inline start of an RTL hero', () => {
    const html = render({ textAnchor: 'bottom-start', isRtl: true });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('كتان لصيف القاهرة');
    expect(html).toMatch(/data-part="hero-copy"[^>]*class="[^"]*text-start/);
  });
});

describe('textAnchor: schema, editors and the looks that set it', () => {
  it('the layout schema accepts the two values only', () => {
    const h = storeLayoutSchema.shape.hero;
    const base = { enabled: true, mode: 'single', autoplayMs: 5000, slides: [] };
    expect(h.safeParse({ ...base, textAnchor: 'bottom-start' }).success).toBe(true);
    expect(h.safeParse({ ...base, textAnchor: 'center' }).success).toBe(true);
    expect(h.safeParse({ ...base, textAnchor: 'top-end' }).success).toBe(false);
  });
  it('the builder registry offers it (ar + en) and it is a look design key', () => {
    const sel = getSectionDefinition('hero')!.settings.find(x => x.id === 'textAnchor') as {
      options: { value: unknown }[];
      labelAr: string;
    };
    expect(sel.options.map(o => o.value)).toEqual(['center', 'bottom-start']);
    expect(sel.labelAr).toBe('موضع النص');
    expect(LOOK_DESIGN_KEYS).toContain('textAnchor');
  });
  it('Atelier and Vitrine anchor bottom-start; Lookbook (collage) leaves it unset', () => {
    const heroDesign = (id: string) =>
      (getLook(id)!.sections!.find(s => s.type === 'hero')!.design ?? {}) as Record<
        string,
        unknown
      >;
    expect(heroDesign('qamar.atelier').textAnchor).toBe('bottom-start');
    expect(heroDesign('qamar.vitrine').textAnchor).toBe('bottom-start');
    expect(heroDesign('qamar.lookbook')).not.toHaveProperty('textAnchor');
  });
  it('the renderer passes the section value to the banner and the slider', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/builder/render/PageRenderer.tsx'),
      'utf8'
    );
    expect(src.match(/textAnchor=\{layout\.hero\.textAnchor\}/g)?.length).toBe(2);
  });
});
