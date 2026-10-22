/**
 * Phase B3 fix wave 1 (Ruling B3-13): a store tag has two labels and the storefront shows the one
 * for the shopper's language, marking a fallback with `lang` (WCAG 3.1.2).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { tagLabel } from '../../apps/web/src/lib/tag-label';
import { TagChips } from '../../apps/web/src/templates/shared/TagChips';

describe('tagLabel', () => {
  const both = { name: 'Oily skin', nameAr: 'بشرة دهنية' };
  it('Arabic page shows nameAr, English page shows name, no lang when the language matches', () => {
    expect(tagLabel(both, 'ar')).toEqual({ text: 'بشرة دهنية', lang: undefined });
    expect(tagLabel(both, 'en')).toEqual({ text: 'Oily skin', lang: undefined });
  });
  it('an Arabic page with no Arabic label falls back to the English name and says so', () => {
    expect(tagLabel({ name: 'Acne', nameAr: null }, 'ar')).toEqual({ text: 'Acne', lang: 'en' });
    expect(tagLabel({ name: 'Acne', nameAr: '  ' }, 'ar')).toEqual({ text: 'Acne', lang: 'en' });
  });
  it('a legacy tag whose name is Arabic is shown on an English page, marked lang="ar", never hidden', () => {
    expect(tagLabel({ name: 'بشرة دهنية' }, 'en')).toEqual({ text: 'بشرة دهنية', lang: 'ar' });
    expect(tagLabel({ name: '', nameAr: 'جفاف' }, 'en')).toEqual({ text: 'جفاف', lang: 'ar' });
  });
});

describe('TagChips picks the label by locale', () => {
  const tags = [
    { id: '1', name: 'Oily skin', nameAr: 'بشرة دهنية', productCount: 3 },
    { id: '2', name: 'Acne', nameAr: null, productCount: 2 },
  ];
  const html = (isRtl: boolean) => renderToStaticMarkup(<TagChips tags={tags} isRtl={isRtl} />);
  it('English page: English names, no lang attributes', () => {
    const h = html(false);
    expect(h).toContain('>Oily skin<');
    expect(h).toContain('>Acne<');
    expect(h).not.toContain('بشرة');
    expect(h).not.toMatch(/lang=/);
  });
  it('Arabic page: Arabic where it exists, the English fallback is marked lang="en"', () => {
    const h = html(true);
    expect(h).toContain('>بشرة دهنية<');
    expect(h).toContain('<span lang="en">Acne</span>');
    // the filter key is always the canonical name
    expect(h).toContain('/products?tag=Oily%20skin');
    expect(h).toContain('/products?tag=Acne');
  });
});
