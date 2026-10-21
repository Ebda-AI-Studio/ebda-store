/** Ruling B1-30: the store name a shopper reads is in their language (Arabic receipt chrome).
 *  One helper: the storefront's existing `pickLocalizedName` (also used by the receipt). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pickLocalizedName } from '../../apps/web/src/templates/shared/display-helpers';

describe('pickLocalizedName for the store name', () => {
  const s = { name: 'Qamar Atelier', nameAr: 'قمر أتيليه' };
  it('ar -> Arabic name, en -> canonical name', () => {
    expect(pickLocalizedName(s, true)).toBe('قمر أتيليه');
    expect(pickLocalizedName(s, false)).toBe('Qamar Atelier');
  });
  it('falls back across languages', () => {
    expect(pickLocalizedName({ name: 'X', nameAr: '  ' }, true)).toBe('X');
    expect(pickLocalizedName({ name: '', nameAr: 'س' }, false)).toBe('س');
  });
});

describe('the store-name renders use the one helper', () => {
  const web = path.resolve(__dirname, '../../apps/web/src');
  const read = (f: string) => readFileSync(path.join(web, f), 'utf8');
  it('MinimalChrome (checkout + success header) never prints the raw English name', () => {
    const src = read('components/MinimalChrome.tsx');
    expect(src).toMatch(/pickLocalizedName\(store, isRtl\)/);
    expect(src).not.toMatch(/\{store\.name\}/);
  });
  it('Arabic sentences that embed the store name use the Arabic name', () => {
    for (const f of [
      'app/faq/FAQClient.tsx',
      'app/affiliate/page.tsx',
      'app/how-to-guides/HowToGuidesClient.tsx',
    ])
      expect(read(f), f).toMatch(/pickLocalizedName\(store, true\)/);
  });
  it('no second store-name helper exists in @ebda/shared', () => {
    const shared = readFileSync(
      path.resolve(__dirname, '../../packages/shared/src/region/index.ts'),
      'utf8'
    );
    expect(shared).not.toMatch(/export function localizedStoreName/);
  });
});
