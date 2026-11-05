import { describe, expect, it } from 'vitest';
import { localizeSizeHint } from '../size-hint';

describe('localizeSizeHint (audit S-1)', () => {
  const logo = 'Recommended: 400×200px wordmark OR 400×400px square brandmark (PNG / WebP)';
  it('translates the logo hint for the Arabic admin and leaves no English words', () => {
    const out = localizeSizeHint(logo, 'ar');
    expect(out).toBe(
      'الحجم الموصى به: 400×200 بكسل شعار أفقي أو 400×400 بكسل شعار مربع (PNG / WebP)'
    );
    expect(out).not.toMatch(/Recommended|wordmark|OR|px/);
  });
  it('translates the plain size hint', () => {
    expect(localizeSizeHint('Recommended: 1200 × 800 px (JPEG / WebP)', 'ar')).toBe(
      'الحجم الموصى به: 1200 × 800 بكسل (JPEG / WebP)'
    );
  });
  it('leaves English untouched', () => {
    expect(localizeSizeHint(logo, 'en')).toBe(logo);
  });
});
