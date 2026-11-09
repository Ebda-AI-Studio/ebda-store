// Jasmine demo catalogue (Phase B3 Task 5): an Egyptian beauty-and-skincare shop, Arabic first,
// prices in piastres (1 EGP = 100). Data only: `scripts/storedemo/seed.mjs --template jasmine`
// writes it, tests/unit/jasmine-demo-catalogue.test.ts enforces every feature below by count.
// UNBRANDED on purpose (Ruling B3-9): generic Egyptian beauty-retail names, no brand, no logo, no
// model name. Photos are AI-generated ILLUSTRATIVE samples with blank packaging
// (scripts/jasmine-demo/CREDITS.md); none shows a face or skin (Ruling B3-3).
//
// Features present at least once: skin-type and concern TAGS on 12 products (every chip leads to a
// non-empty PLP), B0 product facts per Ruling B3-4 (two `onCard` facts - the key ingredient or
// active, and the size - plus ingredients, how to use, skin type and time after opening as table
// rows), Shade (hex swatch, all outside the no-orange hue band) x Size (chip, price steps) variants
// on 2 makeup products and a shade-only product, a Size variant on a perfume, >= 6 sale prices (two
// >= 40 % off), a backorder, a sold-out variant combination, a product with no photo, a very long
// Arabic name and a very long English name, a made-to-order lead time, a real 3-step routine bundle
// with a saving, and approved reviews on 6 products. Store level (the seed): cash on delivery, a
// 14-day return window, instalments enabled (no provider name), the `bundles` feature.

/** @typedef {{ value: string, valueAr: string, hex?: string, priceAdd?: number }} JasmineOptionValue */
/** @typedef {{ name: string, nameAr: string, values: JasmineOptionValue[] }} JasmineOption */
/**
 * @typedef {{ slug: string, name: string, nameAr: string, category: string, tags: string[],
 *   price: number, compareAtPrice?: number, images: string[], description: string, descriptionAr: string,
 *   options?: JasmineOption[], soldOut?: string[][], backorder?: boolean,
 *   facts: { key: string, keyAr: string, value: string, valueAr: string, onCard?: boolean }[],
 *   leadTimeDays?: number, stock?: number }} JasmineProduct
 */

export const JASMINE_CATEGORIES = [
  { slug: 'cleansers', name: 'Cleansers', nameAr: 'تنظيف البشرة', image: 'gentle-cleanser.webp' },
  {
    slug: 'serums',
    name: 'Serums and treatments',
    nameAr: 'سيرومات وعلاجات',
    image: 'niacinamide-serum.webp',
  },
  {
    slug: 'moisturisers-sun',
    name: 'Moisturisers and sunscreen',
    nameAr: 'مرطبات وواقي الشمس',
    image: 'sunscreen.webp',
  },
  { slug: 'makeup', name: 'Makeup', nameAr: 'مكياج', image: 'matte-lipstick.webp' },
  { slug: 'perfumes', name: 'Perfumes', nameAr: 'عطور', image: 'oud-rose-perfume.webp' },
  { slug: 'hair-care', name: 'Hair care', nameAr: 'العناية بالشعر', image: 'argan-hair-oil.webp' },
  {
    slug: 'tools-devices',
    name: 'Devices and tools',
    nameAr: 'أجهزة ومستلزمات',
    image: 'sonic-face-brush.webp',
  },
];

/** The skin-type and concern tags (Ruling B3-5): each one is a chip on the home page. `name` is the
 * English label and the filter key, `nameAr` the Arabic label (Ruling B3-13). */
export const JASMINE_TAGS = [
  { name: 'Oily skin', nameAr: 'بشرة دهنية' },
  { name: 'Dry skin', nameAr: 'بشرة جافة' },
  { name: 'Sensitive skin', nameAr: 'بشرة حساسة' },
  { name: 'Acne', nameAr: 'حب الشباب' },
  { name: 'Dark spots', nameAr: 'تصبغات' },
  { name: 'Dryness', nameAr: 'جفاف' },
];

