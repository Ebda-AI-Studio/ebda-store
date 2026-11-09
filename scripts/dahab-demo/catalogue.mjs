// Dahab demo catalogue (Phase B5 Task 5): an Egyptian jewellery shop, Arabic first, prices in piastres
// (1 EGP = 100). Data only: `scripts/storedemo/seed.mjs --template dahab` writes it,
// tests/unit/dahab-demo-catalogue.test.ts enforces every feature below by count. UNBRANDED and
// FICTIONAL on purpose (Rulings B5-10, B5-11): generic Egyptian piece names, no brand, no hallmark,
// no lettering. Photos are AI-generated ILLUSTRATIVE samples (scripts/dahab-demo/CREDITS.md).
//
// Features present at least once (the test counts them): rings with the "مقاس الخاتم" size chart and a
// METAL swatch option (silver, rose gold, champagne: never a yellow-gold swatch), a length option on
// necklaces, wrap as a variant option (B5-4) and a card message as personalisation, a gift card with
// fixed amounts as variants, facts on every piece (karat, width, weight, warranty; at most two on the
// card), two pieces with REQUIRED engraving ("الحروف للحفر", max 12), four made-to-order pieces with a
// lead time of 3-7 days, sale prices on variants, one sold-out variant, one backorder piece, occasion
// categories hidden from the home row, and SIX GOLD-RATE pieces (two per karat; one with a per-gram
// making charge, one with a fixed one, a ring whose size variants weigh differently): their price is
// computed from the store's rate (the seed writes the spec through GoldRateService; `price` here is
// only the placeholder the row is created with).

/** @typedef {{ value: string, valueAr: string, hex?: string, priceAdd?: number, weightMg?: number }} DahabOptionValue */
/** @typedef {{ name: string, nameAr: string, values: DahabOptionValue[] }} DahabOption */
/**
 * @typedef {{ karat: 24 | 21 | 18, weightMg: number, makingChargeType: 'fixed' | 'per_gram',
 *   makingChargeValue: number, marginBps: number }} DahabGoldSpec
 * @typedef {{ slug: string, name: string, nameAr: string, category: string, alsoIn?: string[], price: number,
 *   compareAtPrice?: number, images: string[], description: string, descriptionAr: string,
 *   options?: DahabOption[], soldOut?: string[][], backorder?: boolean, gold?: DahabGoldSpec,
 *   facts: { key: string, keyAr: string, value: string, valueAr: string, onCard?: boolean }[],
 *   leadTimeDays?: number, stock?: number,
 *   personalisation?: { label: string, labelAr: string, maxLength: number, required: boolean } }} DahabProduct
 */

/** The shop's occasions: categories the gift finder links to, hidden from the home category row. */
export const DAHAB_OCCASIONS = [
  { slug: 'engagement', name: 'Engagement', nameAr: 'خطوبة' },
  { slug: 'birthday', name: 'Birthday', nameAr: 'عيد ميلاد' },
  { slug: 'mothers-day', name: "Mother's Day", nameAr: 'عيد الأم' },
  { slug: 'graduation', name: 'Graduation', nameAr: 'تخرج' },
];

export const DAHAB_CATEGORIES = [
  {
    slug: 'rings',
    name: 'Rings',
    nameAr: 'خواتم',
    sizeChart: 'ring',
    image: 'ring-solitaire.webp',
  },
  { slug: 'necklaces', name: 'Necklaces', nameAr: 'سلاسل وقلادات', image: 'necklace-pearl.webp' },
  {
    slug: 'bracelets',
    name: 'Bracelets and bangles',
    nameAr: 'أساور وغوايش',
    image: 'bracelet-tennis.webp',
  },
  { slug: 'earrings', name: 'Earrings', nameAr: 'حلقان', image: 'earrings-pearl.webp' },
  { slug: 'sets', name: 'Sets', nameAr: 'أطقم', image: 'set-bridal.webp' },
  {
    slug: 'gold-rate',
    name: 'Gold at today’s rate',
    nameAr: 'دهب بسعر النهارده',
    image: 'gold-bar.webp',
  },
  { slug: 'gifts', name: 'Gifts', nameAr: 'هدايا', image: 'gift-box.webp' },
  ...DAHAB_OCCASIONS,
];

