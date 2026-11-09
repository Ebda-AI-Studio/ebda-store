// Voice (quality bar section 2, Ahmad's ruling e): labels and buttons use neutral noun forms
// ("تسوّق", never a gendered imperative); full sentences are in the store's Egyptian voice.
// The Jasmine showroom home document (Phase B3 Task 5): a SUPERSET of every Jasmine section, built
// from registry presets plus CONTENT settings only. Design keys (layout, source, bands...) come
// from the look's section mix at render (Ruling B1-8, `demoHomeDefinition`) or from `applyLook` on a
// merchant store. One hero per look (`lookTag`), so each look shows its own; the curated routine row
// is tagged Bloom; `steps` is read by Clinic only (a look that does not name a type simply leaves it
// out of the render). The three step products are the SAME three the routine bundle holds, so the
// routine's "add all" adds the real bundle and shows its live saving.
import { getSectionDefinition, sectionFromPreset } from '@ebda/shared';

/** The real cleanse -> treat -> protect routine (also the routine bundle's components). */
const ROUTINE = [
  [
    'gentle-cleanser-oily',
    'Cleanse',
    'تنظيف',
    'Lift oil and sunscreen without drying.',
    'نضّف من غير ما تجفّف.',
  ],
  ['niacinamide-serum', 'Treat', 'علاج', 'Calm oil and uneven tone.', 'هدّي الدهون وفتّح الدرجات.'],
  [
    'sunscreen-spf50',
    'Protect',
    'حماية',
    'Finish every morning with SPF 50.',
    'اختم كل صباح بحماية 50.',
  ],
];
/** The curated "routine of the week" row (Bloom). */
const CURATED = [
  'gentle-cleanser-oily',
  'creamy-cleanser-dry',
  'hyaluronic-serum',
  'ceramide-moisturiser',
  'sunscreen-spf50',
  'lip-balm',
];
/** Clinic's one stage: the hero active. */
const STAGE = 'vitamin-c-serum';

/** Section types this document owns; legacy sections outside it are kept but hidden. */
const USED = [
  'key-ingredients', // T7 signature section
  'hero',
  'category-grid',
  'steps',
  'product-spotlight',
  'featured-collection',
  'product-carousel',
  'testimonials',
  'trust-strip',
  'newsletter',
];

/**
 * @param {import('@ebda/shared').PageDefinition} base the store's current home document
 * @param {{ img(f: string): string, productIdBySlug: Map<string, string> }} ctx
 */
