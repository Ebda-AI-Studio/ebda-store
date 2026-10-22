import { describe, it, expect } from 'vitest';
import { LOOKS } from '@ebda/shared';

describe('B1 to B5 flip the Qamar, Souq, Jasmine, Lamma and Dahab looks to built', () => {
  it('every look of the five templates is built (Phase B5 flipped the last three)', () => {
    for (const l of LOOKS)
      expect(l.status, l.id).toBe(
        ['qamar', 'souq', 'jasmine', 'lamma', 'dahab'].includes(l.template) ? 'built' : 'designed'
      );
    expect(LOOKS.filter(l => l.template === 'dahab').map(l => l.id)).toEqual([
      'dahab.worn',
      'dahab.workshop',
      'dahab.giftbox',
    ]);
  });
  it('every built look has a skin of its own template and a section mix', () => {
    for (const l of LOOKS.filter(l => l.status === 'built')) {
      expect(l.skin).toBe(l.template);
      expect(l.sections?.length).toBeGreaterThan(0);
      expect(l.chrome).toBeDefined();
    }
  });
});
