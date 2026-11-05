import { describe, expect, it } from 'vitest';
import { arabicInEnglishFields, hasArabicScript, normalizeLanguagePair } from './language-guard';

describe('seo language guard', () => {
  it('detects Arabic script and nothing else', () => {
    expect(hasArabicScript('متجر الأمل')).toBe(true);
    expect(hasArabicScript('Amal Store 2024')).toBe(false);
    expect(hasArabicScript('')).toBe(false);
  });

  it('swaps an AI answer that put the languages in the wrong fields', () => {
    expect(normalizeLanguagePair('متجر الأمل', 'Amal Store')).toEqual({
      en: 'Amal Store',
      ar: 'متجر الأمل',
      swapped: true,
    });
  });

  it('keeps a correct pair as is', () => {
    expect(normalizeLanguagePair('Amal Store', 'متجر الأمل')).toMatchObject({
      en: 'Amal Store',
      ar: 'متجر الأمل',
      swapped: false,
    });
  });

  it('drops text that is still in the wrong language after the swap check', () => {
    // both Arabic: the English slot cannot hold it
    expect(normalizeLanguagePair('متجر', 'متجر الأمل')).toMatchObject({ en: '', ar: 'متجر الأمل' });
    // both English: the Arabic slot cannot hold it
    expect(normalizeLanguagePair('Amal', 'Amal Store')).toMatchObject({ en: 'Amal', ar: '' });
  });

  it('names the English fields that hold Arabic, in form order', () => {
    expect(
      arabicInEnglishFields({
        metaTitle: 'Amal',
        metaDescription: 'وصف عربي',
        metaDescriptionAeo: 'إجابة',
      })
    ).toEqual(['metaDescription', 'metaDescriptionAeo']);
    expect(arabicInEnglishFields({ metaTitle: 'Amal', metaDescription: '' })).toEqual([]);
  });
});
