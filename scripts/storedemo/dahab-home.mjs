// Voice (quality bar section 2, Ahmad's ruling e): labels and buttons use neutral noun forms
// ("تسوّق", never a gendered imperative); full sentences are in the store's Egyptian voice.
// The Dahab showroom home document (Phase B5 Task 5): a SUPERSET of every Dahab section, built from
// registry presets plus CONTENT settings only. Design keys (presentation, layout, columns, bands) come
// from the look's section mix at render (Ruling B1-8, `demoHomeDefinition`) or from `applyLook` on a
// merchant store. A section a look should not show is `lookTag`-ged to the one that does: one hero per
// look, one featured collection and one image-with-text per look (each mix names those types ONCE, with
// its own copy), the steps (Workshop only) and the gift finder (Gift box only). The category chips, the
// carousel, the reviews, the collection list, the trust badges, the story and the newsletter are
// untagged: a look that does not name a type simply leaves it out of the render. Every photo is an
// illustrative AI image (scripts/dahab-demo/CREDITS.md), unbranded.
import { getSectionDefinition, sectionFromPreset } from '@ebda/shared';

/** Section types this document owns; legacy sections outside it are kept but hidden. */
const USED = [
  'piece-window', // T7 signature section
  'hero',
  'category-grid',
  'steps',
  'gift-finder',
  'featured-collection',
  'image-text',
  'product-carousel',
  'testimonials',
  'collection-list',
  'trust-badges',
  'brand-story',
  'newsletter',
];

/** The four collections of the Workshop's collection list: [category slug, English, Arabic, photo]. */
const COLLECTIONS = [
  ['rings', 'Rings', 'خواتم', 'ring-solitaire.webp'],
  ['necklaces', 'Necklaces', 'سلاسل', 'necklace-pearl.webp'],
  ['bracelets', 'Bracelets', 'أساور', 'bracelet-tennis.webp'],
  ['earrings', 'Earrings', 'حلقان', 'earrings-pearl.webp'],
];
/** The gift finder: occasions are categories (hidden from the home row), budgets are whole pounds. */
const OCCASIONS = [
  ['engagement', 'Engagement', 'خطوبة'],
  ['birthday', 'Birthday', 'عيد ميلاد'],
  ['mothers-day', "Mother's Day", 'عيد الأم'],
  ['graduation', 'Graduation', 'تخرج'],
];
const BUDGETS = [1000, 2000, 5000];

/**
 * @param {import('@ebda/shared').PageDefinition} base the store's current home document
 * @param {{ img(f: string): string, productIdBySlug?: Map<string, string> }} ctx
 */
