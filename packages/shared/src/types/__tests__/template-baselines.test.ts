import { describe, it, expect } from 'vitest';
import {
  BASE_BRANDED_LAYOUT,
  BASE_IDENTITY,
  buildTemplateBaseline,
  TEMPLATE_LAYOUT_BASELINES,
  getTemplateBaseline,
  type TemplateIdentity,
} from '../template-baselines';
import { DEFAULT_LAYOUT_SETTINGS } from '../store-layout';
import { RETIRED_TEMPLATES, normalizeLegacyTemplate } from '../../templates/legacy-skin-map';

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

  it('carries no demo-shop content (empty hero slides, no marketing copy)', () => {
    expect(BASE_BRANDED_LAYOUT.hero.slides).toEqual([]);
    expect(BASE_BRANDED_LAYOUT.categories.title).toBeUndefined();
    expect(BASE_BRANDED_LAYOUT.categories.subtitle).toBeUndefined();
  });

  it('resets content-gating flags to the safe new-store defaults', () => {
    expect(BASE_BRANDED_LAYOUT.testimonials.enabled).toBe(false);
    expect(BASE_BRANDED_LAYOUT.reviewSection.enabled).toBe(false);
  });

  it('keeps the polished base style (frames, sizes, sizing contract)', () => {
    expect(BASE_BRANDED_LAYOUT.categories.showCardFrame).toBe(true);
    expect(BASE_BRANDED_LAYOUT.categories.desktopColumns).toBe(3);
    expect(BASE_BRANDED_LAYOUT.sizing.productImageAspect).toBe('1:1');
    expect(BASE_BRANDED_LAYOUT.productCardDefaults?.cardSize).toBe('xxs');
  });
});

const tileIdentity: TemplateIdentity = {
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
  categoryShape: 'rounded-square',
  categoryCaption: 'overlay',
  categoryShowFrame: false,
};

describe('buildTemplateBaseline', () => {
  it('applies the identity into every card surface', () => {
    const b = buildTemplateBaseline(tileIdentity);
    expect(b.newArrivals.cardSize).toBe('lg');
    expect(b.bestSellers.cardSize).toBe('lg');
    expect(b.productCardDefaults?.cardSize).toBe('lg');
    expect(b.categories.cardSize).toBe('md');
    expect(b.categories.desktopColumns).toBe(2);
    expect(b.newArrivals.cardFrameWidth).toBe('thick');
    expect(b.newArrivals.cardAspect).toBe('square');
    expect(b.sizing.productImageAspect).toBe('1:1');
  });

  it('applies category identity (shape/caption/frame) separately from product shape', () => {
    const b = buildTemplateBaseline(tileIdentity);
    expect(b.categories.captionPosition).toBe('overlay');
    expect(b.categories.showCardFrame).toBe(false);
    // category shape is independent of the product cardShape
    expect(b.categories.cardShape).toBe('rounded-square');
    expect(b.newArrivals.cardShape).toBe('rounded-square');
  });

  it('does not mutate BASE_BRANDED_LAYOUT', () => {
    buildTemplateBaseline(tileIdentity);
    expect(BASE_BRANDED_LAYOUT.newArrivals.cardSize).toBe('xs'); // unchanged
    expect(BASE_BRANDED_LAYOUT.categories.desktopColumns).toBe(3);
  });

  it('keeps every color a token after applying an identity', () => {
    const colors = collectColorValues(buildTemplateBaseline(tileIdentity));
    for (const c of colors) expect(c.startsWith('token:')).toBe(true);
  });
});

describe('TEMPLATE_LAYOUT_BASELINES', () => {
  const ids = ['dahab', 'qamar', 'souq', 'jasmine', 'lamma'] as const;

  it('has a baseline for every live template', () => {
    for (const id of ids) expect(TEMPLATE_LAYOUT_BASELINES[id]).toBeTruthy();
    expect(Object.keys(TEMPLATE_LAYOUT_BASELINES).sort()).toEqual([...ids].sort());
  });

  it('qamar builds from the shared base identity', () => {
    expect(TEMPLATE_LAYOUT_BASELINES.qamar.newArrivals.cardSize).toBe(
      BASE_IDENTITY.productCardSize
    );
    expect(TEMPLATE_LAYOUT_BASELINES.qamar.categories.desktopColumns).toBe(
      BASE_IDENTITY.desktopColumns
    );
  });

  it('every baseline is fully tokenized', () => {
    for (const id of ids) {
      const colors = collectColorValues(TEMPLATE_LAYOUT_BASELINES[id]);
      for (const c of colors) expect(c.startsWith('token:')).toBe(true);
    }
  });

  it('getTemplateBaseline returns the baseline, falls back for unknown id', () => {
    expect(getTemplateBaseline('qamar')).toBe(TEMPLATE_LAYOUT_BASELINES.qamar);
    expect(getTemplateBaseline('nope' as never)).toBe(DEFAULT_LAYOUT_SETTINGS);
  });

  it('a retired Force skin name reads as its mapped Ebda template (SKIN-DEL-1)', () => {
    for (const retired of RETIRED_TEMPLATES)
      expect(getTemplateBaseline(retired as never)).toBe(
        TEMPLATE_LAYOUT_BASELINES[normalizeLegacyTemplate(retired)]
      );
  });
});
