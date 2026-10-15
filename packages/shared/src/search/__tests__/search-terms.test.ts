import { describe, it, expect } from 'vitest';
import { cleanSearchTerms, SEARCH_TERMS_MAX_COUNT, SEARCH_TERMS_MAX_LENGTH } from '../search-terms';

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
});