// ---- fact helpers (Ruling B3-4): the two onCard chips are the key ingredient / active and the
// size; ingredients, how to use, skin type and time after opening are table rows.
const chip = (key, keyAr, value, valueAr = value) => ({ key, keyAr, value, valueAr, onCard: true });
const ACTIVE = (en, ar = en) => chip('Active', 'المادة الفعّالة', en, ar);
const INGREDIENT = (en, ar) => chip('Key ingredient', 'المكوّن الأساسي', en, ar);
const SIZE = (en, ar = en) => chip('Size', 'الحجم', en, ar);
const ROW = (key, keyAr, value, valueAr) => ({ key, keyAr, value, valueAr });
const SKIN = (en, ar) => ROW('Skin type', 'نوع البشرة', en, ar);
const HOW = (en, ar) => ROW('How to use', 'طريقة الاستخدام', en, ar);
const PAO = (months = 12) =>
  ROW(
    'After opening',
    'صلاحية بعد الفتح',
    `${months} months`,
    months === 12 ? '12 شهر' : `${months} شهر`
  );
const INGREDIENTS = (en, ar) => ROW('Ingredients', 'المكوّنات', en, ar);

const SHADE = list => ({
  name: 'Shade',
  nameAr: 'الدرجة',
  values: list.map(([value, valueAr, hex]) => ({ value, valueAr, hex })),
});
const SIZE_OPT = list => ({
  name: 'Size',
  nameAr: 'الحجم',
  // [label, labelAr, extra price in piastres over the base]
  values: list.map(([value, valueAr, priceAdd]) => ({ value, valueAr, priceAdd })),
});

// Shade hexes: roses, berries, mauves and plums, and a dusty nude at hue 0. NONE is a coral,
// terracotta or peach: the catalogue test runs every one through the same hue gate as the tokens.
const ROSE = ['Rose', 'وردي', '#D4607F'];
const BERRY = ['Berry', 'توتي', '#8E2A4F'];
const MAUVE = ['Mauve', 'موف', '#9C6B8E'];
const PLUM = ['Plum', 'برقوقي', '#5A2A46'];
const NUDE = ['Dusty nude', 'نيود هادي', '#C9A0A0'];

