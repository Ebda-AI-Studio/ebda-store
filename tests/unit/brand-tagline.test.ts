import { describe, expect, it } from 'vitest';
import { BRAND, brandTagline } from '../../packages/shared/src/brand';

// S4-10: store.ebda.app/login (Arabic) shipped <meta description> "Your store, live today."
describe('brandTagline (S4-10)', () => {
  it('gives Arabic locales the Arabic line and everything else the English one', () => {
    expect(brandTagline('ar')).toBe(BRAND.taglineAr);
    expect(brandTagline('ar-EG')).toBe(BRAND.taglineAr);
    expect(brandTagline('en')).toBe(BRAND.tagline);
    expect(brandTagline(undefined)).toBe(BRAND.tagline);
  });
});
