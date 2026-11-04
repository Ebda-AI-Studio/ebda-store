/**
 * Storefront output for per-device spacing (editor Ruling SP-1 / SP-2 / SP-3).
 * Unset and desktop-only input must give exactly the pre-existing classes.
 */
import { describe, it, expect } from 'vitest';
import { SECTION_SPACING_PRESETS, SECTION_SPACING_PX } from '@ebda/shared';
import {
  DEVICE_SPACING_CLASSES,
  sectionMarginClasses,
  sectionSpacingClasses,
} from '../../apps/web/src/templates/shared/section-spacing';

const LOOK = 'qamar.atelier';

describe('desktop-only / unset output is unchanged', () => {
  it('matches the pre-existing classes', () => {
    expect(sectionSpacingClasses(undefined).wrapperClass).toBe('py-12 sm:py-16 lg:py-20');
    expect(sectionSpacingClasses({ paddingTop: 'loose' }).wrapperClass).toBe(
      'pt-16 sm:pt-20 lg:pt-28 pb-12 sm:pb-16 lg:pb-20'
    );
    expect(
      sectionSpacingClasses({ paddingTop: 'none', paddingBottom: 'xloose' }, LOOK).wrapperClass
    ).toBe('pt-0 pb-24 sm:pb-28 lg:pb-36');
  });
  it('xxloose is one step above xloose', () => {
    expect(sectionSpacingClasses({ paddingTop: 'xxloose' }).wrapperClass).toContain(
      'pt-28 sm:pt-36 lg:pt-44'
    );
  });
});

describe('mobile != desktop', () => {
  const s = { paddingTop: 'loose', paddingTopMobile: 'tight', paddingBottom: 'none' } as const;
  it('emits all three devices for the per-device axis only', () => {
    const w = sectionSpacingClasses(s).wrapperClass;
    expect(w).toBe('max-md:pt-4 md:max-lg:pt-20 lg:pt-28 pb-0');
  });
  it('tablet unset falls to the base value, then the baseline', () => {
    expect(sectionSpacingClasses({ paddingBottomMobile: 'none' }).wrapperClass).toBe(
      'pt-12 sm:pt-16 lg:pt-20 max-md:pb-0 md:max-lg:pb-16 lg:pb-20'
    );
  });
  it('a per-device axis carries no density marker; the other axis keeps it (SP-2)', () => {
    const w = sectionSpacingClasses({ paddingTopMobile: 'none' }, LOOK).wrapperClass;
    expect(w).not.toContain('sp-top-default');
    expect(w).toContain('sp-bottom-default');
  });
  it('is not emitted without a tablet / mobile value', () => {
    expect(sectionSpacingClasses({ paddingTop: 'tight' }).wrapperClass).not.toContain('max-md');
  });
});

describe('hero outer margin (SP-3)', () => {
  it('unset adds nothing', () => {
    expect(sectionMarginClasses(undefined)).toBe('');
    expect(sectionMarginClasses({})).toBe('');
    expect(sectionMarginClasses({ hideOnMobile: true })).toBe('');
  });
  it('a base value is a responsive margin; per device is emitted for all three', () => {
    expect(sectionMarginClasses({ paddingTop: 'tight' })).toBe('mt-4 sm:mt-6 lg:mt-8');
    expect(sectionMarginClasses({ paddingBottom: 'loose', paddingBottomMobile: 'none' })).toBe(
      'max-md:mb-0 md:max-lg:mb-20 lg:mb-28'
    );
  });
});

describe('class table is pinned to the shared px table', () => {
  it('every literal class is SECTION_SPACING_PX / 4 on its device', () => {
    for (const prefix of ['pt', 'pb', 'mt', 'mb'] as const) {
      for (const device of ['mobile', 'tablet', 'desktop'] as const) {
        const row = DEVICE_SPACING_CLASSES[prefix][device];
        expect(row).toHaveLength(SECTION_SPACING_PRESETS.length);
        row.forEach((cls, i) => {
          const n = Number(/-(\d+)$/.exec(cls)![1]);
          expect(n * 4, `${cls}`).toBe(SECTION_SPACING_PX[SECTION_SPACING_PRESETS[i]][device]);
        });
      }
    }
  });
  it('the single-class steps agree with the tablet / desktop columns of the px table', () => {
    // sm: = 640 (tablet column), lg: = 1024 (desktop column); the mobile base is the mobile column.
    const w = (p: (typeof SECTION_SPACING_PRESETS)[number]) =>
      sectionSpacingClasses({ paddingTop: p }).wrapperClass.split(' ');
    for (const p of SECTION_SPACING_PRESETS.filter(x => x !== 'none')) {
      const [m, sm, lg] = w(p)
        .slice(0, 3)
        .map(c => Number(/-(\d+)$/.exec(c)![1]) * 4);
      expect(m).toBe(SECTION_SPACING_PX[p].mobile);
      expect(sm).toBe(SECTION_SPACING_PX[p].tablet);
      expect(lg).toBe(SECTION_SPACING_PX[p].desktop);
    }
  });
});
