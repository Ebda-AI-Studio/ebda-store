import { describe, it, expect } from 'vitest';
import {
  descriptionRichness,
  richerSide,
  containsArabic,
} from '../../apps/api/src/lib/ai/description-richness';

describe('descriptionRichness', () => {
  it('returns 0 for empty string', () => {
    expect(descriptionRichness('')).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(descriptionRichness(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(descriptionRichness(undefined)).toBe(0);
  });

  it('returns 0 for whitespace-only string', () => {
    expect(descriptionRichness('   ')).toBe(0);
  });

  it('scores a multi-sentence string higher than a single short word', () => {
    const multiSentence = 'This product is amazing. It has great quality. You will love it.';
    const shortWord = 'Nice';
    expect(descriptionRichness(multiSentence)).toBeGreaterThan(descriptionRichness(shortWord));
  });

  it('adds sentence bonus for each sentence beyond the first', () => {
    const oneSentence = 'Hello world';
    const twoSentences = 'Hello world. How are you';
    // twoSentences length + 1 bonus (sentences-1=1, ×5)
    expect(descriptionRichness(twoSentences)).toBe(twoSentences.trim().length + 5);
    expect(descriptionRichness(oneSentence)).toBe(oneSentence.trim().length);
  });
});

describe('richerSide', () => {
  it('returns null when both are empty', () => {
    expect(richerSide('', '')).toBeNull();
  });

  it('returns null when both are null', () => {
    expect(richerSide(null, null)).toBeNull();
  });

  it('returns null when both are undefined', () => {
    expect(richerSide(undefined, undefined)).toBeNull();
  });

  it('returns en when EN is longer than AR', () => {
    const longEn =
      'This is a detailed product description with many words and sentences. It covers all features.';
    const shortAr = 'منتج';
    expect(richerSide(longEn, shortAr)).toBe('en');
  });

  it('returns ar when AR description is richer than EN fragment', () => {
    const richAr = 'هذا المنتج رائع جداً. يتميز بجودة عالية وتصميم أنيق. مناسب لجميع الأعمار.';
    const fragmentEn = 'Good';
    expect(richerSide(fragmentEn, richAr)).toBe('ar');
  });

  it('returns en when scores are equal (en wins tie)', () => {
    // descriptionRichness('abc') === descriptionRichness('xyz') === 3
    expect(richerSide('abc', 'xyz')).toBe('en');
  });

  it('returns en when only EN is present', () => {
    expect(richerSide('Some description', null)).toBe('en');
  });

  it('returns ar when only AR is present', () => {
    expect(richerSide(null, 'وصف المنتج')).toBe('ar');
  });
});

describe('containsArabic', () => {
  it('returns true for Arabic text', () => {
    expect(containsArabic('مرحبا')).toBe(true);
  });

  it('returns true for mixed Arabic and English', () => {
    expect(containsArabic('Hello مرحبا')).toBe(true);
  });

  it('returns false for pure English text', () => {
    expect(containsArabic('Hello world')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(containsArabic('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(containsArabic(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(containsArabic(undefined)).toBe(false);
  });
});