/** @type {JasmineProduct[]} */
export const JASMINE_PRODUCTS = [
  // ---------------------------------------------------------------- cleansers
  {
    slug: 'gentle-cleanser-oily',
    name: 'Gentle cleanser for oily skin 200 ml',
    nameAr: 'غسول لطيف للبشرة الدهنية 200 مل',
    category: 'cleansers',
    tags: ['Oily skin', 'Acne'],
    price: 18_500,
    images: ['gentle-cleanser.webp'],
    description: 'A light gel that lifts oil and sunscreen without leaving the skin tight.',
    descriptionAr: 'جل خفيف بيشيل الدهون وواقي الشمس من غير ما يسيب الجلد مشدود.',
    facts: [
      ACTIVE('Salicylic acid 0.5%', 'حمض الساليسيليك 0.5%'),
      SIZE('200 ml', '200 مل'),
      SKIN('Oily and blemish-prone', 'دهنية ومعرّضة للحبوب'),
      INGREDIENTS('Water, glycerin, salicylic acid, zinc PCA', 'ماء، جلسرين، حمض الساليسيليك، زنك'),
      HOW(
        'Massage onto damp skin morning and night, rinse.',
        'دلّكه على بشرة مبلولة صباحًا ومساءً واشطف.'
      ),
      PAO(),
    ],
  },
  {
    slug: 'creamy-cleanser-dry',
    name: 'Creamy cleanser for dry skin 150 ml',
    nameAr: 'غسول كريمي للبشرة الجافة 150 مل',
    category: 'cleansers',
    tags: ['Dry skin', 'Dryness'],
    price: 17_500,
    images: ['creamy-cleanser.webp'],
    description: 'A soft cream that cleans gently and leaves a comfortable, cushioned feel.',
    descriptionAr: 'كريم ناعم بينضّف بهدوء وبيسيب إحساس مريح على البشرة.',
    facts: [
      ACTIVE('Ceramides and glycerin', 'سيراميد وجلسرين'),
      SIZE('150 ml', '150 مل'),
      SKIN('Dry and tight', 'جافة ومشدودة'),
      INGREDIENTS('Water, ceramide NP, glycerin, shea butter', 'ماء، سيراميد، جلسرين، زبدة الشيا'),
      HOW(
        'Warm a small amount in your palms, massage, rinse.',
        'دفّي كمية صغيرة في إيدك ودلّك واشطف.'
      ),
      PAO(),
    ],
  },
  {
    slug: 'micellar-water',
    name: 'Micellar water for sensitive skin 400 ml',
    nameAr: 'ميسيلار ووتر للبشرة الحساسة 400 مل',
    category: 'cleansers',
    tags: ['Sensitive skin'],
    price: 14_500,
    compareAtPrice: 18_000,
    images: ['micellar-water.webp'],
    description: 'Removes makeup in one pass with no scent and nothing to rinse.',
    descriptionAr: 'بيشيل المكياج في مسحة واحدة، من غير ريحة ومن غير شطف.',
    facts: [
      INGREDIENT('Micellar solution', 'محلول ميسيلار'),
      SIZE('400 ml', '400 مل'),
      SKIN('Sensitive', 'حساسة'),
      INGREDIENTS('Water, glycerin, poloxamer 184', 'ماء، جلسرين، بولوكسامر'),
      HOW('Soak a cotton pad and wipe the face and eyes.', 'بلّل قطنة وامسح بيها الوش والعينين.'),
      PAO(6),
    ],
  },
  // ---------------------------------------------------------------- serums and treatments
  {
    slug: 'niacinamide-serum',
    name: 'Niacinamide 10% serum 30 ml',
    nameAr: 'سيروم نياسيناميد 10% 30 مل',
    category: 'serums',
    tags: ['Oily skin', 'Acne', 'Dark spots'],
    price: 32_000,
    images: ['niacinamide-serum.webp'],
    description: 'Calms the look of pores and oil and evens a blotchy tone over weeks.',
    descriptionAr: 'بيهدّي شكل المسام والدهون وبيوحّد لون البشرة مع الاستمرار.',
    facts: [
      ACTIVE('Niacinamide 10%', 'نياسيناميد 10%'),
      SIZE('30 ml', '30 مل'),
      SKIN('Oily, combination, uneven tone', 'دهنية ومختلطة ولونها مش موحّد'),
      INGREDIENTS('Water, niacinamide, zinc PCA, panthenol', 'ماء، نياسيناميد، زنك، بانثينول'),
      HOW(
        'Two drops on clean skin before moisturiser, morning or night.',
        'نقطتين على بشرة نضيفة قبل المرطب، صباحًا أو مساءً.'
      ),
      PAO(),
    ],
  },
  {
    slug: 'vitamin-c-serum',
    name: 'Vitamin C 15% serum 30 ml',
    nameAr: 'سيروم فيتامين سي 15% 30 مل',
    category: 'serums',
    tags: ['Dark spots'],
    price: 38_000,
    compareAtPrice: 52_000,
    images: ['vitamin-c-serum.webp'],
    description: 'A brightening serum for dull skin and dark marks, best in the morning.',
    descriptionAr: 'سيروم بيفتّح البشرة الباهتة والآثار الغامقة، والأفضل صباحًا.',
    facts: [
      ACTIVE('Vitamin C 15%', 'فيتامين سي 15%'),
      SIZE('30 ml', '30 مل'),
      SKIN('Dull or marked skin', 'باهتة أو عليها آثار'),
      INGREDIENTS(
        'Water, ascorbic acid, ferulic acid, vitamin E',
        'ماء، فيتامين سي، حمض الفيروليك، فيتامين إي'
      ),
      HOW('Apply in the morning under sunscreen.', 'حطه الصبح تحت واقي الشمس.'),
      PAO(3),
    ],
  },
  {
    slug: 'hyaluronic-serum',
    name: 'Hyaluronic acid 2% serum 30 ml',
    nameAr: 'سيروم هيالورونيك 2% 30 مل',
    category: 'serums',
    tags: ['Dry skin', 'Dryness'],
    price: 29_000,
    images: ['hyaluronic-serum.webp'],
    description: 'Deep, light hydration that plumps dry skin without any stickiness.',
    descriptionAr: 'ترطيب عميق وخفيف بيملّي البشرة الجافة من غير لزوجة.',
    facts: [
      ACTIVE('Hyaluronic acid 2%', 'هيالورونيك 2%'),
      SIZE('30 ml', '30 مل'),
      SKIN('Dry and dehydrated', 'جافة ومجفّفة'),
      INGREDIENTS(
        'Water, sodium hyaluronate, glycerin, panthenol',
        'ماء، هيالورونيك، جلسرين، بانثينول'
      ),
      HOW(
        'Press onto damp skin, then seal with a moisturiser.',
        'اضغط على بشرة مبلولة وبعدها استخدم المرطب.'
      ),
      PAO(),
    ],
  },
  {
    slug: 'retinol-night-cream',
    name: 'Retinol 0.3% night cream 30 ml',
    nameAr: 'كريم ريتينول ليلي 0.3% 30 مل',
    category: 'serums',
    tags: ['Dark spots', 'Acne'],
    price: 40_000,
    compareAtPrice: 68_000,
    images: ['retinol-night-cream.webp'],
    description: 'A gentle starter retinol for fine lines and clogged pores, used at night.',
    descriptionAr: 'ريتينول لطيف للمبتدئين للخطوط الدقيقة والمسام المسدودة، بالليل.',
    facts: [
      ACTIVE('Retinol 0.3%', 'ريتينول 0.3%'),
      SIZE('30 ml', '30 مل'),
      SKIN('Normal to oily, not for pregnancy', 'عادية لدهنية، مش للحمل'),
      INGREDIENTS('Water, retinol, squalane, bisabolol', 'ماء، ريتينول، سكوالين، بيسابولول'),
      HOW(
        'Two nights a week at first, then build up. Always use sunscreen next day.',
        'ليلتين في الأسبوع في الأول وبعدين زوّد. واقي الشمس ضروري تاني يوم.'
      ),
      PAO(6),
    ],
  },
  {
    slug: 'acne-spot-patches',
    name: 'Blemish spot patches, 36 pieces',
    nameAr: 'لصقات حب الشباب 36 قطعة',
    category: 'serums',
    tags: ['Acne', 'Oily skin'],
    price: 9_500,
    images: ['spot-patches.webp'],
    backorder: true,
    stock: 0,
    description:
      'Clear patches that flatten a spot overnight. Out of stock: order now and we ship when it lands.',
    descriptionAr: 'لصقات شفافة بتسطّح الحبة بالليل. خلصانة دلوقتي: اطلبها وهنشحنها أول ما توصل.',
    facts: [
      ACTIVE('Hydrocolloid', 'هيدروكولويد'),
      SIZE('36 pieces', '36 قطعة'),
      SKIN('Blemish-prone', 'معرّضة للحبوب'),
      HOW('Place on a clean dry spot overnight.', 'حطها على حبة نضيفة وناشفة طول الليل.'),
      PAO(24),
    ],
  },
  // ---------------------------------------------------------------- moisturisers and sunscreen
  {
    slug: 'ceramide-moisturiser',
    name: 'Ceramide moisturiser 50 ml',
    nameAr: 'كريم مرطب بالسيراميد 50 مل',
    category: 'moisturisers-sun',
    tags: ['Dry skin', 'Dryness', 'Sensitive skin'],
    price: 27_500,
    images: ['ceramide-moisturiser.webp'],
    description: 'A rich cream that rebuilds the skin barrier and stays comfortable all day.',
    descriptionAr: 'كريم غني بيقوّي حاجز البشرة وبيفضل مريح طول اليوم.',
    facts: [
      INGREDIENT('Three ceramides', 'تلات أنواع سيراميد'),
      SIZE('50 ml', '50 مل'),
      SKIN('Dry and sensitive', 'جافة وحساسة'),
      INGREDIENTS(
        'Water, ceramide NP/AP/EOP, cholesterol, squalane',
        'ماء، سيراميد، كوليسترول، سكوالين'
      ),
      HOW('Smooth over the face and neck after serum.', 'وزّعه على الوش والرقبة بعد السيروم.'),
      PAO(),
    ],
  },
  {
    slug: 'oil-free-gel-moisturiser',
    name: 'Oil-free gel moisturiser for oily and combination skin that absorbs in seconds, with no shine, no residue and no heavy feel under makeup or sunscreen',
    nameAr: 'جل مرطب خفيف للبشرة الدهنية 50 مل',
    category: 'moisturisers-sun',
    tags: ['Oily skin'],
    price: 24_000,
    compareAtPrice: 30_000,
    images: ['gel-moisturiser.webp'],
    description: 'A water-light gel for skin that shines by noon.',
    descriptionAr: 'جل زي الماية للبشرة اللي بتلمّع قبل الضهر.',
    facts: [
      INGREDIENT('Aloe and green tea', 'صبّار وشاي أخضر'),
      SIZE('50 ml', '50 مل'),
      SKIN('Oily and combination', 'دهنية ومختلطة'),
      INGREDIENTS('Water, aloe, green tea extract, glycerin', 'ماء، صبّار، شاي أخضر، جلسرين'),
      HOW('A pea-sized amount morning and night.', 'كمية بحجم حبة البسلة صباحًا ومساءً.'),
      PAO(),
    ],
  },
  {
    slug: 'sunscreen-spf50',
    name: 'Light sunscreen SPF 50, 50 ml',
    nameAr: 'واقي شمس SPF 50 خفيف 50 مل',
    category: 'moisturisers-sun',
    tags: ['Oily skin', 'Dark spots', 'Sensitive skin'],
    price: 26_000,
    images: ['sunscreen.webp'],
    description: 'A weightless daily fluid with no white cast, made for hot Egyptian summers.',
    descriptionAr: 'سائل خفيف للاستخدام اليومي من غير طبقة بيضا، مناسب لصيف مصر.',
    facts: [
      ACTIVE('SPF 50 PA++++', 'SPF 50 PA++++'),
      SIZE('50 ml', '50 مل'),
      SKIN('All skin types', 'كل أنواع البشرة'),
      INGREDIENTS(
        'Water, zinc oxide, niacinamide, vitamin E',
        'ماء، أكسيد الزنك، نياسيناميد، فيتامين إي'
      ),
      HOW(
        'Two finger-lengths as the last morning step, reapply every two hours outside.',
        'قد صباعين كآخر خطوة الصبح، وجدّده كل ساعتين برّه.'
      ),
      PAO(),
    ],
  },
  {
    slug: 'lip-balm',
    name: 'Nourishing lip balm 10 g',
    nameAr: 'مرطب شفايف مغذّي 10 جم',
    category: 'moisturisers-sun',
    tags: ['Dryness'],
    price: 6_500,
    compareAtPrice: 8_500,
    images: ['lip-balm.webp'],
    description: 'Softens dry lips and sits well under lipstick.',
    descriptionAr: 'بيطرّي الشفايف الجافة ومناسب تحت أحمر الشفايف.',
    facts: [
      INGREDIENT('Shea butter', 'زبدة الشيا'),
      SIZE('10 g', '10 جم'),
      SKIN('Dry lips', 'شفايف جافة'),
      HOW('Apply whenever lips feel dry.', 'حطه كل ما الشفايف تحس بجفاف.'),
      PAO(),
    ],
  },
  // ---------------------------------------------------------------- makeup
  {
    slug: 'matte-lipstick',
    name: 'Matte lipstick',
    nameAr: 'أحمر شفاه مطفي',
    category: 'makeup',
    tags: [],
    price: 12_000,
    images: ['matte-lipstick.webp'],
    description: 'A soft matte colour with an even finish that does not feel dry.',
    descriptionAr: 'لون مطفي ناعم بتشطيب متساوي ومش بيجفف الشفايف.',
    options: [
      SHADE([ROSE, BERRY, MAUVE, PLUM, NUDE]),
      SIZE_OPT([
        ['Mini 2 g', 'ميني 2 جم', 0],
        ['Full 3.5 g', 'كامل 3.5 جم', 6_000],
      ]),
    ],
    soldOut: [['Plum', 'Mini 2 g']],
    facts: [
      chip('Finish', 'التشطيب', 'Matte', 'مطفي'),
      SIZE('2 g or 3.5 g', '2 أو 3.5 جم'),
      INGREDIENTS('Castor oil, candelilla wax, vitamin E', 'زيت الخروع، شمع كانديليلا، فيتامين إي'),
      HOW('Apply from the centre of the lips outwards.', 'ابدأ من نص الشفايف ناحية الأطراف.'),
      PAO(24),
    ],
  },
  {
    slug: 'cream-blush',
    name: 'Cream blush',
    nameAr: 'بلاشر كريمي',
    category: 'makeup',
    tags: [],
    price: 15_000,
    compareAtPrice: 19_000,
    images: ['cream-blush.webp'],
    description: 'A blendable cream colour that melts into the skin for a natural flush.',
    descriptionAr: 'لون كريمي سهل التوزيع بيدوب في البشرة ويدّي احمرار طبيعي.',
    options: [
      SHADE([ROSE, BERRY, MAUVE, NUDE]),
      SIZE_OPT([
        ['Mini 4 g', 'ميني 4 جم', 0],
        ['Full 8 g', 'كامل 8 جم', 7_000],
      ]),
    ],
    facts: [
      chip('Finish', 'التشطيب', 'Dewy', 'لامع ناعم'),
      SIZE('4 g or 8 g', '4 أو 8 جم'),
      INGREDIENTS('Squalane, jojoba oil, mica', 'سكوالين، زيت جوجوبا، ميكا'),
      HOW('Tap onto the cheeks with fingertips and blend.', 'اضغط بأطراف صوابعك على الخدود ووزّع.'),
      PAO(18),
    ],
  },
  {
    slug: 'tinted-lip-oil',
    name: 'Tinted lip oil',
    nameAr: 'تنت شفايف زيتي',
    category: 'makeup',
    tags: [],
    price: 9_500,
    compareAtPrice: 16_500,
    images: ['lip-oil.webp'],
    description: 'A glossy, nourishing tint with a hint of colour.',
    descriptionAr: 'تنت لامع ومغذّي بلمسة لون خفيفة.',
    options: [SHADE([ROSE, BERRY, MAUVE])],
    facts: [
      chip('Finish', 'التشطيب', 'Glossy', 'لامع'),
      SIZE('6 ml', '6 مل'),
      INGREDIENTS('Jojoba oil, vitamin E, castor oil', 'زيت جوجوبا، فيتامين إي، زيت الخروع'),
      HOW('Swipe over bare lips or over lipstick.', 'مرره على شفايف عارية أو فوق أحمر الشفايف.'),
      PAO(12),
    ],
  },
  {
    slug: 'volume-mascara',
    name: 'Volume mascara',
    nameAr: 'ماسكارا كثافة',
    category: 'makeup',
    tags: [],
    price: 13_500,
    images: ['mascara.webp'],
    description: 'Builds full, separated lashes with no clumps.',
    descriptionAr: 'بتكثّف الرموش وتفصلها من غير تكتّل.',
    facts: [
      chip('Finish', 'التشطيب', 'Black, volume', 'أسود كثيف'),
      SIZE('9 ml', '9 مل'),
      HOW('Wiggle the brush from the root up.', 'حرّك الفرشة من الجذور لفوق.'),
      PAO(4),
    ],
  },
  // ---------------------------------------------------------------- perfumes
  {
    slug: 'oud-rose-perfume',
    name: 'Oud and rose perfume',
    nameAr: 'عطر عود وورد',
    category: 'perfumes',
    tags: [],
    price: 85_000,
    images: ['oud-rose-perfume.webp'],
    leadTimeDays: 3,
    description: 'A warm oud with a soft rose heart. Filled to order in three days.',
    descriptionAr: 'عود دافي بقلب ورد ناعم. بيتعبّأ حسب الطلب خلال تلات أيام.',
    options: [
      SIZE_OPT([
        ['50 ml', '50 مل', 0],
        ['100 ml', '100 مل', 30_000],
      ]),
    ],
    facts: [
      INGREDIENT('Oud and Damask rose', 'عود وورد جوري'),
      SIZE('50 ml or 100 ml', '50 أو 100 مل'),
      HOW('Spray on pulse points from 15 cm.', 'رش على نقاط النبض من مسافة 15 سم.'),
      PAO(36),
    ],
  },
  {
    slug: 'white-musk-mist',
    name: 'White musk body mist 100 ml',
    nameAr: 'بخاخ جسم مسك أبيض 100 مل',
    category: 'perfumes',
    tags: [],
    price: 18_000,
    images: ['musk-mist.webp'],
    description: 'A clean, light musk for every day.',
    descriptionAr: 'مسك نضيف وخفيف لكل يوم.',
    facts: [
      INGREDIENT('White musk', 'مسك أبيض'),
      SIZE('100 ml', '100 مل'),
      HOW('Spray on clothes and skin.', 'رش على الهدوم والجلد.'),
      PAO(24),
    ],
  },
  // ---------------------------------------------------------------- hair care
  {
    slug: 'anti-dandruff-shampoo',
    name: 'Anti-dandruff shampoo 250 ml',
    nameAr:
      'شامبو ضد التقشر وحكة فروة الراس بتركيبة لطيفة للاستخدام المنتظم بيسيب الشعر نضيف وخفيف من غير ما يجفّفه 250 مل',
    category: 'hair-care',
    tags: [],
    price: 21_000,
    images: ['shampoo.webp'],
    description: 'Calms an itchy, flaking scalp and leaves hair clean and light.',
    descriptionAr: 'بيهدّي حكة فروة الراس والتقشر وبيسيب الشعر نضيف وخفيف.',
    facts: [
      ACTIVE('Zinc pyrithione 1%', 'زنك بيريثيون 1%'),
      SIZE('250 ml', '250 مل'),
      SKIN('Flaky scalp', 'فروة راس مقشّرة'),
      HOW('Massage into the scalp for two minutes, rinse.', 'دلّك فروة الراس دقيقتين واشطف.'),
      PAO(),
    ],
  },
  {
    slug: 'argan-hair-oil',
    name: 'Argan hair oil 50 ml',
    nameAr: 'زيت أرجان للشعر 50 مل',
    category: 'hair-care',
    tags: [],
    price: 23_500,
    compareAtPrice: 29_500,
    images: ['argan-hair-oil.webp'],
    description: 'Smooths frizz and adds shine without weighing the hair down.',
    descriptionAr: 'بيظبّط الهيشان وبيدّي لمعة من غير ما يتقّل الشعر.',
    facts: [
      INGREDIENT('Argan oil', 'زيت الأرجان'),
      SIZE('50 ml', '50 مل'),
      HOW('Two drops on damp lengths, then style.', 'نقطتين على الأطوال المبلولة وبعدين سرّح.'),
      PAO(),
    ],
  },
  // ---------------------------------------------------------------- devices and tools
  {
    slug: 'sonic-face-brush',
    name: 'Sonic face cleansing brush',
    nameAr: 'فرشاة تنظيف الوجه الصوتية',
    category: 'tools-devices',
    tags: [],
    price: 95_000,
    compareAtPrice: 125_000,
    images: ['sonic-face-brush.webp'],
    description: 'A waterproof silicone brush for a deeper clean, rechargeable by USB.',
    descriptionAr: 'فرشاة سيليكون مقاومة للميّه لتنضيف أعمق، وبتتشحن بـ USB.',
    facts: [
      chip('Material', 'الخامة', 'Soft silicone', 'سيليكون ناعم'),
      chip('Battery', 'البطارية', '30 days', '30 يوم'),
      HOW(
        'Use with cleanser for one minute, morning or night.',
        'استخدمها مع الغسول دقيقة، صباحًا أو مساءً.'
      ),
    ],
  },
];

