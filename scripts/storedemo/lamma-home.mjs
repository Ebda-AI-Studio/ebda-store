// Voice (quality bar section 2, Ahmad's ruling e): labels and buttons use neutral noun forms
// ("تسوّق", never a gendered imperative); full sentences are in the store's Egyptian voice.
// The Lamma showroom home document (Phase B4 Task 6): a SUPERSET of every Lamma section, built from
// registry presets plus CONTENT settings only. Design keys (menu layout, tabs, tiles, aisle tint,
// bands) come from the look's section mix at render (Ruling B1-8, `demoHomeDefinition`) or from
// `applyLook` on a merchant store. A section a look should not show is `lookTag`-ged to the one that
// does: the Table hero, the Table menu, the Notebook grid and the Market grid and deals row (each
// look's mix names `featured-collection` ONCE, and an unnamed or other-tagged one is simply left out
// of the render). The "order again" carousel, the maker profile and the trust strip are untagged:
// every look names them. The maker is FICTIONAL (Ruling B4-10).
import { getSectionDefinition, sectionFromPreset } from '@ebda/shared';

/** Section types this document owns; legacy sections outside it are kept but hidden. */
const USED = [
  'kitchen-days', // T7 signature section
  'hero',
  'category-grid',
  'product-carousel',
  'featured-collection',
  'maker-profile',
  'brand-story',
  'trust-strip',
];

/**
 * @param {import('@ebda/shared').PageDefinition} base the store's current home document
 * @param {{ img(f: string): string, productIdBySlug?: Map<string, string> }} ctx
 */
export function buildLammaHome(base, ctx) {
  const { img } = ctx;
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
    'hero-table',
    { mode: 'single' },
    [
      {
        id: 'table-1',
        type: 'slide',
        settings: {
          image: img('hero-table.webp'),
          ctaHref: '/products',
          alt: 'A Friday table spread seen from above: stuffed vine leaves, molokhia, rice, salad and bread',
          headline: 'Friday lunch, like at home',
          headlineAr: 'غدا الجمعة زي البيت',
          subtitle: 'Cooked the day before, delivered the day you pick.',
          subtitleAr: 'بنطبخه قبلها بيوم وبيوصلك اليوم اللي تختاره.',
          ctaText: 'See the menu',
          ctaTextAr: 'شوف المنيو',
        },
      },
    ],
    'lamma.table'
  );
  // One title for the single category row (the Market's aisle tiles).
  const categories = node('category-grid', 'categories', {
    title: 'Pick an aisle',
    titleAr: 'اختار الممر',
  });
  const reorder = node('product-carousel', 'reorder', {
    title: 'Order again',
    titleAr: 'اطلب تاني',
    productSource: 'reorder',
    limit: 8,
  });
  const menu = node(
    'featured-collection',
    'menu',
    {
      heading: "Today's menu",
      headingAr: 'منيو النهاردة',
      productSource: 'newest',
      limit: 24,
      buttonText: 'View all',
      buttonTextAr: 'عرض الكل',
      buttonLink: '/products',
    },
    undefined,
    'lamma.table'
  );
  const kitchen = node(
    'featured-collection',
    'from-the-kitchen',
    {
      heading: 'From the kitchen today',
      headingAr: 'من المطبخ النهاردة',
      productSource: 'newest',
      limit: 8,
      buttonText: 'View all',
      buttonTextAr: 'عرض الكل',
      buttonLink: '/products',
    },
    undefined,
    'lamma.notebook'
  );
  const fresh = node(
    'featured-collection',
    'fresh-today',
    {
      heading: 'Fresh today',
      headingAr: 'طازة النهاردة',
      productSource: 'newest',
      limit: 24,
      buttonText: 'View all',
      buttonTextAr: 'عرض الكل',
      buttonLink: '/products',
    },
    undefined,
    'lamma.market'
  );
  const deals = node(
    'product-carousel',
    'deals',
    {
      title: 'Deals today',
      titleAr: 'عروض النهاردة',
      productSource: 'on_sale',
      limit: 8,
    },
    undefined,
    'lamma.market'
  );
  // The fictional cook (Ruling B4-10): every field is content, nothing is a platform claim.
  const maker = node('maker-profile', 'maker', {
    image: img('maker.webp'),
    alt: 'Hands rolling a stuffed vine leaf on a wooden board',
    altAr: 'إيدين بتلف ورق عنب على لوح خشب',
    name: 'Om Salma',
    nameAr: 'أم سلمى',
    role: 'Cooking for my family and neighbours since 2012',
    roleAr: 'بطبخ لأسرتي وجيراني من 2012',
    story:
      'I started cooking for the building on Fridays and it grew from there. Every dish is made the day before delivery, in small batches.',
    storyAr:
      'بدأت أطبخ لجيراني يوم الجمعة وكبرت من هنا. كل طبق بيتعمل قبل التوصيل بيوم، على دفعات صغيرة.',
    hygiene: 'A small home kitchen, every order prepared fresh',
    hygieneAr: 'مطبخ بيتي صغير، وكل طلب بيتحضّر طازة',
    years: 14,
    storyLink: '/about',
  });
  const story = node('brand-story', 'story', {});
  const trust = node('trust-strip', 'trust', {});

  // T7 signature: the week's kitchen, dishes from the seeded menu.
  const signature = node(
    'kitchen-days',
    'signature',
    {
      kicker: 'Cooked fresh',
      kickerAr: 'طبخ النهاردة',
      title: "This week's kitchen",
      titleAr: 'مطبخ الأسبوع',
      subtitle: 'Order the day before and it leaves the kitchen hot.',
      subtitleAr: 'الطلب قبلها بيوم بيوصل سخن من المطبخ.',
      ctaText: 'See the menu',
      ctaTextAr: 'عرض المنيو',
      ctaHref: '/products',
    },
    [
      ['Saturday', 'السبت', 'Stuffed cabbage', 'محشي كرنب', 'mahshi-koronb.webp'],
      ['Sunday', 'الحد', 'Molokhia with chicken', 'ملوخية بالفراخ', 'molokhia-chicken.webp'],
      ['Monday', 'الاتنين', 'Okra tagine', 'طاجن بامية', 'okra-tagine.webp'],
      ['Tuesday', 'التلات', 'Béchamel pasta', 'مكرونة بشاميل', 'bechamel-pasta.webp'],
    ].map(([day, dayAr, dish, dishAr, photo], i) => ({
      id: `day-${i + 1}`,
      type: 'day',
      settings: { day, dayAr, dish, dishAr, image: img(photo) },
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
      hero,
      categories,
      maker,
      reorder,
      menu,
      kitchen,
      fresh,
      deals,
      story,
      trust,
      signature,
      ...hiddenLegacy,
    ],
  };
}
