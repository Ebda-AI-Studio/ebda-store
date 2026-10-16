/**
 * Task 8 review M4 (W2a): the occasion bands (`collection-list` `tileShape: 'band'`) render on
 * every skin, painting `bg-primary text-primary-foreground`, `bg-accent text-accent-foreground`
 * and `bg-border text-foreground` (BAND_TONES). The labels are large display text (>= 30px), so
 * each pair must read at >= 3:1 on every skin baseline, not only on the Vitrine look.
 */
import { describe, it, expect } from 'vitest';
import { TEMPLATE_THEMES, contrastRatio, getTemplateTheme, type TemplateId } from '@ebda/shared';
import {
  BAND_TONES,
  bandTextOverride,
} from '../../apps/web/src/builder/sections/CollectionListSection';

const hsl = (t: string) => (t.startsWith('#') || t.startsWith('hsl(') ? t : `hsl(${t})`);

describe('band tone pairs on every skin baseline (>= 3:1, large text)', () => {
  it('the tones are the three pairs this test measures', () => {
    expect(BAND_TONES).toEqual({
      primary: 'bg-primary text-primary-foreground',
      accent: 'bg-accent text-accent-foreground',
      line: 'bg-border text-foreground',
    });
  });
  for (const id of Object.keys(TEMPLATE_THEMES) as TemplateId[]) {
    const t = getTemplateTheme(id);
    it(`${id}: primary, accent and line bands read >= 3:1 as painted`, () => {
      const painted = (tone: 'primary' | 'accent' | 'line', fill: string, text: string) =>
        contrastRatio(hsl(fill), bandTextOverride(tone, t) ?? hsl(text));
      expect(painted('primary', t.primaryColor, t.primaryForeground)).toBeGreaterThanOrEqual(3);
      expect(painted('accent', t.accentColor, t.accentForeground)).toBeGreaterThanOrEqual(3);
      expect(painted('line', t.borderColor, t.foregroundColor)).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('bandTextOverride changes only a pair that fails', () => {
  it('modern primary (white on orange, 2.81:1) gets the readable ink', () => {
    const t = getTemplateTheme('modern');
    expect(contrastRatio(hsl(t.primaryColor), hsl(t.primaryForeground))).toBeLessThan(3);
    expect(bandTextOverride('primary', t)).toBe('#000000');
  });
  it('a pair that reads is left to its on-token (no inline colour)', () => {
    for (const id of Object.keys(TEMPLATE_THEMES) as TemplateId[])
      expect(bandTextOverride('line', getTemplateTheme(id)), id).toBeUndefined();
  });
});
