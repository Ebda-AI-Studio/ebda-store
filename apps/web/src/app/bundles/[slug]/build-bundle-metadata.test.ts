import { describe, it, expect } from 'vitest';
import { buildBundleMetadata } from './BundleDetailBody';
import type { PublicBundleDetail } from '../../../lib/api';

/**
 * A1 (2026-09-22 AEO audit), bundle half. Bundles carry no meta-description
 * or AEO columns at all (schema.prisma Bundle model) — only
 * `description`/`descriptionAr` — so the locale param is the WHOLE fix here:
 * it is what selects `descriptionAr` over `description`.
 */

const STORE = { name: 'Demo Shop', slug: 'demo-shop', domain: 'demo-shop.example' };

const ARABIC_RANGE = /[؀-ۿ]/;

function makeBundle(overrides: Partial<PublicBundleDetail> = {}): PublicBundleDetail {
  return {
    id: 'bundle-1',
    name: 'Breakfast Box',
    nameAr: 'صندوق الإفطار',
    slug: 'breakfast-box',
    image: null,
    price: 5000,
    componentSum: 5000,
    available: 10,
    description: 'English bundle description',
    descriptionAr: 'وصف الباقة بالعربية',
    isPurchasable: true,
    componentNames: [],
    ...overrides,
  };
}

describe('buildBundleMetadata — locale threading', () => {
  it('ar locale: description is the Arabic field, never the English one', () => {
    const meta = buildBundleMetadata(makeBundle(), STORE, 'ar');
    expect(meta.description).toMatch(ARABIC_RANGE);
    expect(meta.description).not.toContain('English bundle description');
  });

  it('en locale (same bundle data): description stays English', () => {
    const meta = buildBundleMetadata(makeBundle(), STORE, 'en');
    expect(meta.description).not.toMatch(ARABIC_RANGE);
    expect(meta.description).toContain('English bundle description');
  });

  it('ar locale, descriptionAr null: falls back to the localized DEFAULT string, never the English description', () => {
    const meta = buildBundleMetadata(
      makeBundle({ description: 'English only', descriptionAr: null }),
      STORE,
      'ar'
    );
    expect(meta.description).toMatch(ARABIC_RANGE);
    expect(meta.description).not.toContain('English only');
  });

  it('defaults to en when no locale argument is passed (back-compat)', () => {
    const meta = buildBundleMetadata(makeBundle(), STORE);
    expect(meta.description).not.toMatch(ARABIC_RANGE);
  });

  it('openGraph AND twitter descriptions match the top-level (localized) description', () => {
    const meta = buildBundleMetadata(makeBundle(), STORE, 'ar');
    expect(meta.openGraph?.description).toBe(meta.description);
    expect(
      meta.twitter && 'description' in meta.twitter ? meta.twitter.description : undefined
    ).toBe(meta.description);
  });
});

describe('Arabic fallback description names (#1857)', () => {
  it('uses the Arabic bundle and store names', () => {
    const meta = buildBundleMetadata(
      { ...makeBundle(), nameAr: 'صندوق رمضان', description: null, descriptionAr: null } as never,
      { ...STORE, nameAr: 'بيكان بي' },
      'ar'
    );
    expect(meta.description).toContain('صندوق رمضان');
    expect(meta.description).toContain('بيكان بي');
  });
});

/**
 * Issue #1857, bundle half — the Arabic fallback description interpolated
 * the ENGLISH `bundle.name`/`store.name` (`تسوق ${bundle.name} من
 * ${storeName}`) even though `PublicBundleDetail.nameAr` is always present.
 * Mutation-resistant: asserts the Arabic output does NOT contain the
 * English noun, not merely that it matches the Arabic Unicode range.
 */
describe('buildBundleMetadata — Arabic name/store fallback (#1857)', () => {
  const STORE_AR = {
    name: 'Demo Shop',
    nameAr: 'وادي الجوز',
    slug: 'demo-shop',
    domain: 'demo-shop.example',
  };

  it('ar locale, no descriptionAr at all: title, description, openGraph and twitter titles use the Arabic bundle + store names, never the English ones', () => {
    const bundle = makeBundle({ description: null, descriptionAr: null });

    const meta = buildBundleMetadata(bundle, STORE_AR, 'ar');

    expect(meta.title).toBe('صندوق الإفطار');
    expect(meta.title).not.toContain('Breakfast Box');
    expect(meta.description).toContain('صندوق الإفطار');
    expect(meta.description).toContain('وادي الجوز');
    expect(meta.description).not.toContain('Breakfast Box');
    expect(meta.description).not.toContain('Demo Shop');
    expect(meta.openGraph?.title).toBe('صندوق الإفطار | وادي الجوز');
    const twitterTitle = meta.twitter && 'title' in meta.twitter ? meta.twitter.title : undefined;
    expect(twitterTitle).toBe('صندوق الإفطار | وادي الجوز');
  });

  it('ar locale, bundle/store have no Arabic name set: falls back to the English name rather than going blank', () => {
    const bundle = makeBundle({ nameAr: null, description: null, descriptionAr: null });
    const storeNoAr = { name: 'Demo Shop', slug: 'demo-shop', domain: 'demo-shop.example' };

    const meta = buildBundleMetadata(bundle, storeNoAr, 'ar');

    expect(meta.title).toBe('Breakfast Box');
    expect(meta.description).toContain('Breakfast Box');
    expect(meta.description).toContain('Demo Shop');
  });

  it('en locale (same bundle/store data): title, description and titles stay English even though nameAr is set', () => {
    const bundle = makeBundle({ description: null, descriptionAr: null });

    const meta = buildBundleMetadata(bundle, STORE_AR, 'en');

    expect(meta.title).toBe('Breakfast Box');
    expect(meta.description).toContain('Breakfast Box');
    expect(meta.description).toContain('Demo Shop');
    expect(meta.description).not.toContain('صندوق الإفطار');
    expect(meta.openGraph?.title).toBe('Breakfast Box | Demo Shop');
  });
});
