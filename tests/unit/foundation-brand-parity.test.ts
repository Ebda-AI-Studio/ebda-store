/**
 * The Store keeps its own `BRAND` literal (one object, no extra indirection in the marketing bundles), and this test pins every field
 * it shares with the vendored foundation's `EBDA` so the two can never drift (ebda-foundation `brand`, Ruling FDN-VENDOR-1).
 */
import { describe, expect, it } from 'vitest';
import { BRAND } from '@ebda/shared/brand';
import { BARE_EN, EBDA, brandName } from '../../packages/shared/src/foundation/brand';

describe('Store BRAND equals the foundation EBDA', () => {
  it('names, company, products, colours and domains', () => {
    expect(BRAND.name).toBe(EBDA.name);
    expect(BRAND.nameAr).toBe(EBDA.nameAr);
    expect(BRAND.company).toEqual(EBDA.company);
    expect(BRAND.product).toEqual({
      nameEn: EBDA.products.store.nameEn,
      nameAr: EBDA.products.store.nameAr,
    });
    expect(BRAND.productWhatsapp).toEqual({
      nameEn: EBDA.products.whatsapp.nameEn,
      nameAr: EBDA.products.whatsapp.nameAr,
    });
    expect(BRAND.colors).toEqual(EBDA.colors);
    expect(BRAND.domains).toEqual(EBDA.domains);
  });
  it('brandName agrees by locale and no product name is a bare "Ebda"', () => {
    for (const l of ['ar', 'ar-EG', 'en', undefined])
      expect(brandName(l)).toBe(l?.startsWith('ar') ? BRAND.nameAr : BRAND.name);
    expect(BARE_EN.test(BRAND.product.nameEn)).toBe(false);
    expect(BARE_EN.test(BRAND.productWhatsapp.nameEn)).toBe(false);
  });
});
