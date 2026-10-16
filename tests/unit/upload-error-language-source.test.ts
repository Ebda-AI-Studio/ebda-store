/**
 * Review M-5: every admin reader of an upload refusal picks the Arabic or English text the
 * same way, through `localizedApiMessage` (document `dir`), never its own `useLocale()`
 * branch. Product3dModelCard was the odd one out.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const READERS = [
  'apps/admin/src/hooks/useImageUpload.ts',
  'apps/admin/src/app/stores/[id]/page-builder/page.tsx',
  'apps/admin/src/app/stores/[id]/finance/expenses/new/page.tsx',
  'apps/admin/src/app/stores/[id]/products/[productId]/_components/Product3dModelCard.tsx',
];

describe('upload error language has one source of truth', () => {
  it.each(READERS)('%s localizes through localizedApiMessage / uploadErrorText', file => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/\b(localizedApiMessage|uploadErrorText)\(/);
    expect(src).not.toMatch(/locale\s*===\s*'ar'\s*\?\s*\w+\??\.messageAr/);
  });
});
