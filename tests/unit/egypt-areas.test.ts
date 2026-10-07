/**
 * Egypt address mapping shared by the carrier adapters: governorate spellings in both languages
 * resolve to one key, and `pickByName` never guesses between two candidates.
 */
import { describe, it, expect } from 'vitest';
import {
  EGYPT_GOVERNORATES,
  canonicalGovernorate,
  normalizeName,
  pickByName,
} from '@api/services/carriers/egypt-areas';

describe('governorates', () => {
  it('lists the 27 governorates with unique keys', () => {
    expect(EGYPT_GOVERNORATES).toHaveLength(27);
    expect(new Set(EGYPT_GOVERNORATES.map(g => g.key)).size).toBe(27);
  });

  it('no two governorates share a spelling (a shared alias would mis-route a parcel)', () => {
    const seen = new Map<string, string>();
    for (const g of EGYPT_GOVERNORATES) {
      for (const n of [g.en, g.ar, ...g.aliases]) {
        const k = normalizeName(n);
        expect(seen.get(k) ?? g.key, `${n} (${g.key}) vs ${seen.get(k)}`).toBe(g.key);
        seen.set(k, g.key);
      }
    }
  });

  it.each([
    ['القاهرة', 'cairo'],
    ['محافظة القاهرة', 'cairo'],
    ['القاهره', 'cairo'],
    ['Cairo', 'cairo'],
    ['Al Qahirah', 'cairo'],
    ['الجيزه', 'giza'],
    ['Giza Governorate', 'giza'],
    ['الاسكندريه', 'alexandria'],
    ['الإسكندرية', 'alexandria'],
    ['Alex', 'alexandria'],
    ['El Kalioubia', null], // Bosta's own spelling is matched against ITS list (pickByName), not here
    ['Kalyoubia', 'qalyubia'],
    ['Sharkia', 'sharqia'],
    ['بور سعيد', 'port-said'],
    ['PortSaid', 'port-said'],
    ['شمال سيناء', 'north-sinai'],
    ['Asyut', 'assiut'],
    ['مرسي مطروح', null],
    ['Matruh', 'matrouh'],
    ['', null],
  ])('"%s" -> %s', (input, key) => {
    expect(canonicalGovernorate(input)?.key ?? null).toBe(key);
  });
});

describe('normalizeName', () => {
  it('folds alef / ya / ta marbuta variants, diacritics, tatweel and Arabic-Indic digits', () => {
    expect(normalizeName('الإِسْكَنْدَرِيَّة')).toBe(normalizeName('الاسكندريه'));
    expect(normalizeName('القـــاهرة')).toBe(normalizeName('القاهره'));
    expect(normalizeName('التجمع ٣')).toBe(normalizeName('التجمع 3'));
  });
});

describe('pickByName', () => {
  const zones = [
    { id: 1, name: 'التجمع الثالث - 3rd Settlement' },
    { id: 2, name: 'التجمع الخامس - 5th Settlement' },
    { id: 3, name: 'مدينة نصر - Nasr City' },
    { id: 4, name: 'Nasr City Extension' },
  ];
  const names = (z: { name: string }) => [z.name];

  it('matches either side of a bilingual label, exactly', () => {
    expect(pickByName(zones, names, 'التجمع الخامس')?.id).toBe(2);
    expect(pickByName(zones, names, '5th Settlement')?.id).toBe(2);
    expect(pickByName(zones, names, 'nasr city')?.id).toBe(3);
  });

  it('a unique partial match is accepted, an ambiguous one is not guessed', () => {
    expect(pickByName(zones, names, 'Extension')?.id).toBe(4);
    expect(pickByName(zones, names, 'التجمع')).toBeNull(); // 2 candidates
    expect(pickByName(zones, names, 'Settlement')).toBeNull(); // 2 candidates
  });

  it('an unknown or empty query is null (NEEDS_MAPPING), never the first item', () => {
    expect(pickByName(zones, names, 'Atlantis')).toBeNull();
    expect(pickByName(zones, names, '')).toBeNull();
    expect(pickByName(zones, names, undefined)).toBeNull();
    expect(pickByName([], names, 'Cairo')).toBeNull();
  });
});
