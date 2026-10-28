/**
 * Ruling B1-32 (Ahmad, STOP 1 #3): a hero slide carries an image focus so a cropped
 * (object-cover) hero keeps its subject; `top` keeps a model's head in the wide desktop crop.
 * Platform-wide: the shared HeroBanner (every legacy skin + qamar) and Dahab's hero.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { heroSlideSchema, heroObjectPosition, getSectionDefinition } from '@ebda/shared';

vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, style }: { src: string; alt?: string; style?: React.CSSProperties }) =>
    React.createElement('img', { src, alt, style }),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', isRtl: false, t: (en: string) => en }),
}));

describe('hero focus', () => {
  it('schema keeps a valid focus and refuses others', () => {
    expect(heroSlideSchema.parse({ image: 'a.webp', focus: 'top' }).focus).toBe('top');
    expect(heroSlideSchema.safeParse({ image: 'a.webp', focus: 'left' }).success).toBe(false);
  });
  it('maps to object-position; centre/unset is the browser default', () => {
    expect(heroObjectPosition('top')).toBe('50% 0%');
    expect(heroObjectPosition('bottom')).toBe('50% 100%');
    expect(heroObjectPosition('center')).toBeUndefined();
    expect(heroObjectPosition(undefined)).toBeUndefined();
  });
  it('the editor exposes it on the slide block', () => {
    const slide = getSectionDefinition('hero')!.blocks!.find(b => b.type === 'slide')!;
    expect(slide.settings.some(s => s.id === 'focus')).toBe(true);
  });
  it('shared HeroBanner paints the focus on a full-bleed image, not on a framed one', async () => {
    const { HeroBanner } = await import('../../apps/web/src/templates/shared/HeroBanner');
    const full = renderToStaticMarkup(
      <HeroBanner image="a.webp" focus="top" isRtl={false} pack="qamar" />
    );
    expect(full).toMatch(/object-position:50% 0%/);
    const framed = renderToStaticMarkup(
      <HeroBanner image="a.webp" focus="top" isRtl={false} pack="qamar" presentation="framed" />
    );
    expect(framed).not.toMatch(/object-position/);
    const none = renderToStaticMarkup(<HeroBanner image="a.webp" isRtl={false} pack="qamar" />);
    expect(none).not.toMatch(/object-position/);
  });
  it('Dahab hero paints the same focus', async () => {
    const { HeroBanner: DahabHero } =
      (await import('../../apps/web/src/templates/dahab/Hero')) as unknown as {
        HeroBanner?: React.ComponentType<Record<string, unknown>>;
      };
    const src = (await import('node:fs')).readFileSync(
      `${__dirname}/../../apps/web/src/templates/dahab/Hero.tsx`,
      'utf8'
    );
    expect(src).toMatch(/objectPosition: heroObjectPosition\(slide\.focus\)/);
    expect(src).toMatch(/position=\{heroObjectPosition\(slide\.focus\)\}/);
    void DahabHero;
  });
});
