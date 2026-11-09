// Voice (quality bar section 2, Ahmad's ruling e): labels and buttons use neutral noun forms
// ("تسوّق", never a gendered imperative); full sentences are in the store's Egyptian voice.
// The Souq showroom home document (Phase B2 Task 6): a SUPERSET of every Souq section, built from
// registry presets plus CONTENT settings only. Design keys (layout, columns, bands...) come from
// the look's section mix at render (Ruling B1-8, `demoHomeDefinition`) or from `applyLook` on a
// merchant store. One hero, tagged `souq.night` (only Night souq has one); the curated carousel is
// tagged `souq.night` too, so Catalogue shows only its deals row; the three one-product stages
// serve Showroom (a look that does not name a type simply leaves it out of the render).
import { getSectionDefinition, sectionFromPreset } from '@ebda/shared';

/** Stage products (Showroom): distinct, photographed, buyable. */
const STAGES = ['smartphone-6-7', 'ultrabook-14', 'noise-cancelling-headphones'];
/** The curated "from the souq" row (Night souq). */
const CURATED = [
  'smartphone-6-7',
  'tablet-10',
  'true-wireless-earbuds',
  'smart-watch',
  'air-fryer-5l',
  'power-bank-20000',
];
/** The hand-picked collection rectangles (Showroom): category slug + the cut-out it shows. */
const COLLECTIONS = [
  ['phones', 'smartphone.webp'],
  ['laptops', 'student-laptop.webp'],
  ['audio', 'headphones.webp'],
  ['watches', 'smartwatch.webp'],
  ['tv', 'tv-55.webp'],
  ['appliances', 'washing-machine.webp'],
];

/** Section types this document owns; legacy sections outside it are kept but hidden. */
const USED = [
  'spec-sheet', // T7 signature section
  'hero',
  'category-grid',
  'product-carousel',
  'featured-collection',
  'product-spotlight',
  'collection-list',
  'trust-strip',
  'newsletter',
  'brand-story',
];

/**
 * @param {import('@ebda/shared').PageDefinition} base the store's current home document
 * @param {{ img(f: string): string, productIdBySlug: Map<string, string> }} ctx
 */
export function buildSouqHome(base, ctx) {
  const { img, productIdBySlug } = ctx;
  const idOf = slug => {
    const id = productIdBySlug.get(slug);
    if (!id) throw new Error(`souq home: ${slug} is not in the seeded catalogue`);
    return id;
  };
  const node = (type, id, settings, blocks, lookTag) => {
    const n = sectionFromPreset(type, 0, id);
    n.settings = { ...n.settings, ...settings };
    if (blocks) n.blocks = blocks;
    n.hidden = false;
    if (lookTag) n.lookTag = lookTag;
    return n;
  };

  const hero = node(
    'hero',
    'hero-night',
    { mode: 'single' },
    [
      {
        id: 'night-1',
        type: 'slide',
        settings: {
          image: img('hero-night.webp'),
          alt: 'A covered souq arcade at night, lit by rows of champagne lanterns',
          headline: 'The souq is lit',
          headlineAr: 'السوق منوّر',
          ctaText: 'Shop the deals',
          ctaTextAr: 'تسوّق العروض',
          ctaHref: '/products',
        },
      },
    ],
    'souq.night'
  );
  // Night souq only: ONE featured product right under the lantern hero (STOP-2 taste audit).
  const nightPick = node(
    'product-spotlight',
    'night-pick',
    {
      heading: '',
      headingAr: '',
      productSource: 'manual',
      manualProductIds: [idOf(STAGES[0])],
      limit: 1,
    },
    undefined,
    'souq.night'
  );
  const categories = node('category-grid', 'categories', {
    title: 'Shop by category',
    titleAr: 'تسوّق حسب القسم',
  });
  const curated = node(
    'product-carousel',
    'curated',
    {
      title: 'From the souq',
      titleAr: 'من السوق',
      productSource: 'manual',
      manualProductIds: CURATED.map(idOf),
      limit: 8,
    },
    undefined,
    'souq.night'
  );
  const deals = node('product-carousel', 'deals', {
    title: 'Deals today',
    titleAr: 'عروض النهاردة',
    productSource: 'on_sale',
    limit: 8,
  });
  const newIn = node('featured-collection', 'new-in', {
    heading: 'New in',
    headingAr: 'لسه واصل',
    productSource: 'newest',
    limit: 12,
    buttonText: 'See all',
    buttonTextAr: 'عرض الكل',
    buttonLink: '/products?sort=newest',
  });
  const stages = STAGES.map((slug, i) =>
    node(
      'product-spotlight',
      `stage-${i + 1}`,
      {
        // no kicker: the registry's first spotlight preset is "Gift ideas" (STOP-1 finding)
        heading: '',
        headingAr: '',
        productSource: 'manual',
        manualProductIds: [idOf(slug)],
        limit: 1,
      },
      undefined,
      // the three stages are the Showroom's identity (Night keeps its own single `night-pick`)
      'souq.showroom'
    )
  );
  const collections = node(
    'collection-list',
    'collections',
    { heading: 'Shop by category', headingAr: 'تسوّق حسب القسم' },
    COLLECTIONS.map(([slug, file], i) => ({
      id: `collection-${i + 1}`,
      type: 'collection',
      settings: { categorySlug: slug, image: img(file) },
    }))
  );
  const trust = node('trust-strip', 'trust', {});
  const newsletter = node('newsletter', 'newsletter', {});
  const story = node('brand-story', 'brand-story', {});

  // T7 signature: the stage phone's own numbers (the catalogue's 6.7 inch, 256GB variant).
  const signature = node(
    'spec-sheet',
    'signature',
    {
      kicker: 'Phone of the week',
      kickerAr: 'موبايل الأسبوع',
      title: 'Smartphone 6.7 inch',
      titleAr: 'هاتف ذكي 6.7 بوصة',
      subtitle: 'Three cameras and a battery that lasts the whole day.',
      subtitleAr: 'تلات كاميرات وبطارية بتكمّل اليوم كله.',
      image: img('smartphone.webp'),
      alt: 'A 6.7 inch smartphone',
      altAr: 'موبايل شاشته 6.7 بوصة',
      ctaText: 'View the phone',
      ctaTextAr: 'عرض الموبايل',
      ctaHref: '/products/smartphone-6-7',
    },
    [
      {
        id: 'spec-1',
        type: 'spec',
        settings: { value: '6.7', label: 'inch screen', labelAr: 'بوصة الشاشة' },
      },
      {
        id: 'spec-2',
        type: 'spec',
        settings: { value: '3', label: 'cameras', labelAr: 'كاميرات' },
      },
      {
        id: 'spec-3',
        type: 'spec',
        settings: { value: '256', label: 'GB storage', labelAr: 'جيجا مساحة' },
      },
    ]
  );
  const hiddenLegacy = base.sections
    .filter(n => !USED.includes(n.type))
    .filter(n => getSectionDefinition(n.type)?.legacyKey)
    .map(n => ({ ...n, hidden: true }));
  return {
    ...base,
    sectionGroups: {
      header: base.sectionGroups.header.map(n => ({ ...n, hidden: false })),
      footer: base.sectionGroups.footer.map(n => ({ ...n, hidden: false })),
    },
    sections: [
      hero,
      nightPick,
      categories,
      curated,
      deals,
      newIn,
      ...stages,
      collections,
      trust,
      newsletter,
      story,
      signature,
      ...hiddenLegacy,
    ],
  };
}
