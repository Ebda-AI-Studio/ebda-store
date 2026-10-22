// The /categories heading must be measured against the surface it sits on. A dark look
// (Qamar Lookbook) paints the listing on the INVERSE band (light ink); SectionHeading measured the
// dark page instead and painted a page-light heading onto the light band (live: 1.13:1).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOOKS, INVERSE_SURFACE, contrastRatio, pickReadableForeground } from '@ebda/shared';

describe('categories heading on the inverse band', () => {
  it('CategoriesClient hands the band to the grid as sectionBgColor', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/web/src/app/categories/CategoriesClient.tsx'),
      'utf8'
    );
    expect(src).toMatch(/sectionBgColor=\{lookBand \? INVERSE_SURFACE : undefined\}/);
  });

  for (const look of LOOKS.filter(l => l.tokens.page && l.tokens.ink))
    it(`${look.id}: the readable pick on the band (ink) reads >= 4.5`, () => {
      const band = look.tokens.ink; // the inverse band paints the page ink
      const fg = pickReadableForeground(band) ?? '#000000';
      expect(INVERSE_SURFACE).toBe('token:inverse');
      expect(contrastRatio(band, fg)).toBeGreaterThanOrEqual(4.5);
    });
});
