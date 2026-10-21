import { describe, it, expect } from 'vitest';
import { sectionSpacingClasses } from '../../apps/web/src/templates/shared/section-spacing';

const LOOK = 'qamar.atelier';

describe('sectionSpacingClasses: --space-unit marker', () => {
  it('unset on a look store: both axes marked', () => {
    expect(sectionSpacingClasses(undefined, LOOK).wrapperClass).toContain('sp-top-default');
    expect(sectionSpacingClasses(undefined, LOOK).wrapperClass).toContain('sp-bottom-default');
    const w = sectionSpacingClasses({}, LOOK).wrapperClass;
    expect(w).toContain('sp-top-default');
    expect(w).toContain('sp-bottom-default');
  });
  it('explicit "normal" on a look store: no marker (merchant choice wins)', () => {
    const w = sectionSpacingClasses(
      { paddingTop: 'normal', paddingBottom: 'normal' },
      LOOK
    ).wrapperClass;
    expect(w).not.toContain('sp-');
    expect(w).toContain('pt-12 sm:pt-16 lg:pt-20');
  });
  it('mixed: only the unset axis is marked', () => {
    const w = sectionSpacingClasses({ paddingTop: 'tight' }, LOOK).wrapperClass;
    expect(w).not.toContain('sp-top-default');
    expect(w).toContain('sp-bottom-default');
  });
  it('legacy / unknown look: output identical to the no-look call, no marker', () => {
    for (const look of [undefined, null, 'nope.unknown']) {
      for (const s of [
        undefined,
        {},
        { paddingTop: 'normal' as const },
        { paddingBottom: 'loose' as const },
      ]) {
        expect(sectionSpacingClasses(s, look)).toEqual(sectionSpacingClasses(s));
        expect(sectionSpacingClasses(s, look).wrapperClass).not.toContain('sp-');
      }
    }
    expect(sectionSpacingClasses(undefined).wrapperClass).toBe('py-12 sm:py-16 lg:py-20');
  });
});

// AT-1 (independent audit): on Atelier (airy) the gap between home sections measured
// 120-150px at 390, so the page read unfinished rather than airy. On a phone the default
// section rhythm caps at 80px between sections for the airiest density.
describe('look section rhythm on a phone (AT-1)', () => {
  it('top + bottom default padding at the airiest density stays at or under 80px', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { LOOK_SPACE_UNIT } = await import('@ebda/shared');
    const css = readFileSync(join(__dirname, '../../apps/web/src/styles/globals.css'), 'utf8');
    const base = (sel: string) => {
      const i = css.indexOf(`[data-look] ${sel} {`);
      const m = /calc\(([\d.]+)rem \* var\(--space-unit, 1\)\)/.exec(css.slice(i, i + 120));
      return Number(m![1]) * 16;
    };
    const airy = Math.max(...Object.values(LOOK_SPACE_UNIT).map(Number));
    expect((base('.sp-top-default') + base('.sp-bottom-default')) * airy).toBeLessThanOrEqual(80);
  });
});
