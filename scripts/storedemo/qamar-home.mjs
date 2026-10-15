// The Qamar showroom home document (Phase B1 Task 6): a SUPERSET of every Qamar section, built from
// registry presets plus CONTENT settings only. Design keys (presentation, layout, columns...) come
// from the look's section mix at render (Ruling B1-8) or from `applyLook` on a merchant store.
// One hero per look, tagged with `lookTag` (plan amendment C10), each with its own imagery; the
// Atelier hero carries the hero clip. Shop-the-look (Task 7) and the occasion band tone (Task 8)
// land with those tasks.
import { getSectionDefinition, sectionFromPreset } from '@ebda/shared';
import { QAMAR_OCCASIONS, QAMAR_PAGE_IMAGES } from '../qamar-demo/catalogue.mjs';

/** Section types this document owns; legacy sections outside it are kept but hidden. */
const USED = [
  'hero',
  'category-grid',
  'featured-collection',
  'image-text',
  'product-carousel',
  'collection-list',
  'testimonials',
  'brand-story',
];

/**
 * @param {import('@ebda/shared').PageDefinition} base the store's current home document
 * @param {{ img(f: string): string, video?: string | null, productIdBySlug: Map<string, string> }} ctx
 *   `productIdBySlug` feeds the shop-the-look blocks (Task 7).
 */
export function buildQamarHome(base, ctx) {
  const { img, video } = ctx;
  const node = (type, id, settings, blocks, lookTag) => {
    const n = sectionFromPreset(type, 0, id);
    n.settings = { ...n.settings, ...settings };
    if (blocks) n.blocks = blocks;
    n.hidden = false;
    if (lookTag) n.lookTag = lookTag;
    return n;
  };
  const slide = (id, s) => ({ id, type: 'slide', settings: s });

  const heroAtelier = node(
    'hero',
    'hero-atelier',
    { mode: 'single' },
    [
      slide('atelier-1', {
        image: img(QAMAR_PAGE_IMAGES.heroAtelier),
        ...(video ? { video } : {}),
        alt: 'A woman in a dusty rose linen abaya beside a clothing rail',
        headline: 'Linen for the Cairo summer',
        headlineAr: 'كتان لصيف القاهرة',
        ctaText: 'Shop abayas',
        ctaTextAr: 'تسوقي العبايات',
        ctaHref: '/products?category=abayas',
      }),
    ],
    'qamar.atelier'
  );
  const heroLookbook = node(
    'hero',
    'hero-lookbook',
    { mode: 'slider', autoplayMs: 6000 },
    QAMAR_PAGE_IMAGES.lookbook.map((f, i) =>
      slide(`lookbook-${i + 1}`, {
        image: img(f),
        alt: 'Outfit photographed on a Cairo rooftop at golden hour',
        headline: 'Dressed for the rooftop',
        headlineAr: 'لبس السطوح',
        ctaText: 'Shop the looks',
        ctaTextAr: 'تسوقي اللوكات',
        ctaHref: '/products',
      })
    ),
    'qamar.lookbook'
  );
  const heroVitrine = node(
    'hero',
    'hero-vitrine',
    { mode: 'single' },
    [
      slide('vitrine-1', {
        image: img(QAMAR_PAGE_IMAGES.heroVitrine),
        alt: 'An evening gown in a boutique window at dusk',
        headline: 'For the night of the wedding',
        headlineAr: 'لليلة الفرح',
        ctaText: 'Shop evening wear',
        ctaTextAr: 'تسوقي فساتين السهرة',
        ctaHref: '/products?category=dresses',
      }),
    ],
    'qamar.vitrine'
  );
  const categories = node('category-grid', 'categories', {
    title: 'Shop by category',
    titleAr: 'تسوقي حسب القسم',
  });
  const newIn = node('featured-collection', 'new-in', {
    heading: 'New in',
    headingAr: 'وصل حديثًا',
    productSource: 'newest',
    limit: 8,
    buttonText: 'View all',
    buttonTextAr: 'عرض الكل',
    buttonLink: '/products?sort=newest',
  });
  const atelierBreak = node('image-text', 'atelier-break', {
    image: img(QAMAR_PAGE_IMAGES.break),
    alt: 'Abayas in black, rose and ivory on a rail in a white atelier',
    altAr: 'عبايات سودا ووردي وأوف وايت على شماعة في أتيليه أبيض',
    heading: 'Cut and sewn in Heliopolis',
    headingAr: 'متفصلة ومتخيطة في مصر الجديدة',
    body: 'Every piece is cut in our workshop and finished by hand. Delivery across Egypt, cash on delivery.',
    bodyAr: 'كل قطعة بتتقص في ورشتنا وبتتشطب باليد. توصيل لكل مصر، والدفع عند الاستلام.',
    buttonText: 'Shop everything',
    buttonTextAr: 'تسوقي كل حاجة',
    buttonLink: '/products',
  });
  const abayas = node('product-carousel', 'abayas', {
    title: 'Abayas',
    titleAr: 'عبايات',
    productSource: 'category',
    categorySlug: 'abayas',
    limit: 12,
  });
  const occasions = node(
    'collection-list',
    'occasions',
    { heading: 'Shop by occasion', headingAr: 'تسوقي حسب المناسبة' },
    QAMAR_OCCASIONS.map((o, i) => ({
      id: `occasion-${i + 1}`,
      type: 'collection',
      settings: { categorySlug: o.slug, image: img(o.image), label: o.label, labelAr: o.labelAr },
    }))
  );
  const testimonials = node('testimonials', 'testimonials', {
    title: 'In their words',
    titleAr: 'قالوا عننا',
    minRating: 4,
    verifiedOnly: true,
  });
  const story = node('brand-story', 'brand-story', {});

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
      heroAtelier,
      heroLookbook,
      heroVitrine,
      categories,
      newIn,
      atelierBreak,
      abayas,
      occasions,
      testimonials,
      story,
      ...hiddenLegacy,
    ],
  };
}
