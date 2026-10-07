import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleJsonLd,
  organizationJsonLd,
  productJsonLd,
  BREADCRUMB_LABELS,
} from '../structured-data';

/**
 * #2196 — an Arabic PDP shipped `<title>عرض المدرسة</title>` next to
 * `"name": "School Offer"` in its Product JSON-LD. The machine-readable half
 * must follow the same locale the metadata resolved to.
 */
const store = {
  id: 's1',
  name: 'Demo Shop',
  nameAr: 'وادي الجوز',
  slug: 'demo-shop',
  currency: 'EGP',
  status: 'active',
  theme: {},
  socialLinks: {},
} as never;

const product = {
  name: 'School Offer',
  nameAr: 'عرض المدرسة',
  description: 'English copy',
  descriptionAr: 'نص عربي',
  slug: 'school-offer',
  price: 5000,
  inventory: 3,
  categories: [{ category: { name: 'Nuts', nameAr: 'مكسرات', slug: 'nuts' } }],
} as never;

type Ld = Record<string, unknown> & {
  offers: { seller: { name: string } };
  brand: { name: string };
};

describe('productJsonLd — locale (#2196)', () => {
  it('ar: product, brand, seller and category names are Arabic; description never English', () => {
    const ld = productJsonLd(product, store, { locale: 'ar' }) as unknown as Ld;
    expect(ld.name).toBe('عرض المدرسة');
    expect(ld.brand.name).toBe('وادي الجوز');
    expect(ld.offers.seller.name).toBe('وادي الجوز');
    expect(ld.category).toBe('مكسرات');
    expect(ld.description).toBe('نص عربي');
  });

  it('ar with no Arabic fields: falls back to English names, omits the English description', () => {
    const bare = {
      name: 'School Offer',
      description: 'English copy',
      slug: 'x',
      price: 1,
    } as never;
    const ld = productJsonLd(bare, store, { locale: 'ar' }) as unknown as Ld;
    expect(ld.name).toBe('School Offer');
    expect(ld.description).toBeUndefined();
  });

  it('en (default): unchanged English output (control)', () => {
    const ld = productJsonLd(product, store) as unknown as Ld;
    expect(ld.name).toBe('School Offer');
    expect(ld.brand.name).toBe('Demo Shop');
    expect(ld.description).toBe('English copy');
  });
});

describe('bundleJsonLd / organizationJsonLd — locale (#2196)', () => {
  const bundle = {
    name: 'Gift Box',
    nameAr: 'صندوق هدية',
    description: 'EN',
    descriptionAr: 'ع',
    slug: 'gift',
    price: 1000,
    available: 2,
  };
  it('bundle ar: Arabic bundle + seller names', () => {
    const ld = bundleJsonLd(bundle, store, 'ar') as unknown as Ld;
    expect(ld.name).toBe('صندوق هدية');
    expect(ld.offers.seller.name).toBe('وادي الجوز');
    expect(ld.description).toBe('ع');
  });
  it('organization ar: Arabic store name', () => {
    expect((organizationJsonLd(store, 'ar') as Record<string, unknown>).name).toBe('وادي الجوز');
    expect((organizationJsonLd(store, 'en') as Record<string, unknown>).name).toBe('Demo Shop');
  });
  it('breadcrumb labels exist for both locales', () => {
    expect(BREADCRUMB_LABELS.ar.home).toBe('الرئيسية');
    expect(BREADCRUMB_LABELS.en.products).toBe('Products');
  });
});

describe('detail pages thread the resolved locale into their JSON-LD (#2196)', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '../../app', rel), 'utf8');
  it('PDP body passes locale to productJsonLd and localizes the breadcrumb', () => {
    const src = read('products/[slug]/ProductDetailBody.tsx');
    expect(src).toMatch(/\{ shippingZones, locale \}/);
    expect(src).not.toMatch(/name: 'Home'/);
  });
  it('both PDP pages and the bundle page hand the body a locale', () => {
    expect(read('products/[slug]/page.tsx')).toMatch(/locale=\{locale\}/);
    // Not the `[locale]` route segment: it is cookie-only, so a cookie-less crawler
    // on an Arabic-default store got `en` (issue 2407).
    const tenantPdp = read('tenant-store/[tenant]/[locale]/products/[slug]/page.tsx');
    expect(tenantPdp).toMatch(/locale=\{locale\}/);
    expect(tenantPdp).toMatch(/resolveStorefrontLocale/);
    expect(tenantPdp).not.toMatch(/localeFromRouteParam/);
    expect(read('bundles/[slug]/page.tsx')).toMatch(/locale=\{locale\}/);
    expect(read('bundles/[slug]/BundleDetailBody.tsx')).toMatch(
      /bundleJsonLd\(initialBundle, store, locale\)/
    );
  });
});
