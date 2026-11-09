// Souq demo catalogue (Phase B2 Task 6): an Egyptian electronics-and-appliances shop, Arabic first,
// prices in piastres (1 EGP = 100). Data only: `scripts/storedemo/seed.mjs --template souq` writes
// it, tests/unit/souq-demo-catalogue.test.ts enforces every feature below by count.
// UNBRANDED on purpose (Ruling B2-10): generic Egyptian-retail names, no brand, no logo, no model
// number. Photos are AI-generated ILLUSTRATIVE samples (scripts/souq-demo/CREDITS.md).
//
// Features present at least once: Colour (hex swatch) x Storage (chip) variants with price steps
// on 4 products, two `onCard` facts on every product plus warranty and condition facts, a
// refurbished and a used-in-excellent-condition product, >= 6 sale prices (one >= 40 % off), a
// backorder, a sold-out variant combination, a product with no photo, a very long Arabic name and
// a very long English name, a made-to-order lead time. Store level (the seed): cash on delivery, a
// 14-day return window, instalments enabled (12 months, no markup, NO provider name; Ruling B2-9).

/** @typedef {{ value: string, valueAr: string, hex?: string, priceAdd?: number }} SouqOptionValue */
/** @typedef {{ name: string, nameAr: string, values: SouqOptionValue[] }} SouqOption */
/**
 * @typedef {{ slug: string, name: string, nameAr: string, category: string,
 *   price: number, compareAtPrice?: number, images: string[], description: string, descriptionAr: string,
 *   options?: SouqOption[], soldOut?: string[][], backorder?: boolean,
 *   facts: { key: string, keyAr: string, value: string, valueAr: string, onCard?: boolean }[],
 *   leadTimeDays?: number, stock?: number }} SouqProduct
 */

export const SOUQ_CATEGORIES = [
  { slug: 'phones', name: 'Phones', nameAr: 'موبايلات', image: 'smartphone.webp' },
  {
    slug: 'laptops',
    name: 'Laptops and tablets',
    nameAr: 'لابتوب وتابلت',
    image: 'student-laptop.webp',
  },
  { slug: 'audio', name: 'Audio', nameAr: 'صوتيات', image: 'headphones.webp' },
  { slug: 'watches', name: 'Watches', nameAr: 'ساعات', image: 'smartwatch.webp' },
  { slug: 'tv', name: 'TVs and screens', nameAr: 'شاشات وتلفزيونات', image: 'tv-55.webp' },
  {
    slug: 'appliances',
    name: 'Home appliances',
    nameAr: 'أجهزة منزلية',
    image: 'washing-machine.webp',
  },
  { slug: 'accessories', name: 'Accessories', nameAr: 'إكسسوارات', image: 'power-bank.webp' },
];

// ---- fact helpers: the two onCard chips are the spec; warranty and condition are table rows (B2-4).
const spec = (key, keyAr, value, valueAr = value) => ({ key, keyAr, value, valueAr, onCard: true });
const WARRANTY = (en = '2 years', ar = 'سنتين') => ({
  key: 'Warranty',
  keyAr: 'الضمان',
  value: en,
  valueAr: ar,
});
const CONDITION = {
  new: { key: 'Condition', keyAr: 'الحالة', value: 'New', valueAr: 'جديد' },
  refurbished: { key: 'Condition', keyAr: 'الحالة', value: 'Refurbished', valueAr: 'مجدّد' },
  used: {
    key: 'Condition',
    keyAr: 'الحالة',
    value: 'Used, excellent condition',
    valueAr: 'مستعمل بحالة ممتازة',
  },
};

const COLOUR = list => ({
  name: 'Colour',
  nameAr: 'اللون',
  values: list.map(([value, valueAr, hex]) => ({ value, valueAr, hex })),
});
const STORAGE = list => ({
  name: 'Storage',
  nameAr: 'السعة',
  // [label, extra price in piastres over the base]
  values: list.map(([value, priceAdd]) => ({ value, valueAr: value, priceAdd })),
});

