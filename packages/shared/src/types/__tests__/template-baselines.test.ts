import { describe, it, expect } from 'vitest';
import {
  BASE_BRANDED_LAYOUT,
  buildTemplateBaseline,
  TEMPLATE_LAYOUT_BASELINES,
  getTemplateBaseline,
  type TemplateIdentity,
} from '../template-baselines';
import { DEFAULT_LAYOUT_SETTINGS } from '../store-layout';

// Recursively collect every string value under a `*[cC]olor` / bgColor / customColor key.
function collectColorValues(obj: unknown, out: string[] = []): string[] {
  if (Array.isArray(obj)) {
    obj.forEach(v => collectColorValues(v, out));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && /color$/i.test(k) && v.length > 0) out.push(v);
      else collectColorValues(v, out);
    }
  }
  return out;
}

describe('BASE_BRANDED_LAYOUT', () => {
  it('every color value is a brand token (no hardcoded colors)', () => {
    const colors = collectColorValues(BASE_BRANDED_LAYOUT);
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) expect(c.startsWith('token:')).toBe(true);
  });

  it('carries no wadyaljuz content (empty hero slides, no marketing copy)', () => {
    expect(BASE_BRANDED_LAYOUT.hero.slides).toEqual([]);
    expect(BASE_BRANDED_LAYOUT.categories.title).toBeUndefined();
    expect(BASE_BRANDED_LAYOUT.categories.subtitle).toBeUndefined();
  });

  it('resets content-gating flags to the safe new-store defaults', () => {
    expect(BASE_BRANDED_LAYOUT.testimonials.enabled).toBe(false);
    expect(BASE_BRANDED_LAYOUT.reviewSection.enabled).toBe(false);
  });

  it('keeps the polished elegant style (frames, sizes, sizing contract)', () => {
    expect(BASE_BRANDED_LAYOUT.categories.showCardFrame).toBe(true);
    expect(BASE_BRANDED_LAYOUT.categories.desktopColumns).toBe(3);
    expect(BASE_BRANDED_LAYOUT.sizing.productImageAspect).toBe('1:1');
    expect(BASE_BRANDED_LAYOUT.productCardDefaults?.cardSize).toBe('xxs');
  });
});

const boldIdentity: TemplateIdentity = {
  productCardSize: 'lg',
  categoryCardSize: 'md',
  frameWidth: 'thick',
  frameSize: 'compact',
  cardGap: 'tight',
  desktopColumns: 2,
  mobileColumns: 2,
  cardShape: 'rounded-square',
  productAspect: 'square',
  productImageAspect: '1:1',
};

describe('buildTemplateBaseline', () => {
  it('applies the identity into every card surface', () => {
    const b = buildTemplateBaseline(boldIdentity);
    expect(b.newArrivals.cardSize).toBe('lg');
    expect(b.bestSellers.cardSize).toBe('lg');
    expect(b.productCardDefaults?.cardSize).toBe('lg');
    expect(b.categories.cardSize).toBe('md');
    expect(b.categories.desktopColumns).toBe(2);
    expect(b.newArrivals.cardFrameWidth).toBe('thick');
    expect(b.newArrivals.cardAspect).toBe('square');
    expect(b.sizing.productImageAspect).toBe('1:1');
  });

  it('does not mutate BASE_BRANDED_LAYOUT', () => {
    buildTemplateBaseline(boldIdentity);
    expect(BASE_BRANDED_LAYOUT.newArrivals.cardSize).toBe('xs'); // unchanged
    expect(BASE_BRANDED_LAYOUT.categories.desktopColumns).toBe(3);
  });

  it('keeps every color a token after applying an identity', () => {
    const colors = collectColorValues(buildTemplateBaseline(boldIdentity));
    for (const c of colors) expect(c.startsWith('token:')).toBe(true);
  });
});

describe('TEMPLATE_LAYOUT_BASELINES', () => {
  const ids = ['modern', 'elegant', 'classic', 'minimal', 'bold'] as const;

  it('has a baseline for all 5 templates', () => {
    for (const id of ids) expect(TEMPLATE_LAYOUT_BASELINES[id]).toBeTruthy();
  });

  it('elegant equals the calibrated base verbatim', () => {
    expect(TEMPLATE_LAYOUT_BASELINES.elegant).toEqual(BASE_BRANDED_LAYOUT);
  });

  it('templates are proportionally distinct (bold ≠ minimal on product card size)', () => {
    expect(TEMPLATE_LAYOUT_BASELINES.bold.newArrivals.cardSize).not.toBe(
      TEMPLATE_LAYOUT_BASELINES.minimal.newArrivals.cardSize
    );
    expect(TEMPLATE_LAYOUT_BASELINES.modern.categories.desktopColumns).not.toBe(
      TEMPLATE_LAYOUT_BASELINES.bold.categories.desktopColumns
    );
  });

  it('every baseline is fully tokenized', () => {
    for (const id of ids) {
      const colors = collectColorValues(TEMPLATE_LAYOUT_BASELINES[id]);
      for (const c of colors) expect(c.startsWith('token:')).toBe(true);
    }
  });

  it('getTemplateBaseline returns the baseline, falls back for unknown id', () => {
    expect(getTemplateBaseline('bold')).toBe(TEMPLATE_LAYOUT_BASELINES.bold);
    expect(getTemplateBaseline('nope' as never)).toBe(DEFAULT_LAYOUT_SETTINGS);
  });
});
