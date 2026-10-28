import { describe, expect, it } from 'vitest';
import { areaKeyFor } from '../../apps/api/src/lib/ci/area-key';

describe('areaKeyFor', () => {
  it.each([
    [{ state: 'Cairo', city: 'Nasr City' }, 'EG-C-nasr-city', 'district'],
    [{ state: 'القاهرة', city: 'مدينة نصر' }, 'EG-C-nasr-city', 'district'],
    [{ state: 'Giza', area: '6th of October' }, 'EG-GZ-6th-october', 'district'],
    [{ state: 'Alexandria', city: 'Smouha' }, 'EG-ALX-smouha', 'district'],
    [{ state: 'Cairo', city: 'Some Unlisted Place' }, 'EG-C', 'governorate'],
    [{ state: 'محافظة الجيزة' }, 'EG-GZ', 'governorate'],
    [{ city: 'Maadi' }, 'EG-C-maadi', 'district'], // governorate derived from the district
    [{ state: 'Cairo', city: 'Mohandessin' }, 'EG-C', 'governorate'], // a Giza district under Cairo is NOT guessed
  ])('%j -> %s', (inp, key, level) => {
    expect(areaKeyFor(inp)).toEqual({ areaKey: key, level });
  });

  it('is null for a foreign or unnameable destination', () => {
    expect(areaKeyFor({ country: 'SA', state: 'Riyadh' }).areaKey).toBeNull();
    expect(areaKeyFor({ state: 'Atlantis' })).toEqual({ areaKey: null, level: 'none' });
    expect(areaKeyFor({})).toEqual({ areaKey: null, level: 'none' });
  });

  it('never carries a street, building or landmark (the input type has no such field)', () => {
    const r = areaKeyFor({
      state: 'Cairo',
      city: 'Nasr City',
      ...({ street: 'Abbas El Akkad 12', building: '5' } as object),
    });
    expect(r.areaKey).toBe('EG-C-nasr-city');
    expect(JSON.stringify(r)).not.toMatch(/Abbas|12/);
  });
});