/** @type {SouqProduct[]} */
export const SOUQ_PRODUCTS = [
  // ---------------------------------------------------------------- phones
  {
    slug: 'smartphone-6-7',
    name: 'Smartphone 6.7 inch',
    nameAr: 'هاتف ذكي 6.7 بوصة',
    category: 'phones',
    price: 3_200_000,
    compareAtPrice: 3_990_000,
    images: ['smartphone.webp'],
    description:
      'A 6.7 inch display, a three-camera system and a battery that lasts the whole day.',
    descriptionAr: 'شاشة 6.7 بوصة، ثلاث كاميرات وبطارية بتكمّل اليوم كله.',
    options: [
      COLOUR([
        ['Black', 'أسود', '#16181D'],
        ['Blue', 'أزرق', '#1F4E9E'],
        ['Silver', 'فضي', '#C3C8CF'],
        ['Green', 'أخضر', '#2F6B57'],
      ]),
      STORAGE([
        ['128GB', 0],
        ['256GB', 400_000],
        ['512GB', 1_000_000],
      ]),
    ],
    soldOut: [['Black', '512GB']],
    facts: [
      spec('Storage', 'السعة', '256GB'),
      spec('RAM', 'الرام', '8GB RAM', '8 جيجا رام'),
      WARRANTY(),
      CONDITION.new,
    ],
  },
  {
    slug: 'budget-phone',
    name: 'Everyday smartphone',
    nameAr: 'هاتف ذكي للاستخدام اليومي',
    category: 'phones',
    price: 1_150_000,
    compareAtPrice: 1_300_000,
    images: ['budget-phone.webp'],
    description: 'A dependable phone for calls, messages and the camera, at a friendly price.',
    descriptionAr: 'موبايل تعتمد عليه للمكالمات والرسايل والكاميرا، بسعر مناسب.',
    options: [
      COLOUR([
        ['Black', 'أسود', '#16181D'],
        ['Blue', 'أزرق', '#2B63C9'],
      ]),
      STORAGE([
        ['64GB', 0],
        ['128GB', 150_000],
      ]),
    ],
    facts: [
      spec('Storage', 'السعة', '128GB'),
      spec('RAM', 'الرام', '4GB RAM', '4 جيجا رام'),
      WARRANTY('1 year', 'سنة'),
      CONDITION.new,
    ],
  },
  {
    slug: 'refurbished-phone',
    name: 'Refurbished smartphone',
    nameAr: 'هاتف ذكي مجدّد',
    category: 'phones',
    price: 1_850_000,
    images: ['refurbished-phone.webp'],
    description: 'Tested, cleaned and fitted with a new battery. Sold with a store warranty.',
    descriptionAr: 'متفحّص ومتنضّف وببطارية جديدة. بيتباع بضمان من المتجر.',
    facts: [
      spec('Storage', 'السعة', '128GB'),
      spec('RAM', 'الرام', '6GB RAM', '6 جيجا رام'),
      WARRANTY('6 months', '6 شهور'),
      CONDITION.refurbished,
    ],
  },
  {
    slug: 'used-phone-excellent',
    name: 'Used smartphone',
    nameAr: 'هاتف ذكي مستعمل',
    category: 'phones',
    price: 1_450_000,
    images: ['used-phone.webp'],
    description: 'Lightly used, no scratches on the screen, original charger in the box.',
    descriptionAr: 'استخدام خفيف، من غير خدوش على الشاشة، والشاحن الأصلي معاه.',
    facts: [
      spec('Storage', 'السعة', '256GB'),
      spec('RAM', 'الرام', '8GB RAM', '8 جيجا رام'),
      WARRANTY('3 months', '3 شهور'),
      CONDITION.used,
    ],
  },
  // ---------------------------------------------------------------- laptops and tablets
  {
    slug: 'student-laptop-15-6',
    name: 'Study laptop 15.6 inch',
    nameAr: 'لاب توب 15.6 بوصة للدراسة',
    category: 'laptops',
    price: 2_400_000,
    images: ['student-laptop.webp'],
    description:
      'Light enough for the bag, with a keyboard that is comfortable for long assignments.',
    descriptionAr: 'خفيف على الشنطة، وكيبورد مريح للواجبات الطويلة.',
    options: [
      COLOUR([
        ['Grey', 'رمادي', '#6B7078'],
        ['Silver', 'فضي', '#C3C8CF'],
      ]),
      STORAGE([
        ['256GB', 0],
        ['512GB', 300_000],
      ]),
    ],
    facts: [
      spec('Storage', 'السعة', '512GB'),
      spec('RAM', 'الرام', '16GB RAM', '16 جيجا رام'),
      WARRANTY(),
      CONDITION.new,
    ],
  },
  {
    slug: 'ultrabook-14',
    name: 'Ultrabook 14 inch',
    nameAr: 'لاب توب رفيع 14 بوصة',
    category: 'laptops',
    price: 3_650_000,
    compareAtPrice: 4_300_000,
    images: ['ultrabook.webp'],
    description: 'Thin, quiet and fast for work, with a battery for a full day away from the desk.',
    descriptionAr: 'رفيع وهادي وسريع للشغل، وبطارية تكفي يوم كامل بعيد عن المكتب.',
    facts: [
      spec('Storage', 'السعة', '512GB'),
      spec('RAM', 'الرام', '16GB RAM', '16 جيجا رام'),
      WARRANTY(),
      CONDITION.new,
    ],
  },
  {
    slug: 'tablet-10',
    name: 'Tablet 10 inch',
    nameAr: 'تابلت 10 بوصة',
    category: 'laptops',
    price: 1_400_000,
    images: ['tablet.webp'],
    description:
      'A bright 10 inch screen for reading, video calls and study, with a protective case.',
    descriptionAr: 'شاشة 10 بوصة واضحة للقراءة ومكالمات الفيديو والمذاكرة، ومعاها جراب حماية.',
    options: [
      COLOUR([
        ['Grey', 'رمادي', '#59606B'],
        ['Blue', 'أزرق', '#2B4F8F'],
      ]),
      STORAGE([
        ['64GB', 0],
        ['128GB', 200_000],
      ]),
    ],
    facts: [
      spec('Storage', 'السعة', '128GB'),
      spec('Screen', 'الشاشة', '10 inch', '10 بوصة'),
      WARRANTY(),
      CONDITION.new,
    ],
  },
  // ---------------------------------------------------------------- audio
  {
    slug: 'noise-cancelling-headphones',
    name: 'Wireless noise-cancelling headphones',
    nameAr: 'سماعة لاسلكية بعزل ضوضاء',
    category: 'audio',
    price: 520_000,
    compareAtPrice: 690_000,
    images: ['headphones.webp'],
    description: 'Over-ear comfort, active noise cancelling and thirty hours on a charge.',
    descriptionAr: 'راحة على الودن، عزل ضوضاء نشط وتلاتين ساعة على الشحنة.',
    facts: [
      spec('Battery', 'البطارية', '30 hours', '30 ساعة'),
      spec('Connection', 'الاتصال', 'Bluetooth 5.3'),
      WARRANTY('1 year', 'سنة'),
      CONDITION.new,
    ],
  },
  {
    slug: 'true-wireless-earbuds',
    name: 'True wireless earbuds',
    nameAr: 'سماعات أذن لاسلكية',
    category: 'audio',
    price: 180_000,
    images: ['earbuds.webp'],
    description: 'Small, light and a charging case that fits in a pocket.',
    descriptionAr: 'صغيرة وخفيفة، وعلبة الشحن بتدخل الجيب.',
    facts: [
      spec('Battery', 'البطارية', '24 hours', '24 ساعة'),
      spec('Connection', 'الاتصال', 'Bluetooth 5.3'),
      WARRANTY('1 year', 'سنة'),
      CONDITION.new,
    ],
  },
  {
    slug: 'portable-speaker',
    name: 'Portable bluetooth speaker',
    nameAr: 'سبيكر بلوتوث متنقل',
    category: 'audio',
    price: 240_000,
    images: ['speaker.webp'],
    backorder: true,
    stock: 0,
    description:
      'Clear sound for the balcony or the trip. Out of stock: order now and we ship when it lands.',
    descriptionAr: 'صوت واضح للبلكونة أو الرحلة. خلصان دلوقتي: اطلبه وهنشحنه أول ما يوصل.',
    facts: [
      spec('Battery', 'البطارية', '12 hours', '12 ساعة'),
      spec('Water', 'الماء', 'Splash proof', 'مقاوم للرذاذ'),
      WARRANTY('1 year', 'سنة'),
      CONDITION.new,
    ],
  },
  // ---------------------------------------------------------------- watches
  {
    slug: 'smart-watch',
    name: 'Smart watch',
    nameAr: 'ساعة ذكية',
    category: 'watches',
    price: 420_000,
    compareAtPrice: 510_000,
    images: ['smartwatch.webp'],
    description: 'Calls, messages and activity tracking on your wrist.',
    descriptionAr: 'مكالمات ورسايل وتتبّع نشاط على إيدك.',
    facts: [
      spec('Battery', 'البطارية', '5 days', '5 أيام'),
      spec('Screen', 'الشاشة', '1.4 inch', '1.4 بوصة'),
      WARRANTY('1 year', 'سنة'),
      CONDITION.new,
    ],
  },
  {
    slug: 'fitness-band',
    name: 'Fitness band',
    nameAr: 'سوار لياقة',
    category: 'watches',
    price: 95_000,
    images: ['fitness-band.webp'],
    description: 'Steps, sleep and heart rate, light enough to forget you are wearing it.',
    descriptionAr: 'خطوات ونوم ونبض القلب، وخفيف لدرجة إنك مش حاسس بيه.',
    facts: [
      spec('Battery', 'البطارية', '14 days', '14 يوم'),
      spec('Water', 'الماء', 'Water resistant', 'مقاوم للماء'),
      WARRANTY('1 year', 'سنة'),
      CONDITION.new,
    ],
  },
  // ---------------------------------------------------------------- tvs and screens
  {
    slug: 'tv-55-4k',
    name: 'Smart TV 55 inch 4K',
    nameAr: 'شاشة سمارت 55 بوصة 4K',
    category: 'tv',
    price: 1_650_000,
    compareAtPrice: 3_000_000,
    images: ['tv-55.webp'],
    description: 'A 4K screen with the streaming apps built in and a voice remote.',
    descriptionAr: 'شاشة 4K فيها تطبيقات المشاهدة جاهزة وريموت صوتي.',
    facts: [
      spec('Screen', 'الشاشة', '55 inch', '55 بوصة'),
      spec('Resolution', 'الدقة', '4K'),
      WARRANTY(),
      CONDITION.new,
    ],
  },
  {
    slug: 'tv-43-full-hd',
    name: 'Smart TV 43 inch Full HD',
    nameAr: 'شاشة سمارت 43 بوصة Full HD',
    category: 'tv',
    price: 920_000,
    images: ['tv-43.webp'],
    description: 'A compact Full HD screen for the bedroom or the kitchen.',
    descriptionAr: 'شاشة Full HD صغيرة تنفع للأوضة أو المطبخ.',
    facts: [
      spec('Screen', 'الشاشة', '43 inch', '43 بوصة'),
      spec('Resolution', 'الدقة', 'Full HD'),
      WARRANTY(),
      CONDITION.new,
    ],
  },
  {
    slug: 'monitor-27',
    name: 'Monitor 27 inch (made to order)',
    nameAr: 'شاشة كمبيوتر 27 بوصة (بتتجهز بالطلب)',
    category: 'tv',
    price: 680_000,
    images: ['monitor.webp'],
    leadTimeDays: 7,
    description: 'A sharp 27 inch monitor for work. Prepared when you order.',
    descriptionAr: 'شاشة 27 بوصة واضحة للشغل. بتتجهز لما تطلبها.',
    facts: [
      spec('Screen', 'الشاشة', '27 inch', '27 بوصة'),
      spec('Refresh', 'التردد', '75Hz'),
      WARRANTY(),
      CONDITION.new,
    ],
  },
  // ---------------------------------------------------------------- appliances
  {
    slug: 'washing-machine-9kg',
    name: 'Automatic washing machine 9 kg',
    nameAr:
      'غسالة أوتوماتيك 9 كجم فتحة أمامية بموتور إنفرتر هادئ وتوفير في استهلاك المياه والكهرباء مع ضمان سنتين',
    category: 'appliances',
    price: 1_480_000,
    images: ['washing-machine.webp'],
    description: 'Front-loading, quiet inverter motor and programmes for every fabric.',
    descriptionAr: 'فتحة أمامية، موتور إنفرتر هادي وبرامج لكل أنواع القماش.',
    facts: [
      spec('Capacity', 'السعة', '9 kg', '9 كجم'),
      spec('Spin', 'العصر', '1200 rpm', '1200 لفة'),
      WARRANTY(),
      CONDITION.new,
    ],
  },
  {
    slug: 'air-fryer-5l',
    name: 'Digital air fryer 5 L',
    nameAr: 'قلاية هوائية ديجيتال 5 لتر',
    category: 'appliances',
    price: 245_000,
    compareAtPrice: 350_000,
    images: ['air-fryer.webp'],
    description: 'Crisp food with a spoon of oil, and a basket that goes in the dishwasher.',
    descriptionAr: 'أكل مقرمش بمعلقة زيت، والسلة بتتغسل في غسالة الأطباق.',
    facts: [
      spec('Capacity', 'السعة', '5 L', '5 لتر'),
      spec('Power', 'القدرة', '1700W'),
      WARRANTY('1 year', 'سنة'),
      CONDITION.new,
    ],
  },
  {
    slug: 'electric-kettle',
    name: 'Stainless steel electric kettle 1.7 litre with automatic shut-off, boil-dry protection, cordless 360 degree base and a water level window',
    nameAr: 'غلاية كهرباء ستانلس 1.7 لتر',
    category: 'appliances',
    price: 145_000,
    images: ['kettle.webp'],
    description: 'Boils a full jug in minutes and switches itself off.',
    descriptionAr: 'بتغلي إبريق كامل في دقايق وبتفصل لوحدها.',
    facts: [
      spec('Capacity', 'السعة', '1.7 L', '1.7 لتر'),
      spec('Power', 'القدرة', '2200W'),
      WARRANTY('1 year', 'سنة'),
      CONDITION.new,
    ],
  },
  // ---------------------------------------------------------------- accessories
  {
    slug: 'power-bank-20000',
    name: 'Power bank 20,000 mAh',
    nameAr: 'باور بانك 20 ألف',
    category: 'accessories',
    price: 130_000,
    compareAtPrice: 145_000,
    images: ['power-bank.webp'],
    description: 'Charges a phone four times, with fast charging both ways.',
    descriptionAr: 'بيشحن الموبايل 4 مرات، بشحن سريع في الاتجاهين.',
    facts: [
      spec('Capacity', 'السعة', '20,000 mAh', '20 ألف mAh'),
      spec('Charging', 'الشحن', '22.5W fast', '22.5W سريع'),
      WARRANTY('1 year', 'سنة'),
      CONDITION.new,
    ],
  },
];

/** Every image file the catalogue and the home document name (the assets test checks each exists). */
export const SOUQ_IMAGE_FILES = [
  ...new Set([
    ...SOUQ_PRODUCTS.flatMap(p => p.images),
    ...SOUQ_CATEGORIES.map(c => c.image).filter(Boolean),
    'hero-night-2k.webp',
    'hero-showroom-2k.webp',
  ]),
];
