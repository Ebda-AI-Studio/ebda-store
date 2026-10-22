/**
 * Shared data for the builder characterization + parity tests.
 *
 * Two stores (A: default theme flags; B: price-hidden, best-sellers tile
 * hidden, legacy brand-story/trust-strip flags OFF, store hero text set) and
 * one product/category/testimonial set. The layout side lives next to this
 * file as `*.json` (raw `stores.layout_settings` values).
 */
import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE_DIR = __dirname;

export const LAYOUT_FIXTURES = [
  'default',
  'legacy-hero-only',
  'default-flow',
  'fully-customised',
  'carousels-off',
  'malformed',
] as const;
export type LayoutFixture = (typeof LAYOUT_FIXTURES)[number];

export function loadLayoutFixture(name: LayoutFixture): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

export const TEMPLATES = ['modern', 'elegant', 'classic', 'minimal', 'bold'] as const;

const baseStore = {
  slug: 'char-store',
  name: 'Char Store',
  nameAr: 'متجر',
  description: 'We roast nuts in Cairo.',
  descriptionAr: 'نحمص المكسرات في القاهرة.',
  currency: 'EGP',
  heroImage: null as string | null,
  heroTitle: null as string | null,
  heroTitleAr: null as string | null,
  heroSubtitle: null as string | null,
  heroSubtitleAr: null as string | null,
  heroCtaText: null as string | null,
  heroCtaTextAr: null as string | null,
  heroCtaLink: null as string | null,
  blogEnabled: true,
};

export const STORES = {
  A: {
    ...baseStore,
    id: 'store-a',
    theme: { primaryColor: '#5b3a29', accentColor: '#c9a46a' },
  },
  B: {
    ...baseStore,
    id: 'store-b',
    name: 'Store B',
    heroImage: 'https://pub-test.r2.dev/store/hero.jpg',
    heroTitle: 'Welcome',
    heroTitleAr: 'أهلاً',
    heroSubtitle: 'Dates and nuts',
    heroCtaText: 'Browse',
    heroCtaLink: 'javascript:alert(1)',
    blogEnabled: false,
    theme: {
      primaryColor: '#123456',
      showPriceOnCards: false,
      showBestSellersTile: false,
      showBrandStory: false,
      showTrustStrip: false,
      arabicNumerals: true,
    },
  },
} as const;

const img = (n: string) => [{ id: `img-${n}`, url: `https://pub-test.r2.dev/p/${n}.jpg`, alt: n }];

export const PRODUCTS = [
  {
    id: 'p1',
    name: 'Cashew',
    nameAr: 'كاجو',
    slug: 'cashew',
    price: 25000,
    compareAtPrice: 30000,
    images: img('p1'),
    inventory: 5,
    categories: [{ category: { slug: 'nuts' } }],
  },
  {
    id: 'p2',
    name: 'Medjool',
    nameAr: 'مجدول',
    slug: 'medjool',
    price: 18000,
    images: img('p2'),
    inventory: 0,
    categories: [{ category: { slug: 'dates' } }],
  },
  {
    id: 'p3',
    name: 'Pistachio',
    nameAr: 'فستق',
    slug: 'pistachio',
    price: 42000,
    discountType: 'fixed',
    discountValue: 2000,
    badgeLabel: 'New',
    badgeLabelAr: 'جديد',
    images: img('p3'),
    inventory: 9,
    variants: [{ price: 42000 }, { price: 80000 }],
    categories: [{ category: { slug: 'nuts' } }],
  },
];

export const CATEGORIES = [
  {
    id: 'c1',
    name: 'Nuts',
    nameAr: 'مكسرات',
    slug: 'nuts',
    image: 'https://pub-test.r2.dev/c/1.jpg',
    productCount: 2,
  },
  {
    id: 'c2',
    name: 'Dates',
    nameAr: 'تمور',
    slug: 'dates',
    image: 'https://pub-test.r2.dev/c/2.jpg',
    productCount: 1,
  },
  {
    id: 'c3',
    name: 'Hidden',
    nameAr: 'مخفي',
    slug: 'hidden',
    productCount: 0,
    showOnHomeStrip: false,
  },
  {
    id: 'bs',
    name: 'Best Sellers',
    nameAr: 'الأكثر مبيعاً',
    slug: 'best-sellers',
    productCount: 3,
  },
];

export const TESTIMONIALS = [
  {
    id: 't1',
    rating: 5,
    title: 'Great',
    comment: 'Fresh and fast.',
    authorName: 'Mona A.',
    authorCity: null,
    createdAt: '2026-09-01T10:00:00.000Z',
  },
  {
    id: 't2',
    rating: 4,
    title: null,
    comment: 'جيد جداً',
    authorName: 'Omar K.',
    authorCity: 'Giza',
    createdAt: '2026-09-02T10:00:00.000Z',
  },
];
