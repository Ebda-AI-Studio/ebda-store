/** Ruling B1-30: the store name a shopper reads is in their language (Arabic receipt chrome). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { localizedStoreName } from '@ebda/shared';

describe('localizedStoreName', () => {
  const s = { name: 'Qamar Atelier', nameAr: 'قمر أتيليه' };
  it('ar -> Arabic name, en -> canonical name', () => {
    expect(localizedStoreName(s, 'ar')).toBe('قمر أتيليه');
    expect(localizedStoreName(s, 'en')).toBe('Qamar Atelier');
  });
  it('falls back across languages, never blank', () => {
    expect(localizedStoreName({ name: 'X', nameAr: '  ' }, 'ar')).toBe('X');
    expect(localizedStoreName({ name: '', nameAr: 'س' }, 'en')).toBe('س');
    expect(localizedStoreName(null, 'ar')).toBe('');
  });
});

describe('checkout / receipt chrome reads the localized name', () => {
  const web = path.resolve(__dirname, '../../apps/web/src');
  it('MinimalChrome (checkout + success header) never prints the raw English name', () => {
    const src = readFileSync(path.join(web, 'components/MinimalChrome.tsx'), 'utf8');
    expect(src).toMatch(/localizedStoreName\(store, language\)/);
    expect(src).not.toMatch(/\{store\.name\}/);
  });
  it('Arabic sentences that embed the store name use the Arabic name', () => {
    for (const f of [
      'app/faq/FAQClient.tsx',
      'app/affiliate/page.tsx',
      'app/how-to-guides/HowToGuidesClient.tsx',
    ]) {
      const src = readFileSync(path.join(web, f), 'utf8');
      expect(src, f).toMatch(/localizedStoreName\(store, 'ar'\)/);
    }
  });
});
