import { describe, it, expect } from 'vitest';
import {
  EGYPT_GOVERNORATES,
  REGION,
  areasForGovernorate,
  findGovernorateByArea,
  findGovernorate,
} from '@force/shared';

describe('egypt-areas dataset', () => {
  it('has exactly 27 governorates, matching REGION.governorates', () => {
    expect(EGYPT_GOVERNORATES).toHaveLength(27);
    expect(REGION.governorates).toHaveLength(27);
    expect(EGYPT_GOVERNORATES.map(g => g.code)).toEqual(REGION.governorates.map(g => g.code));
  });
  it('governorate codes are unique ISO 3166-2:EG style codes and names are non-empty', () => {
    expect(new Set(REGION.governorates.map(g => g.code)).size).toBe(27);
    for (const g of REGION.governorates) {
      expect(g.code).toMatch(/^[A-Z]{1,3}$/);
      expect(g.nameEn.trim()).not.toBe('');
      expect(g.nameAr.trim()).not.toBe('');
    }
  });
  it('every governorate has at least one area with non-empty EN and AR', () => {
    for (const g of EGYPT_GOVERNORATES) {
      expect(g.areas.length).toBeGreaterThan(0);
      for (const a of g.areas) {
        expect(a.en.trim()).not.toBe('');
        expect(a.ar.trim()).not.toBe('');
      }
    }
  });
  it('has no duplicate area EN names within a governorate', () => {
    for (const g of EGYPT_GOVERNORATES) {
      const ens = g.areas.map(a => a.en);
      expect(new Set(ens).size).toBe(ens.length);
    }
  });
  it('areasForGovernorate returns Cairo areas incl. Maadi', () => {
    expect(areasForGovernorate('Cairo').some(a => a.en === 'Maadi')).toBe(true);
  });
  it('findGovernorateByArea maps Dokki → Giza', () => {
    expect(findGovernorateByArea('Dokki')?.en).toBe('Giza');
  });
  it('findGovernorate resolves by code, English and Arabic name', () => {
    expect(findGovernorate('ALX')?.nameEn).toBe('Alexandria');
    expect(findGovernorate('alexandria')?.code).toBe('ALX');
    expect(findGovernorate('الإسكندرية')?.code).toBe('ALX');
    expect(findGovernorate('Atlantis')).toBeUndefined();
  });
});
