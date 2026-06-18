import { describe, it, expect } from 'vitest';
import { KUWAIT_GOVERNORATES, areasForGovernorate, findGovernorateByArea } from '@force/shared';

describe('kuwait-areas dataset', () => {
  it('has exactly 6 governorates', () => {
    expect(KUWAIT_GOVERNORATES).toHaveLength(6);
  });
  it('every area has non-empty EN and AR', () => {
    for (const g of KUWAIT_GOVERNORATES) {
      expect(g.en && g.ar).toBeTruthy();
      for (const a of g.areas) {
        expect(a.en.trim()).not.toBe('');
        expect(a.ar.trim()).not.toBe('');
      }
    }
  });
  it('has no duplicate area EN names within a governorate', () => {
    for (const g of KUWAIT_GOVERNORATES) {
      const ens = g.areas.map(a => a.en);
      expect(new Set(ens).size).toBe(ens.length);
    }
  });
  it('areasForGovernorate returns Hawalli areas incl. Salmiya', () => {
    expect(areasForGovernorate('Hawalli').some(a => a.en === 'Salmiya')).toBe(true);
  });
  it('findGovernorateByArea maps Salmiya → Hawalli', () => {
    expect(findGovernorateByArea('Salmiya')?.en).toBe('Hawalli');
  });
});
