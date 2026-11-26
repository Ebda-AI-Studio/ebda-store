import { describe, it, expect } from 'vitest';
import {
  normalizeArabicSearch,
  normalizeArabicHamza,
  searchTokens,
  escapeLike,
  AR_FOLD_FROM,
  AR_FOLD_TO,
} from '../arabic-normalize';
import hamzaVectors from '../../foundation/vectors/arabic-hamza.json';
import { NORMALIZE_VECTORS } from '../normalize-vectors';

describe('normalizeArabicHamza (fold A)', () => {
  it.each(hamzaVectors.cases as Array<[string, string]>)('%j -> %j', (input, expected) => {
    expect(normalizeArabicHamza(input)).toBe(expected);
  });
});

describe('normalizeArabicSearch', () => {
  it.each(NORMALIZE_VECTORS)('%j -> %j', (input, expected) => {
    expect(normalizeArabicSearch(input)).toBe(expected);
  });

  it('fold table is aligned 1:1 (a missing char would shift every later mapping)', () => {
    expect([...AR_FOLD_FROM].length).toBe([...AR_FOLD_TO].length);
  });

  it('every folded char has a vector (no untested rule)', () => {
    const covered = NORMALIZE_VECTORS.map(([i]) => i).join('');
    for (const ch of new Set([...AR_FOLD_FROM])) {
      expect(covered, `no vector exercises ${ch}`).toContain(ch);
    }
  });

  it('is idempotent', () => {
    for (const [input] of NORMALIZE_VECTORS) {
      const once = normalizeArabicSearch(input);
      expect(normalizeArabicSearch(once)).toBe(once);
    }
  });

  it('is idempotent over the whole folded range (generated sample)', () => {
    const alphabet = [
      ...AR_FOLD_FROM,
      ...AR_FOLD_TO,
      ' ',
      '\t',
      '\u00A0',
      '\u0640',
      '\u064B',
      '\u0670',
      '\u2009',
    ];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 2000; n++) {
      const len = 1 + Math.floor(rnd() * 12);
      let input = '';
      for (let k = 0; k < len; k++) input += alphabet[Math.floor(rnd() * alphabet.length)];
      const once = normalizeArabicSearch(input);
      expect(normalizeArabicSearch(once), JSON.stringify(input)).toBe(once);
    }
  });
});

describe('searchTokens', () => {
  it('normalises, splits on space and caps at 8 tokens', () => {
    expect(searchTokens('أحذية  رجالي')).toEqual(['احذيه', 'رجالي']);
    expect(searchTokens('a b c d e f g h i j')).toHaveLength(8);
    expect(searchTokens('   ')).toEqual([]);
  });
});

describe('escapeLike', () => {
  it('escapes backslash, percent and underscore', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
  });
});
