import { describe, it, expect } from 'vitest';
import { buildBundleMetadata } from './BundleDetailBody';
import type { PublicBundleDetail } from '../../../lib/api';

/**
 * A1 (2026-09-22 AEO audit), bundle half. Bundles carry no meta-description
 * or AEO columns at all (schema.prisma Bundle model) — only
 * `description`/`descriptionAr` — so the locale param is the WHOLE fix here:
 * it is what selects `descriptionAr` over `description`.
 */

const STORE = { name: 'Wady Aljuz', slug: 'wady-aljuz', domain: 'wadyaljuz.com' };

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
