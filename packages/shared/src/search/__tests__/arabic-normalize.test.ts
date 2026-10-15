import { describe, it, expect } from 'vitest';
import {
  normalizeArabicSearch,
  searchTokens,
  escapeLike,
  AR_FOLD_FROM,
  AR_FOLD_TO,
} from '../arabic-normalize';
import { NORMALIZE_VECTORS } from '../normalize-vectors';

describe('normalizeArabicSearch', () => {
  it.each(NORMALIZE_VECTORS)('%j -> %j', (input, expected) => {
    expect(normalizeArabicSearch(input)).toBe(expected);
  });

  it('fold table is aligned 1:1 (a missing char would shift every later mapping)', () => {
    expect([...AR_FOLD_FROM].length).toBe([...AR_FOLD_TO].length);
  });

  it('every folded char has a vector (no untested rule)', () => {
    const covered = NORMALIZE_VECTORS.map(([i]) => i).join('');
    for (const ch of new Set([...AR_FOLD_FROM].filter(c => !/[A-Z0-9]/.test(c)))) {
      if (/[٠-٩۰-۹]/.test(ch)) continue; // digits covered by the ٤٢ / ۴۲ / ١٠٠ / ١٥ rows as a class
      expect(covered, `no vector exercises ${ch}`).toContain(ch);
    }
  });

  it('is idempotent', () => {
    for (const [input] of NORMALIZE_VECTORS) {
      const once = normalizeArabicSearch(input);
      expect(normalizeArabicSearch(once)).toBe(once);
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
