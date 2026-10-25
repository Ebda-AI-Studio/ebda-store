import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { headingWeight, mockCssVars, mockTokensFor, MOCK_TOKENS } from '../../packages/shared/src';
import { LOOK_FONT_SPECS } from '../../packages/shared/src/looks/fonts';
import { LOOKS } from '../../packages/shared/src/looks/registry';
import { LOOK_VAR_PATTERNS, buildThemeStyleTag } from '../../apps/web/src/lib/theme-css';
import { getLook } from '../../packages/shared/src/looks/registry';

describe('look mock tokens (template-match)', () => {
  it('every id in the table is a registered look', () => {
    for (const id of Object.keys(MOCK_TOKENS)) expect(getLook(id), id).toBeTruthy();
  });

  it('a look without a hero ratio sets no hero variables; no look or an unknown one emits nothing', () => {
    const v = mockCssVars('qamar.lookbook');
    expect(v['--look-hero-aspect']).toBeUndefined();
    expect(v['--bottom-tab-h']).toBe('57px');
    expect(mockCssVars(null)).toEqual({});
    expect(mockCssVars('not.a.look')).toEqual({});
  });

  it('every built look has a heading size, and its weight is one its display face really loads', () => {
    for (const l of LOOKS) {
      expect(mockTokensFor(l.id).headingSize, l.id).toBeGreaterThanOrEqual(20);
      const spec = LOOK_FONT_SPECS[l.tokens.fonts.display] ?? '';
      const loaded = spec ? (spec.split('@')[1] ?? '').split(';').map(Number) : [400];
      expect(loaded, `${l.id} ${l.tokens.fonts.display}`).toContain(headingWeight(l.id));
    }
  });

  it('every emitted variable has a strict allow-list pattern and its value passes it', () => {
    for (const id of Object.keys(MOCK_TOKENS))
      for (const [k, val] of Object.entries(mockCssVars(id))) {
        expect(LOOK_VAR_PATTERNS[k], `${id} ${k}`).toBeDefined();
        expect(LOOK_VAR_PATTERNS[k].test(val), `${id} ${k}=${val}`).toBe(true);
      }
  });

  it('the hero ratio reaches the :root style tag for a look store only', () => {
    const css = buildThemeStyleTag({} as never, 'qamar.atelier');
    expect(css).toContain('--look-hero-aspect: 3 / 4');
    expect(css).toContain('--look-hero-maxh: none');
    expect(buildThemeStyleTag({} as never, null)).not.toContain('--look-hero');
  });

  it('portrait looks set a ratio taller than wide, landscape ones the reverse', () => {
    const r = (id: string) => {
      const [w, h] = (mockTokensFor(id).heroAspect ?? '1 / 1').split('/').map(Number);
      return w / h;
    };
    expect(r('qamar.atelier')).toBeLessThan(1);
    expect(r('dahab.giftbox')).toBeGreaterThan(1);
  });

  it('the globals.css rule matches the utility classes the hero boxes really carry', () => {
    const web = path.resolve(__dirname, '../../apps/web/src');
    const css = readFileSync(path.join(web, 'styles/globals.css'), 'utf8');
    expect(css).toContain('[data-look] .aspect-\\[var\\(--hero-m-aspect\\)\\].max-h-\\[45vh\\]');
    for (const f of ['HeroBanner', 'HeroSlider'])
      expect(readFileSync(path.join(web, `templates/shared/${f}.tsx`), 'utf8')).toMatch(
        /aspect-\[var\(--hero-m-aspect\)\][^'`"]*max-h-\[45vh\]/
      );
  });

  it('the slimmed tab bar keeps 5 tabs, 12 px labels and a >= 44 px target', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/templates/shared/BottomTabBar.tsx'),
      'utf8'
    );
    expect(src).toContain('grid-cols-5');
    expect(src).toContain('text-xs');
    expect(
      Number.parseInt(mockCssVars('qamar.atelier')['--bottom-tab-h'], 10) - 1
    ).toBeGreaterThanOrEqual(44);
  });

  it('card chrome markers are rendered for look stores only and hidden only inside home sections', () => {
    const web = path.resolve(__dirname, '../../apps/web/src');
    const card = readFileSync(path.join(web, 'templates/shared/StorefrontProductCard.tsx'), 'utf8');
    expect(card.match(/onLook \? \{ 'data-chrome': '(heart|badge)' \} : \{\}/g)?.length).toBe(4);
    expect(card).toContain("onLook ? 'mt-1 look-card-chrome' : 'mt-1'");
    const css = readFileSync(path.join(web, 'styles/globals.css'), 'utf8');
    expect(css).toContain('[data-look] [data-section] [data-chrome]');
    expect(css).toContain('[data-look] [data-section] .look-card-chrome');
  });
});
