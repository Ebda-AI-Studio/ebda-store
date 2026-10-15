import { describe, it, expect } from 'vitest';
import {
  analyzeSearchTerms,
  cleanSearchTerms,
  SEARCH_TERMS_MAX_COUNT,
  SEARCH_TERMS_MAX_LENGTH,
} from '../search-terms';

describe('cleanSearchTerms', () => {
  it('splits on latin comma, arabic comma and newlines; trims; dedupes by normalised form', () => {
    expect(cleanSearchTerms('جزمة، جزمه ,  كوتشي\n3abaya')).toBe('جزمة, كوتشي, 3abaya');
  });
  it('empty → null (clears)', () => {
    expect(cleanSearchTerms('  ,، ')).toBeNull();
    expect(cleanSearchTerms(null)).toBeNull();
    expect(cleanSearchTerms(undefined)).toBeNull();
  });
  it('caps the count', () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`).join(',');
    expect(cleanSearchTerms(many)!.split(', ')).toHaveLength(SEARCH_TERMS_MAX_COUNT);
  });
  it('never exceeds the DB length cap even when ", " widens a 500-char input', () => {
    const raw = Array.from(
      { length: 31 },
      (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(13)}`
    )
      .join(',')
      .slice(0, SEARCH_TERMS_MAX_LENGTH);
    expect(raw.length).toBeLessThanOrEqual(SEARCH_TERMS_MAX_LENGTH);
    const cleaned = cleanSearchTerms(raw)!;
    expect(cleaned.length).toBeLessThanOrEqual(SEARCH_TERMS_MAX_LENGTH);
  });

  it('is idempotent over random inputs (a cut at a space never leaves a trailing blank)', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ['a', 'b', 'ع', 'ة', 'ه', ' ', ' ', ',', '،', '\n', '3', 'ٍ'];
    for (let i = 0; i < 500; i++) {
      const n = Math.floor(rnd() * 900);
      let raw = '';
      for (let j = 0; j < n; j++) raw += alphabet[Math.floor(rnd() * alphabet.length)];
      const once = cleanSearchTerms(raw);
      expect(cleanSearchTerms(once)).toBe(once);
      if (once) expect(once.length).toBeLessThanOrEqual(SEARCH_TERMS_MAX_LENGTH);
    }
    const spaceCut = `${'a'.repeat(59)} b, c`;
    expect(cleanSearchTerms(spaceCut)).toBe(`${'a'.repeat(59)}, c`);
  });

  it('reports what was dropped or cut so the form can say so', () => {
    const many = Array.from({ length: 34 }, (_, i) => `t${i}`).join(',');
    expect(analyzeSearchTerms(many)).toMatchObject({ dropped: 4, truncated: 0 });
    expect(analyzeSearchTerms(`${'x'.repeat(80)}, ok`)).toMatchObject({ dropped: 0, truncated: 1 });
    expect(analyzeSearchTerms('a, a, ا')).toMatchObject({ dropped: 0, truncated: 0 });
  });
});
