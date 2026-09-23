import { describe, it, expect } from 'vitest';
import { buildProductMetadata } from './ProductDetailBody';

/**
 * A1 (2026-09-22 AEO audit): every product page served an English meta
 * description on every Arabic-default store because `buildProductMetadata`
 * took no locale param at all — `pickMetaDescription` always defaulted to
 * 'en'. Verified live by prod SQL: no store has ANY English text in an
 * `*Ar` column, so a matching `/[؀-ۿ]/` (Arabic block) description proves
 * the fix reads the right column, not that the fixture happens to contain
 * Arabic-looking characters.
 *
 * Mutation check: calling `buildProductMetadata(product, store)` without the
 * third `locale` argument (the pre-fix call shape) turns the 'ar' tests red
 * — the whole point is that the caller MUST thread it through.
 */

const STORE = { name: 'Pecannbee', slug: 'pecannbee', domain: undefined };

const ARABIC_RANGE = /[؀-ۿ]/;

describe('buildProductMetadata — locale threading', () => {
  it('ar locale: description comes from the Arabic AEO field and contains Arabic text', () => {
    const product = {
      name: 'School Offer',
      slug: 'schools-offer',
      price: 5000,
      description: 'English fallback description',
      descriptionAr: 'الوصف العربي الاحتياطي',
      metaDescriptionAeo: 'English AEO copy',
      metaDescriptionAeoAr: 'عرض العودة للمدارس من بيكان بي',
    };

    const meta = buildProductMetadata(product, STORE, 'ar');

    expect(meta.description).toMatch(ARABIC_RANGE);
    expect(meta.description).toContain('عرض العودة للمدارس');
    expect(meta.description).not.toContain('English AEO copy');
  });

  it('en locale (same product data): description stays English, never Arabic', () => {
    const product = {
      name: 'School Offer',
      slug: 'schools-offer',
      price: 5000,
      description: 'English fallback description',
      descriptionAr: 'الوصف العربي الاحتياطي',
      metaDescriptionAeo: 'English AEO copy',
      metaDescriptionAeoAr: 'عرض العودة للمدارس من بيكان بي',
    };

    const meta = buildProductMetadata(product, STORE, 'en');

    expect(meta.description).not.toMatch(ARABIC_RANGE);
    expect(meta.description).toContain('English AEO copy');
  });

  it('ar locale, no AEO/meta Arabic copy: falls back to descriptionAr, never the English description', () => {
    const product = {
      name: 'Barley',
      slug: 'barley',
      price: 3000,
      description: 'Plain English description',
      descriptionAr: 'وصف عربي بسيط',
    };

    const meta = buildProductMetadata(product, STORE, 'ar');

    expect(meta.description).toMatch(ARABIC_RANGE);
    expect(meta.description).not.toContain('Plain English description');
  });

  it('defaults to en when no locale argument is passed (back-compat)', () => {
    const product = {
      name: 'Barley',
      slug: 'barley',
      price: 3000,
      description: 'Plain English description',
      descriptionAr: 'وصف عربي بسيط',
    };

    const meta = buildProductMetadata(product, STORE);

    expect(meta.description).not.toMatch(ARABIC_RANGE);
  });

  it('openGraph AND twitter descriptions match the top-level (localized) description', () => {
    const product = {
      name: 'Barley',
      slug: 'barley',
      price: 3000,
      description: 'Plain English description',
      descriptionAr: 'وصف عربي بسيط',
      images: [{ url: 'https://example.com/barley.jpg' }],
    };

    const meta = buildProductMetadata(product, STORE, 'ar');

    expect(meta.openGraph?.description).toBe(meta.description);
    expect(
      meta.twitter && 'description' in meta.twitter ? meta.twitter.description : undefined
    ).toBe(meta.description);
  });
});
