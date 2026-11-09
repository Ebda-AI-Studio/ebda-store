// Voice (quality bar §2, Ahmad's ruling e): labels and buttons use neutral noun forms (the verbal
// noun "تسوّق", never the feminine imperative "تسوقي"); full sentences are in the store's
// Egyptian voice and never address the shopper by gender. One register per page.
// The Qamar showroom home document (Phase B1 Task 6): a SUPERSET of every Qamar section, built from
// registry presets plus CONTENT settings only. Design keys (presentation, layout, columns...) come
// from the look's section mix at render (Ruling B1-8) or from `applyLook` on a merchant store.
// One hero per look, tagged with `lookTag` (plan amendment C10), each with its own imagery; the
// Atelier hero carries the hero clip. Shop-the-look (Task 7) is tagged for Lookbook; the occasion
// list carries each band's tone (Task 8), used when a look sets `tileShape: 'band'` (Vitrine).
import { getSectionDefinition, sectionFromPreset } from '@ebda/shared';
import { QAMAR_LOOKS_STORY, QAMAR_OCCASIONS, QAMAR_PAGE_IMAGES } from '../qamar-demo/catalogue.mjs';

/** Alt text for the three look photos (read back from the assets), by look id. */
const LOOK_ALT = {
  // LB-04 (W2a): front views that show every piece the panel lists.
  'look-1': {
    alt: 'A woman on a Cairo rooftop in a rose linen abaya, a burgundy chiffon headscarf and a gold silk shawl',
    altAr: 'ست على سطح في القاهرة لابسة عباية كتان وردي وطرحة شيفون نبيتي وشال حرير دهبي',
  },
  'look-2': {
    alt: 'A woman at dusk in a teal satin dress under an open black abaya, a gold silk shawl as her headscarf',
    altAr: 'ست وقت المغرب لابسة فستان ساتان تركواز وعباية سودا مفتوحة وشال حرير دهبي على راسها',
  },
  'look-3': {
    alt: 'A woman at sunset in an embroidered ivory kaftan under an open black abaya, with a brown cotton headscarf',
    altAr: 'ست وقت الغروب لابسة قفطان أوف وايت مطرز تحت عباية سودا مفتوحة وطرحة قطن بني',
  },
};

/** Section types this document owns; legacy sections outside it are kept but hidden. */
const USED = [
  'editorial-collage', // T7 signature section
  'hero',
  'shop-the-look',
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
  const { img, video, productIdBySlug } = ctx;
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
        // The model stands at the top of the still: keep her head in the wide desktop crop (B1-32).
        focus: 'top',
        ...(video ? { video } : {}),
        alt: 'A woman in a dusty rose linen abaya beside a clothing rail',
        headline: 'Linen for the Cairo summer',
        headlineAr: 'كتان لصيف القاهرة',
        ctaText: 'Shop abayas',
        ctaTextAr: 'تسوّق العبايات',
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
        ctaTextAr: 'تسوّق اللوكات',
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
        // Vitrine fills its frame (frame: 'line'): keep the gown's neckline and shoulders in the
        // wide desktop crop, where the 16:9 still loses ~40% of its height (B1-32).
        focus: 'top',
        alt: 'An evening gown in a boutique window at dusk',
        // VT-02: idiomatic English for «لليلة الفرح» (the literal line read as a translation).
        headline: 'Dressed for the wedding',
        headlineAr: 'لليلة الفرح',
        ctaText: 'Shop evening wear',
        ctaTextAr: 'تسوّق فساتين السهرة',
        ctaHref: '/products?category=dresses',
      }),
    ],
    'qamar.vitrine'
  );
  // Lookbook only (lookTag): three looks from the catalogue's story, pieces by product id.
  const shopTheLook = node(
    'shop-the-look',
    'shop-the-look',
    { heading: 'Shop the look', headingAr: 'شوف اللوك كامل' },
    QAMAR_LOOKS_STORY.map(l => {
      const productIds = l.items.map(slug => productIdBySlug.get(slug));
      if (productIds.some(id => !id))
        throw new Error(`shop-the-look ${l.id}: a piece is not in the seeded catalogue`);
      return {
        id: l.id,
        type: 'look',
        settings: {
          image: img(l.image),
          ...LOOK_ALT[l.id],
          title: l.title,
          titleAr: l.titleAr,
          productIds,
        },
      };
    }),
    'qamar.lookbook'
  );
  const categories = node('category-grid', 'categories', {
    title: 'Shop by category',
    titleAr: 'تسوّق حسب القسم',
  });
  const newIn = node('featured-collection', 'new-in', {
    heading: 'New in',
    headingAr: 'وصل حديثًا',
    productSource: 'newest',
    limit: 8,
    buttonText: 'See all',
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
    buttonTextAr: 'كل المنتجات',
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
    { heading: 'Shop by occasion', headingAr: 'تسوّق حسب المناسبة' },
    QAMAR_OCCASIONS.map((o, i) => ({
      id: `occasion-${i + 1}`,
      type: 'collection',
      settings: {
        categorySlug: o.slug,
        image: img(o.image),
        label: o.label,
        labelAr: o.labelAr,
        tone: o.tone,
      },
    }))
  );
  const testimonials = node('testimonials', 'testimonials', {
    title: 'In their words',
    titleAr: 'قالوا عننا',
    minRating: 4,
    verifiedOnly: true,
  });
  const story = node('brand-story', 'brand-story', {});

  // T7 signature: the three look photos as one collage (Atelier and Vitrine; Lookbook's hero IS one).
  const signature = node(
    'editorial-collage',
    'signature',
    {
      kicker: 'This season',
      kickerAr: 'الموسم ده',
      title: 'Three looks, one wardrobe',
      titleAr: 'تلات لوكات من دولاب واحد',
      subtitle: 'One abaya, a shawl and a headscarf, styled three ways.',
      subtitleAr: 'عباية واحدة وشال وطرحة، متنسّقين بتلات طرق.',
      ctaText: 'Shop abayas',
      ctaTextAr: 'تسوّق العبايات',
      ctaHref: '/products?category=abayas',
    },
    QAMAR_LOOKS_STORY.map((l, i) => ({
      id: `photo-${i + 1}`,
      type: 'photo',
      settings: { image: img(l.image), ...LOOK_ALT[l.id] },
    }))
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
      heroAtelier,
      heroLookbook,
      heroVitrine,
      shopTheLook,
      categories,
      newIn,
      atelierBreak,
      abayas,
      occasions,
      testimonials,
      story,
      signature,
      ...hiddenLegacy,
    ],
  };
}
