import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyAiLanguagePair,
  applyAiSeoSuggestion,
  arabicInEnglishFields,
  hasArabicScript,
  normalizeLanguagePair,
  type SeoMetaFields,
} from './language-guard';

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

describe('applyAiSeoSuggestion (QA P2-2)', () => {
  const arabicEverywhere = {
    title: 'متجر الأمل',
    titleAr: 'متجر الأمل للهدايا',
    description: 'هدايا مصرية',
    descriptionAr: 'هدايا مصرية مختارة',
  };
  it('never writes Arabic into an English field', () => {
    const { next, filled } = applyAiSeoSuggestion(
      {} as SeoMetaFields,
      arabicEverywhere,
      'overwrite'
    );
    expect(next.metaTitle).toBeUndefined();
    expect(next.metaDescription).toBeUndefined();
    expect(next.metaTitleAr).toBe('متجر الأمل للهدايا');
    expect(filled).toEqual(['metaTitleAr', 'metaDescriptionAr']);
  });
  it('swaps a swapped answer and fills only empty fields', () => {
    const { next } = applyAiSeoSuggestion(
      { metaTitle: 'Kept', metaTitleAr: '' },
      { title: 'متجر', titleAr: 'Shop', description: 'Gifts', descriptionAr: 'هدايا' },
      'fill-empty'
    );
    expect(next).toEqual({
      metaTitle: 'Kept',
      metaTitleAr: 'متجر',
      metaDescription: 'Gifts',
      metaDescriptionAr: 'هدايا',
    });
  });
  it('an AEO pair follows the same rule', () => {
    expect(applyAiLanguagePair('', '', 'وصف', 'وصف عربي', 'overwrite')).toEqual({
      en: '',
      ar: 'وصف عربي',
    });
  });
});

describe('every /ai/seo caller in admin goes through the guard (QA P2-2 class)', () => {
  const root = join(__dirname, '../../../..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(n => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
    });
  const callers = walk(root).filter(f => /\/ai\/seo`, \{ kind/.test(readFileSync(f, 'utf8')));
  it('finds the three callers', () => {
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });
  for (const f of callers) {
    it(f.replace(root, 'apps/admin/src'), () => {
      expect(readFileSync(f, 'utf8')).toMatch(/applyAiSeoSuggestion\(/);
    });
  }
});