export const DAHAB_SIZE_CHARTS = {
  ring: {
    name: 'Ring size',
    nameAr: 'مقاس الخاتم',
    unit: 'cm',
    columns: [
      { label: 'Size', labelAr: 'المقاس' },
      { label: 'Inner diameter', labelAr: 'القطر الداخلي' },
      { label: 'Circumference', labelAr: 'المحيط' },
    ],
    rows: [
      ['12', '1.2', '3.8'],
      ['14', '1.4', '4.4'],
      ['16', '1.6', '5.0'],
      ['18', '1.8', '5.7'],
      ['20', '2.0', '6.3'],
      ['22', '2.2', '6.9'],
    ],
    note: 'The size number is the inner diameter in millimetres.',
    noteAr: 'رقم المقاس هو القطر الداخلي بالمليمتر.',
  },
};

/**
 * FALLBACK rates for the demo, piastres per gram (market on 2026-10-23: 24k 7,101 EGP/g, 21k and 18k derived
 * from it). The seed stamps the LIVE feed rate instead (`marketGoldRates` in scripts/storedemo/seed.mjs) and
 * uses these only when the feed is down or its sources disagree. Keep them near market: a manual rate far
 * from the feed makes the first automatic run PENDING (jump gate) and the gold pieces pause when it goes stale.
 */
export const DAHAB_GOLD_RATES = [
  { karat: 24, ratePerGram: 710_100 },
  { karat: 21, ratePerGram: 621_400 },
  { karat: 18, ratePerGram: 532_600 },
];

// ---- fact helpers: at most TWO `onCard` chips per product (B0-4/B0-49, B5-5): karat and weight are
// the chips on a gold piece; width, warranty and the rest are table rows on the PDP.
const chip = (key, keyAr, value, valueAr = value) => ({ key, keyAr, value, valueAr, onCard: true });
const ROW = (key, keyAr, value, valueAr = value) => ({ key, keyAr, value, valueAr });
const KARAT = k => chip('Karat', 'العيار', `${k} karat`, `عيار ${k}`);
const WEIGHT = (g, ar = g) => chip('Weight', 'الوزن', `${g} g`, `${ar} جم`);
const WEIGHT_ROW = (g, ar = g) => ROW('Weight', 'الوزن', `${g} g`, `${ar} جم`);
const WIDTH = mm => ROW('Width', 'العرض', `${mm} mm`, `${mm} مم`);
const WARRANTY = ROW('Warranty', 'الضمان', 'One year', 'سنة');
const METAL = (en, ar) => ROW('Metal', 'المعدن', en, ar);

/** Gift wrap is a VARIANT option (Ruling B5-4): no schema, the price step is the wrap. */
const WRAP = {
  name: 'Gift wrap',
  nameAr: 'تغليف الهدية',
  values: [
    { value: 'No wrap', valueAr: 'من غير تغليف' },
    { value: 'Gift box', valueAr: 'علبة هدية', priceAdd: 5_000 },
  ],
};
const SIZES = (...sizes) => ({
  name: 'Size',
  nameAr: 'المقاس',
  values: sizes.map(s => ({ value: String(s), valueAr: String(s) })),
});
const LENGTHS = (...cm) => ({
  name: 'Length',
  nameAr: 'الطول',
  values: cm.map((c, i) => ({
    value: `${c} cm`,
    valueAr: `${c} سم`,
    ...(i > 0 ? { priceAdd: i * 12_000 } : {}),
  })),
});
/** The metal swatch: silver, rose gold, champagne. Never a yellow-gold swatch (Ruling B5-2). */
const METALS = {
  name: 'Metal',
  nameAr: 'المعدن',
  values: [
    { value: 'Silver', valueAr: 'فضة', hex: '#C4C7CC' },
    { value: 'Rose gold', valueAr: 'روز جولد', hex: '#C9A5A0', priceAdd: 20_000 },
    { value: 'Champagne', valueAr: 'شامبانيا', hex: '#D9D4C5', priceAdd: 20_000 },
  ],
};

