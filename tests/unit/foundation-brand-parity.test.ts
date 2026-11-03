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
    // Ruling AR-STUDIO-NAME-1 (2026-11-03): the Arabic studio name is spelled «ابدأ ستوديو» and the legal entity reads
    // «... Software Development, and Digital Marketing». The vendored foundation (v0.1.0, a managed file) still carries the
    // old spelling until the foundation repo ships the same change and this repo re-syncs; these four fields are the ONLY
    // allowed difference, and the rest of `company` must still be equal.
    const AR_STUDIO_NAME_1 = {
      legalNameAr: 'ابدأ ستوديو للذكاء الاصطناعي والبرمجيات والتسويق الرقمي',
      legalNameEn:
        'Ebda Studio for Artificial Intelligence, Software Development, and Digital Marketing',
      shortNameAr: 'ابدأ ستوديو',
    };
    expect(BRAND.nameAr).toBe('ابدأ ستوديو للذكاء الاصطناعي');
    expect(BRAND.company).toEqual({ ...EBDA.company, ...AR_STUDIO_NAME_1 });
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
      expect(brandName(l)).toBe(l?.startsWith('ar') ? EBDA.nameAr : BRAND.name); // the Arabic name differs only by AR-STUDIO-NAME-1, above
    expect(BARE_EN.test(BRAND.product.nameEn)).toBe(false);
    expect(BARE_EN.test(BRAND.productWhatsapp.nameEn)).toBe(false);
  });
});