export function buildDahabHome(base, ctx) {
  const { img } = ctx;
  const node = (type, id, settings, blocks, lookTag) => {
    const n = sectionFromPreset(type, 0, id);
    n.settings = { ...n.settings, ...settings };
    if (blocks) n.blocks = blocks;
    n.hidden = false;
    if (lookTag) n.lookTag = lookTag;
    return n;
  };
  const heroFor = (look, key, slide) =>
    node(
      'hero',
      `hero-${key}`,
      { mode: 'single' },
      [
        {
          id: `${key}-1`,
          type: 'slide',
          settings: { image: img(`hero-${key}.webp`), ctaHref: '/products', ...slide },
        },
      ],
      look
    );
  const heroes = [
    heroFor('dahab.worn', 'worn', {
      alt: 'A slim ring and a fine chain on pale linen by a window',
      headline: 'Worn, not displayed',
      headlineAr: 'بتتلبس، مش بتتعرض',
      subtitle: 'The size and the karat are on every piece.',
      subtitleAr: 'المقاس والعيار باينين على كل قطعة.',
      ctaText: 'Shop',
      ctaTextAr: 'تسوّق',
    }),
    heroFor('dahab.workshop', 'workshop', {
      alt: "A jeweller's bench with steel tools, a ring on a mandrel and small enamel dishes",
      headline: 'Made by hand, one at a time',
      headlineAr: 'بالإيد، قطعة قطعة',
      subtitle: 'From the drawing to the polish, in our small workshop.',
      subtitleAr: 'من الرسم للتلميع، في ورشتنا الصغيرة.',
      ctaText: 'Shop',
      ctaTextAr: 'تسوّق',
    }),
    heroFor('dahab.giftbox', 'giftbox', {
      alt: 'An open emerald green gift box with a white satin ribbon and a ring box inside',
      headline: 'Start with who it is for',
      headlineAr: 'ابدأ بمين الهدية',
      subtitle: 'Pick the person and the budget. We wrap it.',
      subtitleAr: 'اختار الشخص والميزانية وإحنا بنغلّفها.',
      ctaText: 'Shop gifts',
      ctaTextAr: 'تسوّق الهدايا',
    }),
  ];

  const categories = node('category-grid', 'categories', {
    title: 'Pick a piece',
    titleAr: 'اختار قطعتك',
  });
  const steps = node(
    'steps',
    'made',
    { heading: 'How a piece is made', headingAr: 'القطعة بتتعمل إزاي' },
    [
      [
        'Drawn',
        'رسم',
        'The shape is drawn by hand, then the wax is carved.',
        'الشكل بيتحط على الورق بالإيد، وبعدين الشمع بيتنحت.',
      ],
      [
        'Cast',
        'صب',
        'The wax becomes silver in the mould, one piece at a time.',
        'الشمع بيتحوّل فضة في القالب، قطعة قطعة.',
      ],
      [
        'Polished',
        'تلميع',
        'Filed, polished and checked before it is packed.',
        'بتتبرد وتتلمّع وتتراجع قبل ما تتغلف.',
      ],
    ].map(([title, titleAr, body, bodyAr], i) => ({
      id: `step-${i + 1}`,
      type: 'step',
      settings: { title, titleAr, body, bodyAr },
    })),
    'dahab.workshop'
  );
  const giftFinder = node(
    'gift-finder',
    'gift-finder',
    { heading: 'Find the right gift', headingAr: 'اختار الهدية المناسبة' },
    [
      ...OCCASIONS.map(([slug, label, labelAr], i) => ({
        id: `occasion-${i + 1}`,
        type: 'occasion',
        settings: { categorySlug: slug, label, labelAr },
      })),
      ...BUDGETS.map((maxPrice, i) => ({
        id: `budget-${i + 1}`,
        type: 'budget',
        settings: {
          maxPrice,
          label: `Up to ${maxPrice.toLocaleString('en')}`,
          labelAr: `لحد ${maxPrice.toLocaleString('en')}`,
        },
      })),
    ],
    'dahab.giftbox'
  );
  const featured = (look, key, heading, headingAr) =>
    node(
      'featured-collection',
      `featured-${key}`,
      {
        heading,
        headingAr,
        productSource: 'newest',
        limit: 8,
        buttonText: 'View all',
        buttonTextAr: 'عرض الكل',
        buttonLink: '/products',
      },
      undefined,
      look
    );
  const featuredNodes = [
    featured('dahab.worn', 'worn', 'Worn every day', 'بتتلبس كل يوم'),
    featured('dahab.workshop', 'workshop', 'Made to order', 'بتتعمل بالطلب'),
    featured('dahab.giftbox', 'giftbox', 'Gifts she will keep', 'هدايا هتفضل معاها'),
  ];
  const imageText = (look, key, settings) =>
    node('image-text', `story-${key}`, { buttonLink: '/products', ...settings }, undefined, look);
  const imageTexts = [
    imageText('dahab.worn', 'worn', {
      image: img('ring-engraved.webp'),
      alt: 'A wide band ring on a white ground',
      heading: 'Your name, engraved',
      headingAr: 'اسمك محفور عليها',
      body: 'Pick a piece, type the letters, and the workshop engraves them before it ships.',
      bodyAr: 'اختار القطعة واكتب الحروف، والورشة بتحفرها قبل ما تتشحن.',
      buttonText: 'Personalise',
      buttonTextAr: 'خصّص',
    }),
    imageText('dahab.workshop', 'workshop', {
      image: img('hero-workshop.webp'),
      alt: 'Steel tools and enamel dishes on a jeweller’s bench',
      heading: 'Small workshop, real hands',
      headingAr: 'ورشة صغيرة وإيد حقيقية',
      body: 'Every piece is made in small batches, so a custom size is a normal request.',
      bodyAr: 'كل قطعة بتتعمل في دفعات صغيرة، فالمقاس المخصوص طلب عادي.',
      buttonText: 'Ask for a size',
      buttonTextAr: 'اطلب مقاس',
    }),
    imageText('dahab.giftbox', 'giftbox', {
      image: img('gift-box.webp'),
      alt: 'A small emerald green gift box with a white satin ribbon',
      heading: 'Wrapped to the front door',
      headingAr: 'بنغلّفها لحد باب الفرح',
      body: 'An emerald box, a satin ribbon and your own message on a card.',
      bodyAr: 'علبة زمردية وشريط ساتان ورسالتك على كارت.',
      buttonText: 'Add a wrap',
      buttonTextAr: 'أضف تغليف',
    }),
  ];
  const carousel = node('product-carousel', 'new-in', {
    title: 'New in',
    titleAr: 'وصل حديثاً',
    productSource: 'newest',
    limit: 8,
  });
  const reviews = node('testimonials', 'reviews', {});
  const collections = node(
    'collection-list',
    'collections',
    { heading: 'Shop by collection', headingAr: 'تسوّق حسب المجموعة' },
    COLLECTIONS.map(([categorySlug, label, labelAr, photo], i) => ({
      id: `collection-${i + 1}`,
      type: 'collection',
      settings: { categorySlug, label, labelAr, image: img(photo) },
    }))
  );
  const trust = node('trust-badges', 'trust', {});
  const story = node('brand-story', 'story', {});
  const newsletter = node('newsletter', 'newsletter', {});

  // T7 signature: one piece in the window.
  const signature = node('piece-window', 'signature', {
    kicker: 'In the window',
    kickerAr: 'في الفاترينة',
    title: 'The solitaire ring',
    titleAr: 'خاتم السوليتير',
    subtitle: 'One stone, set by hand, sized to order.',
    subtitleAr: 'فص واحد متركّب بالإيد، ومقاسه حسب طلبك.',
    image: img('ring-solitaire.webp'),
    alt: 'A solitaire ring on a soft cloth',
    altAr: 'خاتم سوليتير على قماشة ناعمة',
    ctaText: 'See the rings',
    ctaTextAr: 'عرض الخواتم',
    ctaHref: '/products',
  });
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
      ...heroes,
      categories,
      steps,
      giftFinder,
      ...featuredNodes,
      ...imageTexts,
      carousel,
      reviews,
      collections,
      trust,
      story,
      newsletter,
      signature,
      ...hiddenLegacy,
    ],
  };
}