export function buildJasmineHome(base, ctx) {
  const { img, productIdBySlug } = ctx;
  const idOf = slug => {
    const id = productIdBySlug.get(slug);
    if (!id) throw new Error(`jasmine home: ${slug} is not in the seeded catalogue`);
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
    heroFor('jasmine.apothecary', 'apothecary', {
      alt: 'Jade, clear and cobalt glass bottles on olive linen with leaves and oats',
      headline: 'Ingredients you know',
      headlineAr: 'مكوّنات بتعرفها',
      // ingredients first: the hero names what is in the bottle
      subtitle: 'Jojoba, oats and green leaf. Nothing you cannot pronounce.',
      subtitleAr: 'جوجوبا وشوفان وورق أخضر. مفيش حاجة صعب تنطقها.',
      ctaText: 'Shop',
      ctaTextAr: 'تسوّق',
    }),
    heroFor('jasmine.bloom', 'bloom', {
      alt: 'A blush shelf of rose and berry cosmetic tubes and compacts',
      headline: 'Your shade',
      headlineAr: 'درجتك إنتي',
      ctaText: 'Shop the shades',
      ctaTextAr: 'تسوّق الدرجات',
    }),
    heroFor('jasmine.clinic', 'clinic', {
      alt: 'A quiet lineup of white and aqua skincare bottles on a white tile',
      headline: 'Skin first',
      headlineAr: 'بشرتك أولًا',
      ctaText: 'Start the routine',
      ctaTextAr: 'ابدأ الروتين',
    }),
  ];
  // One title for the single category row: it heads the skin-type chips, the rail and the grid.
  const categories = node('category-grid', 'categories', {
    title: 'Find your match',
    titleAr: 'اختار اللي يناسبك',
  });
  const steps = node(
    'steps',
    'routine',
    {
      heading: 'Your routine in 3 steps',
      headingAr: 'روتينك في 3 خطوات',
      subheading: 'Start with these three. Use them in this order.',
      subheadingAr: 'ابدأ بالتلاتة دول، وبالترتيب ده.',
    },
    ROUTINE.map(([slug, title, titleAr, body, bodyAr], i) => ({
      id: `step-${i + 1}`,
      type: 'step',
      settings: { title, titleAr, body, bodyAr, productIds: [idOf(slug)] },
    }))
  );
  const stage = node('product-spotlight', 'active-stage', {
    heading: '',
    headingAr: '',
    productSource: 'manual',
    manualProductIds: [idOf(STAGE)],
    limit: 1,
  });
  const newIn = node('featured-collection', 'new-in', {
    heading: 'New in',
    headingAr: 'لسه واصل',
    productSource: 'newest',
    limit: 8,
    buttonText: 'See all',
    buttonTextAr: 'عرض الكل',
    buttonLink: '/products?sort=newest',
  });
  const curated = node(
    'product-carousel',
    'curated',
    {
      title: 'This week routine',
      titleAr: 'روتين الأسبوع',
      productSource: 'manual',
      manualProductIds: CURATED.map(idOf),
      limit: 8,
    },
    undefined,
    'jasmine.bloom'
  );
  const deals = node('product-carousel', 'deals', {
    title: 'Deals',
    titleAr: 'عروض',
    productSource: 'on_sale',
    limit: 8,
  });
  const testimonials = node('testimonials', 'testimonials', {});
  const trust = node('trust-strip', 'trust', {});
  const newsletter = node('newsletter', 'newsletter', {});

  // T7 signature: the three ingredients the Apothecary hero already names.
  const signature = node(
    'key-ingredients',
    'signature',
    {
      kicker: 'Inside the bottle',
      kickerAr: 'جوّه الإزازة',
      title: 'Ingredients you know',
      titleAr: 'مكوّنات بتعرفها',
      subtitle: 'Short lists, every name you can say out loud.',
      subtitleAr: 'قوايم قصيرة، وكل اسم فيها سهل يتنطق.',
      image: img('hero-apothecary.webp'),
      alt: 'Jade, clear and cobalt glass bottles on olive linen with leaves and oats',
      altAr: 'إزازات زجاج أخضر وشفاف وأزرق على قماش زيتوني مع ورق وشوفان',
      ctaText: 'Shop skincare',
      ctaTextAr: 'تسوّق العناية',
      ctaHref: '/products',
    },
    [
      [
        'Jojoba oil',
        'زيت الجوجوبا',
        "Close to the skin's own oil, so it sinks in.",
        'قريب من زيت البشرة نفسه، فبيتشرب بسرعة.',
      ],
      ['Colloidal oats', 'الشوفان', 'Calms dry, tight skin.', 'بيهدّي البشرة الناشفة والمشدودة.'],
      [
        'Green tea leaf',
        'ورق الشاي الأخضر',
        'An antioxidant for the day.',
        'مضاد أكسدة لطول اليوم.',
      ],
      ['Shea butter', 'زبدة الشيا', 'Seals moisture in overnight.', 'بتقفل على الترطيب طول الليل.'],
    ].map(([name, nameAr, benefit, benefitAr], i) => ({
      id: `ingredient-${i + 1}`,
      type: 'ingredient',
      settings: { name, nameAr, benefit, benefitAr },
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
      ...heroes,
      categories,
      steps,
      stage,
      curated,
      newIn,
      deals,
      testimonials,
      trust,
      newsletter,
      signature,
      ...hiddenLegacy,
    ],
  };
}
