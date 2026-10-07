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

const STORE = { name: 'Demo Store', slug: 'demo-store', domain: undefined };

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

describe('Arabic fallback description names (#1857)', () => {
  it('uses the Arabic product and store names, not the English ones', () => {
    const meta = buildProductMetadata(
      { name: 'School Offer', nameAr: 'عرض المدارس', slug: 'school-offer', price: 5000 },
      { ...STORE, nameAr: 'بيكان بي' },
      'ar'
    );
    expect(meta.description).toContain('عرض المدارس');
    expect(meta.description).toContain('بيكان بي');
    expect(meta.description).not.toContain('School Offer');
    expect(meta.description).not.toContain('Demo Store');
  });

  it('falls back to the English names when no Arabic ones exist', () => {
    const meta = buildProductMetadata({ name: 'School Offer', slug: 's', price: 1 }, STORE, 'ar');
    expect(meta.description).toContain('School Offer');
  });
});

/**
 * Issue #1857 — the new Arabic fallback description interpolated the
 * ENGLISH `product.name`/`store.name` under `<html lang="ar">`
 * (`تسوق ${product.name} من ${storeName}`). Mutation-resistant: these assert
 * the Arabic output does NOT contain the English noun, not merely that it
 * matches the Arabic Unicode range (which the template wrapper alone would
 * already satisfy).
 */
describe('buildProductMetadata — Arabic name/store fallback (#1857)', () => {
  const STORE_AR = {
    name: 'Demo Store',
    nameAr: 'بيكان بي',
    slug: 'demo-store',
    domain: undefined,
  };

  it('ar locale, no AEO/SEO/descriptionAr copy at all: title, description, openGraph and twitter titles all use the Arabic product + store names, never the English ones', () => {
    const product = {
      name: 'School Offer',
      nameAr: 'عرض المدرسة',
      slug: 'schools-offer',
      price: 5000,
    };

    const meta = buildProductMetadata(product, STORE_AR, 'ar');

    expect(meta.title).toBe('عرض المدرسة');
    expect(meta.title).not.toContain('School Offer');
    expect(meta.description).toContain('عرض المدرسة');
    expect(meta.description).toContain('بيكان بي');
    expect(meta.description).not.toContain('School Offer');
    expect(meta.description).not.toContain('Demo Store');
    expect(meta.openGraph?.title).toBe('عرض المدرسة | بيكان بي');
    expect(meta.openGraph?.title).not.toContain('School Offer');
    expect(meta.openGraph?.title).not.toContain('Demo Store');
    const twitterTitle = meta.twitter && 'title' in meta.twitter ? meta.twitter.title : undefined;
    expect(twitterTitle).toBe('عرض المدرسة | بيكان بي');
  });

  it('ar locale, product/store have no Arabic name set: falls back to the English name rather than going blank', () => {
    const product = { name: 'School Offer', slug: 'schools-offer', price: 5000 };
    const storeNoAr = { name: 'Demo Store', slug: 'demo-store', domain: undefined };

    const meta = buildProductMetadata(product, storeNoAr, 'ar');

    expect(meta.title).toBe('School Offer');
    expect(meta.description).toContain('School Offer');
    expect(meta.description).toContain('Demo Store');
  });

  it('en locale (same product/store data): title, description and titles stay English even though nameAr is set', () => {
    const product = {
      name: 'School Offer',
      nameAr: 'عرض المدرسة',
      slug: 'schools-offer',
      price: 5000,
    };

    const meta = buildProductMetadata(product, STORE_AR, 'en');

    expect(meta.title).toBe('School Offer');
    expect(meta.description).toContain('School Offer');
    expect(meta.description).toContain('Demo Store');
    expect(meta.description).not.toContain('عرض المدرسة');
    expect(meta.openGraph?.title).toBe('School Offer | Demo Store');
  });
});
