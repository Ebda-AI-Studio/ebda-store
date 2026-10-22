/**
 * Review M-5: every admin reader of an upload refusal picks the Arabic or English text the
 * same way, through `localizedApiMessage` (document `dir`), never its own `useLocale()`
 * branch. Product3dModelCard was the odd one out.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const READERS = [
  'apps/admin/src/hooks/useImageUpload.ts',
  // the font upload moved with the shared FontsCard (page builder and visual editor both use it)
  'apps/admin/src/components/section-design/FontsCard.tsx',
  'apps/admin/src/app/stores/[id]/finance/expenses/new/page.tsx',
  'apps/admin/src/app/stores/[id]/products/[productId]/_components/Product3dModelCard.tsx',
  'apps/admin/src/app/stores/[id]/pwa/_components/PwaIconUploader.tsx',
];

describe('upload error language has one source of truth', () => {
  it.each(READERS)('%s localizes through localizedApiMessage / uploadErrorText', file => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/\b(localizedApiMessage|uploadErrorText)\(/);
    expect(src).not.toMatch(/locale\s*===\s*'ar'\s*\?\s*\w+\??\.messageAr/);
  });
});

describe('Product3dModelCard error text uses the same language source (review M-5)', () => {
  it('its client-side validation errors pick the language via adminUiLocale(), not useLocale()', () => {
    const src = readFileSync(
      'apps/admin/src/app/stores/[id]/products/[productId]/_components/Product3dModelCard.tsx',
      'utf8'
    );
    const calls = src.match(/model3dErrorMessage\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/adminUiLocale\(\)/);
  });
});
