import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mockCssVars, mockTokensFor, MOCK_TOKENS } from '../../packages/shared/src';
import { LOOK_VAR_PATTERNS, buildThemeStyleTag } from '../../apps/web/src/lib/theme-css';
import { getLook } from '../../packages/shared/src/looks/registry';

describe('look mock tokens (template-match)', () => {
  it('every id in the table is a registered look', () => {
    for (const id of Object.keys(MOCK_TOKENS)) expect(getLook(id), id).toBeTruthy();
  });

  it('a look without tokens, or no look, emits nothing (byte-identical to before)', () => {
    expect(mockCssVars('qamar.lookbook')).toEqual({});
    expect(mockCssVars(null)).toEqual({});
    expect(mockCssVars('not.a.look')).toEqual({});
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
});