/**
 * The real 3-step routine bundle (cleanse, treat, protect): the SAME three products as the Clinic
 * `steps` section, so "add all" can add this bundle and show its live saving. 15 % off the sum
 * (basis points). Variant-less components only (a bundle line on a variant product must pin a variant).
 */
export const JASMINE_BUNDLES = [
  {
    slug: 'routine-3-steps',
    name: 'Oily skin routine, 3 steps',
    nameAr: 'روتين البشرة الدهنية، 3 خطوات',
    description: 'Cleanser, niacinamide serum and sunscreen: the morning routine in one box.',
    descriptionAr: 'غسول وسيروم نياسيناميد وواقي شمس: روتين الصبح في علبة واحدة.',
    pricingType: 'percentage',
    pricingValue: 1500,
    products: ['gentle-cleanser-oily', 'niacinamide-serum', 'sunscreen-spf50'],
  },
];

/** Approved, verified reviews on 6 products (the PDP rating line renders on the demo). */
export const JASMINE_REVIEWS = [
  [
    'niacinamide-serum',
    5,
    'بقالي شهر بستخدمه والمسام فرق معاها فعلًا. الخامة خفيفة ومش لزجة.',
    'ar',
  ],
  ['niacinamide-serum', 5, 'My skin looks calmer and less oily after three weeks.', 'en'],
  ['niacinamide-serum', 4, 'كويس جدًا بس لازم أستمر عليه أسابيع عشان أشوف النتيجة.', 'ar'],
  ['sunscreen-spf50', 5, 'مفيش طبقة بيضا خالص وبيتحط تحت المكياج عادي.', 'ar'],
  ['sunscreen-spf50', 4, 'Light and does not sting my eyes. I reapply every two hours.', 'en'],
  ['ceramide-moisturiser', 5, 'بشرتي كانت بتتقشر في الشتا والكريم ده حلّ المشكلة.', 'ar'],
  ['ceramide-moisturiser', 5, 'Rich but not greasy. My skin feels comfortable all day.', 'en'],
  ['gentle-cleanser-oily', 4, 'بينضف كويس ومش بيشد الجلد. الريحة هادية.', 'ar'],
  ['gentle-cleanser-oily', 5, 'A proper gel cleanser. No tightness after rinsing.', 'en'],
  ['matte-lipstick', 5, 'اللون التوتي حلو جدًا ومبيجففش الشفايف زي غيره.', 'ar'],
  ['matte-lipstick', 4, 'Beautiful berry shade and it lasts through lunch.', 'en'],
  ['argan-hair-oil', 5, 'الشعر بقى ناعم ولامع من غير ما يتقّل.', 'ar'],
  ['argan-hair-oil', 4, 'Two drops are enough. Frizz is much better.', 'en'],
];

/** Every image file the catalogue and the home document name (the assets test checks each exists). */
export const JASMINE_IMAGE_FILES = [
  ...new Set([
    ...JASMINE_PRODUCTS.flatMap(p => p.images),
    ...JASMINE_CATEGORIES.map(c => c.image).filter(Boolean),
    'hero-apothecary-2k.webp',
    'hero-bloom-2k.webp',
    'hero-clinic-2k.webp',
  ]),
];
