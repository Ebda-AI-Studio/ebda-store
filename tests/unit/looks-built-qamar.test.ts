import { describe, it, expect } from 'vitest';
import { LOOKS } from '@ebda/shared';

describe('B1, B2 and B3 flip exactly the Qamar, Souq and Jasmine looks to built', () => {
  it('qamar, souq and jasmine built, everything else designed', () => {
    for (const l of LOOKS)
      expect(l.status, l.id).toBe(
        ['qamar', 'souq', 'jasmine'].includes(l.template) ? 'built' : 'designed'
      );
  });
  it('every built look has a skin of its own template and a section mix', () => {
    for (const l of LOOKS.filter(l => l.status === 'built')) {
      expect(l.skin).toBe(l.template);
      expect(l.sections?.length).toBeGreaterThan(0);
      expect(l.chrome).toBeDefined();
    }
  });
});