/** @type {DahabProduct[]} */
export const DAHAB_PRODUCTS = [
  // ---------------------------------------------------------------- gold-rate pieces (two per karat)
  {
    slug: 'gold-bar-24',
    name: 'Gift gold bar, 24 karat',
    nameAr: 'سبيكة دهب هدية عيار 24',
    category: 'gold-rate',
    alsoIn: ['gifts', 'engagement', 'graduation'],
    price: 3_000_000,
    images: ['gold-bar.webp'],
    description:
      'A small 24 karat bar, priced from the day’s gold rate. A gift that keeps its value.',
    descriptionAr: 'سبيكة صغيرة عيار 24 بتتسعّر من سعر الدهب النهارده. هدية بتحافظ على قيمتها.',
    gold: {
      karat: 24,
      weightMg: 5_000,
      makingChargeType: 'fixed',
      makingChargeValue: 25_000,
      marginBps: 200,
    },
    facts: [KARAT(24), WEIGHT('5.00', '5.00'), WARRANTY],
  },
  {
    slug: 'gold-coin-24',
    name: 'Gift gold coin, 24 karat',
    nameAr: 'قطعة دهب هدية عيار 24',
    category: 'gold-rate',
    alsoIn: ['gifts', 'birthday'],
    price: 1_500_000,
    images: ['gold-coin.webp'],
    description: 'A plain round coin, 24 karat, in a small box. Priced from the day’s gold rate.',
    descriptionAr: 'قطعة دايرة سادة عيار 24 في علبة صغيرة. بتتسعّر من سعر الدهب النهارده.',
    gold: {
      karat: 24,
      weightMg: 2_500,
      makingChargeType: 'per_gram',
      makingChargeValue: 30_000,
      marginBps: 300,
    },
    facts: [KARAT(24), WEIGHT('2.50', '2.50'), WARRANTY],
  },
  {
    slug: 'gold-chain-21',
    name: 'Gold chain, 21 karat',
    nameAr: 'سلسلة دهب عيار 21',
    category: 'gold-rate',
    alsoIn: ['necklaces', 'mothers-day'],
    price: 3_000_000,
    images: ['necklace-chain.webp'],
    description:
      'A fine cable chain in 21 karat gold. The price follows the gold rate; the making charge is per gram.',
    descriptionAr: 'سلسلة رفيعة من الدهب عيار 21. السعر بيتبع سعر الدهب والمصنعية بالجرام.',
    gold: {
      karat: 21,
      weightMg: 6_200,
      makingChargeType: 'per_gram',
      makingChargeValue: 20_000,
      marginBps: 500,
    },
    facts: [KARAT(21), WEIGHT('6.20', '6.20'), WIDTH('1.2', '1.2'), WARRANTY],
  },
  {
    slug: 'gold-bangle-21',
    name: 'Plain gold bangle, 21 karat',
    nameAr: 'غويشة دهب سادة عيار 21',
    category: 'gold-rate',
    alsoIn: ['bracelets', 'engagement', 'mothers-day'],
    price: 4_500_000,
    images: ['bangle-plain.webp'],
    description:
      'A smooth round bangle in 21 karat gold. A fixed making charge; the price follows the gold rate.',
    descriptionAr: 'غويشة دايرة ناعمة من الدهب عيار 21. مصنعية ثابتة والسعر بيتبع سعر الدهب.',
    gold: {
      karat: 21,
      weightMg: 9_800,
      makingChargeType: 'fixed',
      makingChargeValue: 50_000,
      marginBps: 400,
    },
    facts: [KARAT(21), WEIGHT('9.80', '9.80'), WIDTH('4', '4'), WARRANTY],
  },
  {
    slug: 'gold-solitaire-18',
    name: 'Solitaire ring, 18 karat',
    nameAr: 'خاتم سوليتير عيار 18',
    category: 'gold-rate',
    alsoIn: ['rings', 'engagement'],
    price: 1_000_000,
    images: ['ring-solitaire.webp'],
    description:
      'One small clear stone in four claws on a slim 18 karat band. Each size weighs a little differently, and the price follows the weight.',
    descriptionAr:
      'فص واحد صغير على أربع مخالب فوق دبلة رفيعة من الدهب عيار 18. كل مقاس وزنه مختلف شوية والسعر بيتبع الوزن.',
    options: [
      {
        name: 'Size',
        nameAr: 'المقاس',
        values: [
          { value: '14', valueAr: '14', weightMg: 2_400 },
          { value: '16', valueAr: '16', weightMg: 2_600 },
          { value: '18', valueAr: '18', weightMg: 2_900 },
        ],
      },
    ],
    gold: {
      karat: 18,
      weightMg: 2_600,
      makingChargeType: 'per_gram',
      makingChargeValue: 25_000,
      marginBps: 600,
    },
    facts: [KARAT(18), WEIGHT('2.60', '2.60'), WIDTH('1.8', '1.8'), WARRANTY],
  },
  {
    slug: 'gold-hoops-18',
    name: 'Small hoop earrings, 18 karat',
    nameAr: 'حلقان دايرة صغيرة عيار 18',
    category: 'gold-rate',
    alsoIn: ['earrings', 'birthday', 'graduation'],
    price: 1_300_000,
    images: ['earrings-hoop.webp'],
    description:
      'A pair of small hoops in 18 karat gold, light enough for every day. Priced from the gold rate.',
    descriptionAr: 'حلقان دايرة صغيرة من الدهب عيار 18، خفيفة لكل يوم. بتتسعّر من سعر الدهب.',
    gold: {
      karat: 18,
      weightMg: 3_100,
      makingChargeType: 'per_gram',
      makingChargeValue: 22_000,
      marginBps: 500,
    },
    facts: [KARAT(18), WEIGHT('3.10', '3.10'), WARRANTY],
  },

  // ---------------------------------------------------------------- rings (fixed price)
  {
    slug: 'silver-band-ring',
    name: 'Plain band ring',
    nameAr: 'خاتم سادة',
    category: 'rings',
    alsoIn: ['birthday'],
    price: 65_000,
    compareAtPrice: 85_000,
    images: ['ring-silver.webp'],
    description:
      'A smooth, slightly domed band in sterling silver, rose gold plating or champagne plating.',
    descriptionAr:
      'دبلة ناعمة مقوّسة شوية من الفضة الإسترليني، أو بطلاء روز جولد، أو بطلاء شامبانيا.',
    options: [METALS, SIZES(14, 16, 18)],
    soldOut: [['Champagne', '18']],
    facts: [
      chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'),
      chip('Width', 'العرض', '3 mm', '3 مم'),
      WARRANTY,
    ],
  },
  {
    slug: 'engraved-ring',
    name: 'Ring with your letters',
    nameAr: 'خاتم بحروفك',
    category: 'rings',
    alsoIn: ['engagement', 'birthday'],
    price: 120_000,
    images: ['ring-engraved.webp'],
    description:
      'A wide band engraved inside with the letters you choose, made for you in a few days.',
    descriptionAr: 'دبلة عريضة بتتحفر من جوه بالحروف اللي تختارها، وبتتعملك في كام يوم.',
    options: [SIZES(14, 16, 18, 20)],
    leadTimeDays: 5,
    personalisation: {
      label: 'Letters to engrave',
      labelAr: 'الحروف للحفر',
      maxLength: 12,
      required: true,
    },
    facts: [chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'), WIDTH('6', '6'), WARRANTY],
  },
  {
    slug: 'signet-ring',
    name: 'Small signet ring',
    nameAr: 'خاتم ختم صغير',
    category: 'rings',
    price: 98_000,
    images: ['ring-signet.webp'],
    description: 'A small oval top on a plain band, left blank for your own initial.',
    descriptionAr: 'سطح بيضاوي صغير على دبلة سادة، سايبينه فاضي لحرفك إنت.',
    options: [SIZES(16, 18, 20)],
    facts: [chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'), WIDTH('8', '8'), WARRANTY],
  },

  // ---------------------------------------------------------------- necklaces
  {
    slug: 'name-necklace',
    name: 'Necklace with your name',
    nameAr: 'سلسلة باسمك',
    category: 'necklaces',
    alsoIn: ['birthday', 'mothers-day', 'graduation'],
    price: 135_000,
    images: ['necklace-name.webp'],
    description:
      'A fine chain with a small plate engraved with the name you choose. Made for you in about a week.',
    descriptionAr: 'سلسلة رفيعة بلوحة صغيرة محفور عليها الاسم اللي تختاره. بتتعملك في حوالي أسبوع.',
    options: [LENGTHS(40, 45)],
    leadTimeDays: 7,
    personalisation: {
      label: 'Letters to engrave',
      labelAr: 'الحروف للحفر',
      maxLength: 12,
      required: true,
    },
    facts: [chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'), WARRANTY],
  },
  {
    slug: 'pearl-necklace',
    name: 'Pearl necklace',
    nameAr: 'عقد لؤلؤ',
    category: 'necklaces',
    alsoIn: ['mothers-day', 'engagement'],
    price: 210_000,
    compareAtPrice: 260_000,
    images: ['necklace-pearl.webp'],
    description: 'A single strand of round freshwater pearls with a small silver clasp.',
    descriptionAr: 'خيط واحد من اللؤلؤ المدوّر بقفل فضة صغير.',
    facts: [
      chip('Pearl', 'اللؤلؤ', 'Freshwater', 'مياه عذبة'),
      chip('Length', 'الطول', '45 cm', '45 سم'),
      WARRANTY,
    ],
  },
  {
    slug: 'heart-pendant',
    name: 'Heart pendant',
    nameAr: 'دلاية قلب',
    category: 'necklaces',
    alsoIn: ['gifts', 'mothers-day', 'birthday'],
    price: 78_000,
    images: ['pendant-heart.webp'],
    description:
      'A small smooth heart on a fine silver chain, with a card message if you want to add one.',
    descriptionAr: 'قلب صغير ناعم على سلسلة فضة رفيعة، وتقدر تضيف رسالة على الكارت.',
    options: [LENGTHS(40, 45, 50), WRAP],
    soldOut: [['50 cm', 'No wrap']],
    personalisation: {
      label: 'Card message',
      labelAr: 'رسالة على الكارت',
      maxLength: 80,
      required: false,
    },
    facts: [chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'), WARRANTY],
  },

  // ---------------------------------------------------------------- bracelets
  {
    slug: 'tennis-bracelet',
    name: 'Tennis bracelet',
    nameAr: 'أسورة تنس',
    category: 'bracelets',
    alsoIn: ['engagement', 'graduation'],
    price: 285_000,
    images: ['bracelet-tennis.webp'],
    description:
      'A thin line of small clear stones set in silver. On pre-order: the next batch ships in two weeks.',
    descriptionAr:
      'صف رفيع من الفصوص الصغيرة الشفافة مثبتة في الفضة. بالحجز المسبق: الدفعة الجاية بتوصل بعد أسبوعين.',
    backorder: true,
    stock: 0,
    facts: [
      chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'),
      chip('Length', 'الطول', '18 cm', '18 سم'),
      WARRANTY,
    ],
  },
  {
    slug: 'charm-bracelet',
    name: 'Charm bracelet',
    nameAr: 'أسورة تعليقات',
    category: 'bracelets',
    alsoIn: ['birthday', 'graduation'],
    price: 165_000,
    images: ['bracelet-charm.webp'],
    description: 'A fine chain with three small round charms. Made to order in a few days.',
    descriptionAr: 'سلسلة رفيعة بتلات تعليقات صغيرة دايرة. بتتعمل بالطلب في كام يوم.',
    leadTimeDays: 4,
    facts: [
      chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'),
      chip('Length', 'الطول', '17 cm', '17 سم'),
      WARRANTY,
    ],
  },
  {
    slug: 'beaded-anklet',
    name: 'Beaded anklet',
    nameAr: 'خلخال خرز',
    category: 'bracelets',
    price: 72_000,
    stock: 0,
    images: ['anklet.webp'],
    description: 'A delicate silver anklet with tiny round beads.',
    descriptionAr: 'خلخال فضة رفيع بخرز دايري صغير.',
    facts: [
      chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'),
      chip('Length', 'الطول', '24 cm', '24 سم'),
      WARRANTY,
    ],
  },

  // ---------------------------------------------------------------- earrings
  {
    slug: 'pearl-studs',
    name: 'Pearl stud earrings',
    nameAr: 'حلقان لؤلؤ صغير',
    category: 'earrings',
    alsoIn: ['gifts', 'mothers-day', 'graduation'],
    price: 88_000,
    images: ['earrings-pearl.webp'],
    description: 'Round white pearls on silver posts, in a gift box with a card if you want one.',
    descriptionAr: 'لؤلؤ أبيض مدوّر على دبابيس فضة، في علبة هدية مع كارت لو حابب.',
    options: [WRAP],
    personalisation: {
      label: 'Card message',
      labelAr: 'رسالة على الكارت',
      maxLength: 80,
      required: false,
    },
    facts: [
      chip('Pearl', 'اللؤلؤ', 'Freshwater', 'مياه عذبة'),
      chip('Size', 'القياس', '6 mm', '6 مم'),
      WARRANTY,
    ],
  },
  {
    slug: 'drop-earrings',
    name: 'Slim drop earrings',
    nameAr: 'حلقان نازلة رفيعة',
    category: 'earrings',
    alsoIn: ['engagement'],
    price: 142_000,
    compareAtPrice: 178_000,
    images: ['earrings-drop.webp'],
    description:
      'A small clear stone hanging from a silver hook. Made to order in about three days.',
    descriptionAr: 'فص صغير شفاف متعلّق في خطاف فضة. بتتعمل بالطلب في حوالي تلات أيام.',
    leadTimeDays: 3,
    facts: [
      chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'),
      chip('Drop', 'الطول', '3 cm', '3 سم'),
      WARRANTY,
    ],
  },

  // ---------------------------------------------------------------- sets
  {
    slug: 'bridal-set',
    name: 'Bridal set',
    nameAr: 'طقم عروسة',
    category: 'sets',
    alsoIn: ['engagement'],
    price: 540_000,
    images: ['set-bridal.webp'],
    description:
      'A pearl necklace, two drop earrings and a ring, made together for the day. Allow a week.',
    descriptionAr: 'عقد لؤلؤ وحلقان نازلة وخاتم، بيتعملوا مع بعض ليوم الفرح. اسمح بأسبوع.',
    options: [SIZES(14, 16, 18)],
    leadTimeDays: 7,
    facts: [
      chip('Pieces', 'القطع', '4 pieces', '4 قطع'),
      chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'),
      WARRANTY,
    ],
  },
  {
    slug: 'mini-set',
    name: 'Mini set',
    nameAr: 'طقم صغير',
    category: 'sets',
    alsoIn: ['gifts', 'birthday', 'graduation'],
    price: 155_000,
    images: ['set-mini.webp'],
    description: 'A tiny pendant on a chain and two small studs, in a gift box.',
    descriptionAr: 'دلاية صغيرة على سلسلة وحلقين صغيرين، في علبة هدية.',
    options: [WRAP],
    facts: [
      chip('Pieces', 'القطع', '3 pieces', '3 قطع'),
      chip('Metal', 'المعدن', 'Sterling silver', 'فضة إسترليني'),
      WARRANTY,
    ],
  },

  // ---------------------------------------------------------------- gifts
  {
    slug: 'gift-box',
    name: 'Empty gift box',
    nameAr: 'علبة هدية فاضية',
    category: 'gifts',
    price: 15_000,
    images: ['gift-box.webp'],
    description: 'A small jewellery box with a satin ribbon, to wrap a piece you bought elsewhere.',
    descriptionAr: 'علبة مجوهرات صغيرة بشريطة ساتان، عشان تغلّف قطعة اشتريتها من مكان تاني.',
    facts: [
      chip('Size', 'القياس', '8 x 8 cm', '8 × 8 سم'),
      ROW('Colour', 'اللون', 'Emerald green', 'أخضر زمردي'),
    ],
  },
  {
    slug: 'gift-card',
    name: 'Gift card',
    nameAr: 'كارت هدية',
    category: 'gifts',
    alsoIn: ['birthday', 'graduation', 'engagement'],
    price: 50_000,
    images: ['gift-card.webp'],
    description:
      'A card in an envelope, for the piece they will choose themselves. Pick the amount.',
    descriptionAr: 'كارت في ظرف، للقطعة اللي هما هيختاروها. اختار المبلغ.',
    options: [
      {
        name: 'Amount',
        nameAr: 'المبلغ',
        values: [
          { value: 'EGP 500', valueAr: '500 ج.م' },
          { value: 'EGP 1,000', valueAr: '1000 ج.م', priceAdd: 50_000 },
          { value: 'EGP 2,000', valueAr: '2000 ج.م', priceAdd: 150_000 },
          { value: 'EGP 5,000', valueAr: '5000 ج.م', priceAdd: 450_000 },
        ],
      },
    ],
    facts: [
      chip('Valid for', 'صالح لمدة', 'One year', 'سنة'),
      ROW('Use', 'الاستخدام', 'In store and online', 'في المتجر وأونلاين'),
    ],
  },
];

/** Every photo file the catalogue names (products, categories); the three heroes are listed below. */
export const DAHAB_HERO_FILES = [
  'hero-worn-2k.webp',
  'hero-workshop-2k.webp',
  'hero-giftbox-2k.webp',
];
export const DAHAB_IMAGE_FILES = [
  ...new Set([
    ...DAHAB_PRODUCTS.flatMap(p => p.images),
    ...DAHAB_CATEGORIES.map(c => c.image).filter(Boolean),
    ...DAHAB_HERO_FILES,
  ]),
];
