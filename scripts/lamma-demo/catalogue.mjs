// Lamma demo catalogue (Phase B4 Task 6): an Egyptian home kitchen that also sells fresh produce and
// pantry basics, Arabic first, prices in piastres (1 EGP = 100). Data only:
// `scripts/storedemo/seed.mjs --template lamma` writes it, tests/unit/lamma-demo-catalogue.test.ts
// enforces every feature below by count. UNBRANDED on purpose (Ruling B4-11): generic Egyptian
// dish and grocery names, no brand, no logo, no packaging text. The maker is a FICTIONAL cook
// ("أم سلمى"), never a real client or person (Ruling B4-10). Photos are AI-generated ILLUSTRATIVE
// samples (scripts/lamma-demo/CREDITS.md).
//
// Features present at least once (the test counts them): portion-size variants on 2 dishes (a box
// of stuffed cabbage and of vine leaves), weight variants on 4 produce items with the unit price
// as a fact ("30 ج.م/كجم"), two `onCard` facts at most per product (serves-N, prep time or the unit
// price), a made-to-order lead time on 5+ dishes (1, 2 and 3 days) and none on grocery, a cake with
// a REQUIRED message and a kunafa with an OPTIONAL order note, 7 sale prices (one at 40 % off or
// more), a backorder (the béchamel tray), a sold-out variant (tea 250 g), every product with a photo
// (the no-photo and long-name cases are the lamma-noimg and lamma-longnames scenario stores), and one empty-looking
// product description path (every product has copy; the empty-category case is the test's).
// Store level (the seed): cash on delivery, a 14-day return window, a minimum order of 150 EGP,
// delivery dates 5 days ahead with two windows, a Greater Cairo zone.

/** @typedef {{ value: string, valueAr: string, priceAdd?: number }} LammaOptionValue */
/** @typedef {{ name: string, nameAr: string, values: LammaOptionValue[] }} LammaOption */
/**
 * @typedef {{ slug: string, name: string, nameAr: string, category: string, price: number,
 *   compareAtPrice?: number, images: string[], description: string, descriptionAr: string,
 *   options?: LammaOption[], soldOut?: string[][], backorder?: boolean,
 *   facts: { key: string, keyAr: string, value: string, valueAr: string, onCard?: boolean }[],
 *   leadTimeDays?: number, stock?: number,
 *   personalisation?: { label: string, labelAr: string, maxLength: number, required: boolean } }} LammaProduct
 */

export const LAMMA_CATEGORIES = [
  {
    slug: 'home-cooking',
    name: 'Stuffed and home cooking',
    nameAr: 'محاشي وأكل بيتي',
    image: 'mahshi-koronb.webp',
  },
  { slug: 'tagines', name: 'Tagines and trays', nameAr: 'طواجن', image: 'okra-tagine.webp' },
  {
    slug: 'grill-bakery',
    name: 'Grill and bakery',
    nameAr: 'مشويات ومخبوزات',
    image: 'kofta-grilled.webp',
  },
  { slug: 'sweets', name: 'Sweets', nameAr: 'حلويات', image: 'kunafa-nabulsi.webp' },
  { slug: 'produce', name: 'Fruit and vegetables', nameAr: 'خضار وفاكهة', image: 'tomatoes.webp' },
  { slug: 'dairy', name: 'Dairy and cheese', nameAr: 'ألبان وجبن', image: 'rumi-cheese.webp' },
  {
    slug: 'meat-poultry',
    name: 'Meat and poultry',
    nameAr: 'لحوم ودواجن',
    image: 'whole-chicken.webp',
  },
  { slug: 'pantry', name: 'Pantry', nameAr: 'بقالة ومخزن', image: 'egyptian-rice.webp' },
];

// ---- fact helpers: at most TWO `onCard` chips per product (B0-4/B0-49): serves-N, prep time, or
// the unit price; everything else is a table row on the PDP.
const chip = (key, keyAr, value, valueAr = value) => ({ key, keyAr, value, valueAr, onCard: true });
const ROW = (key, keyAr, value, valueAr = value) => ({ key, keyAr, value, valueAr });
const SERVES = (en, ar) => chip('Serves', 'يكفي', en, ar);
const READY = (en, ar) => chip('Ready in', 'يتجهز في', en, ar);
const PER_KG = egp => chip('Price per kg', 'السعر للكيلو', `EGP ${egp}`, `${egp} ج.م/كجم`);
const WEIGHT = (en, ar) => chip('Weight', 'الوزن', en, ar);
const MADE = ROW('Made', 'اتعمل', 'Fresh on the day of delivery', 'طازة يوم التوصيل');
const STORE = (en, ar) => ROW('Keep', 'الحفظ', en, ar);

const arPieces = n => n.replace(' pieces', ' قطع'); // the Arabic label must not carry the English unit
const PORTIONS = (small, medium, family) => ({
  name: 'Portion',
  nameAr: 'الحجم',
  // [label, labelAr, extra price in piastres over the base]
  values: [
    { value: `Small (${small})`, valueAr: `صغير (${arPieces(small)})` },
    { value: `Medium (${medium})`, valueAr: `وسط (${arPieces(medium)})` },
    { value: `Family (${family})`, valueAr: `عائلي (${arPieces(family)})` },
  ],
});
const WEIGHTS = (extra = 1500) => ({
  name: 'Weight',
  nameAr: 'الوزن',
  values: [
    { value: '500 g', valueAr: '500 جم' },
    { value: '1 kg', valueAr: '1 كجم', priceAdd: extra },
  ],
});
/** Portion options with real price steps (the boxes get dearer as they grow). */
function portionOption(small, medium, family, steps) {
  const o = PORTIONS(small, medium, family);
  o.values[1].priceAdd = steps[0];
  o.values[2].priceAdd = steps[1];
  return o;
}

/** @type {LammaProduct[]} */
export const LAMMA_PRODUCTS = [
  // ---------------------------------------------------------------- stuffed and home cooking
  {
    slug: 'mahshi-koronb',
    name: 'Stuffed cabbage box',
    nameAr: 'محشي كرنب — علبة',
    category: 'home-cooking',
    price: 9_000,
    images: ['mahshi-koronb.webp'],
    description: 'Cabbage leaves rolled with rice and herbs and simmered in a light garlic broth.',
    descriptionAr: 'ورق كرنب ملفوف بالأرز والتتبيلة وبيستوي في شوربة تومية خفيفة.',
    options: [portionOption('6 pieces', '12 pieces', '24 pieces', [8_000, 22_000])],
    leadTimeDays: 1,
    facts: [
      SERVES('1-2 people', '1-2 أفراد'),
      READY('24 hours', '24 ساعة'),
      MADE,
      STORE('Fridge, 3 days', 'التلاجة، 3 أيام'),
    ],
  },
  {
    slug: 'waraq-enab',
    name: 'Stuffed vine leaves box',
    nameAr: 'ورق عنب — علبة',
    category: 'home-cooking',
    price: 10_000,
    compareAtPrice: 17_000,
    images: ['waraq-enab.webp'],
    description: 'Tender vine leaves with a lemony rice filling, rolled thin and tight.',
    descriptionAr: 'ورق عنب طري بحشو أرز بالليمون، ملفوف رفيع ومتماسك.',
    options: [portionOption('8 pieces', '16 pieces', '32 pieces', [9_000, 24_000])],
    leadTimeDays: 2,
    facts: [
      SERVES('1-2 people', '1-2 أفراد'),
      READY('2 days', 'يومين'),
      MADE,
      STORE('Fridge, 4 days', 'التلاجة، 4 أيام'),
    ],
  },
  {
    slug: 'lentil-soup',
    name: 'Lentil soup, 1 litre',
    nameAr: 'شوربة عدس — لتر',
    category: 'home-cooking',
    price: 6_500,
    compareAtPrice: 8_000,
    images: ['lentil-soup.webp'],
    description: 'Smooth red lentil soup with cumin, served with a lemon wedge.',
    descriptionAr: 'شوربة عدس أحمر ناعمة بالكمون وبتتقدم مع ليمونة.',
    leadTimeDays: 1,
    facts: [SERVES('3-4 people', '3-4 أفراد'), READY('24 hours', '24 ساعة'), MADE],
  },
  // ---------------------------------------------------------------- tagines and trays
  {
    slug: 'okra-tagine',
    name: 'Okra and beef tagine, family pot',
    nameAr: 'طاجن بامية باللحمة',
    category: 'tagines',
    price: 24_000,
    images: ['okra-tagine.webp'],
    description:
      'Small okra and beef cubes slow-cooked in a rich garlic and coriander sauce, in a clay pot that serves four to six.',
    descriptionAr: 'بامية زيرو ولحمة مكعبات على نار هادية بالتوم والكزبرة في طاجن فخار.',
    leadTimeDays: 1,
    facts: [SERVES('4-6 people', '4-6 أفراد'), READY('24 hours', '24 ساعة'), MADE],
  },
  {
    slug: 'bechamel-pasta',
    name: 'Béchamel pasta tray',
    nameAr: 'طاجن مكرونة بالبشاميل',
    category: 'tagines',
    price: 19_000,
    images: ['bechamel-pasta.webp'],
    description: 'Pasta layered with minced beef and a thick béchamel, baked until golden on top.',
    descriptionAr: 'مكرونة بالفرن مع لحمة مفرومة وبشاميل تقيل ووشها محمّر.',
    // The backorder case (Professional plan): no stock, but it can be pre-ordered.
    stock: 0,
    backorder: true,
    leadTimeDays: 1,
    facts: [SERVES('3-4 people', '3-4 أفراد'), READY('24 hours', '24 ساعة'), MADE],
  },
  {
    slug: 'molokhia-chicken',
    name: 'Molokhia with chicken, box',
    nameAr: 'ملوخية بالفراخ — علبة',
    category: 'tagines',
    price: 15_000,
    images: ['molokhia-chicken.webp'],
    description: 'Fresh molokhia with garlic and coriander, served with chicken pieces.',
    descriptionAr: 'ملوخية خضرا بالتقلية والكزبرة ومعاها حتت فراخ.',
    leadTimeDays: 1,
    facts: [SERVES('2-3 people', '2-3 أفراد'), READY('24 hours', '24 ساعة'), MADE],
  },
  // ---------------------------------------------------------------- grill and bakery
  {
    slug: 'kofta-grilled',
    name: 'Grilled kofta, 500 g',
    nameAr: 'كفتة مشوية — 500 جم',
    category: 'grill-bakery',
    price: 21_000,
    images: ['kofta-grilled.webp'],
    description: 'Hand-shaped beef kofta with parsley and onion, grilled over charcoal.',
    descriptionAr: 'كفتة لحمة متشكلة باليد بالبقدونس والبصل ومشوية على الفحم.',
    leadTimeDays: 1,
    facts: [SERVES('3-4 people', '3-4 أفراد'), READY('24 hours', '24 ساعة'), MADE],
  },
  {
    slug: 'baladi-bread',
    name: 'Baladi bread, 5 loaves',
    nameAr: 'رغيف بلدي — 5 أرغفة',
    category: 'grill-bakery',
    price: 2_500,
    images: ['baladi-bread.webp'],
    description: 'Stone-baked whole wheat baladi loaves, packed warm.',
    descriptionAr: 'عيش بلدي قمح كامل مخبوز على الحجر ومتغلف سخن.',
    stock: 80,
    facts: [
      WEIGHT('5 loaves', '5 أرغفة'),
      ROW('Keep', 'الحفظ', 'Same day, or freeze', 'نفس اليوم أو فريزر'),
    ],
  },
  // ---------------------------------------------------------------- sweets
  {
    slug: 'basbousa-qishta',
    name: 'Basbousa with cream, tray',
    nameAr: 'بسبوسة بالقشطة — صينية',
    category: 'sweets',
    price: 14_000,
    compareAtPrice: 17_500,
    images: ['basbousa-qishta.webp'],
    description: 'Semolina cake soaked in light syrup with a thick layer of cream.',
    descriptionAr: 'بسبوسة سميد بشربات خفيف وطبقة قشطة سميكة.',
    leadTimeDays: 1,
    facts: [SERVES('6-8 people', '6-8 أفراد'), READY('24 hours', '24 ساعة'), MADE],
  },
  {
    slug: 'kunafa-nabulsi',
    name: 'Nabulsi kunafa, tray',
    nameAr: 'كنافة نابلسي — صينية',
    category: 'sweets',
    price: 26_000,
    images: ['kunafa-nabulsi.webp'],
    description: 'Crisp kunafa over a soft cheese layer with syrup on the side.',
    descriptionAr: 'كنافة مقرمشة على طبقة جبنة طرية والشربات على جنب.',
    leadTimeDays: 2,
    // The OPTIONAL note case ("ملاحظة على الطلب").
    personalisation: {
      label: 'Order note',
      labelAr: 'ملاحظة على الطلب',
      maxLength: 80,
      required: false,
    },
    facts: [SERVES('6-8 people', '6-8 أفراد'), READY('2 days', 'يومين'), MADE],
  },
  {
    slug: 'kahk-eid',
    name: 'Eid kahk',
    nameAr:
      'كحك العيد بالسمن البلدي والعجوة والملبن — علبة هدية كبيرة 2 كيلو متغلفة بشكل أنيق للهدايا والعزومات والأفراح',
    category: 'sweets',
    price: 38_000,
    compareAtPrice: 68_000,
    images: ['kahk-eid.webp'],
    description: 'Buttery kahk filled with dates and dusted with sugar, in a gift box.',
    descriptionAr: 'كحك بالسمن البلدي محشي عجوة ومرشوش سكر بودرة في علبة هدية.',
    leadTimeDays: 3,
    facts: [WEIGHT('2 kg', '2 كجم'), READY('3 days', '3 أيام'), MADE],
  },
  {
    slug: 'chocolate-cake',
    name: 'Chocolate cake with your message',
    nameAr: 'تورتة شوكولاتة (اكتب الرسالة)',
    category: 'sweets',
    price: 45_000,
    images: ['chocolate-cake.webp'],
    description: 'A tall chocolate cake with ganache. Tell us what to write on it.',
    descriptionAr: 'تورتة شوكولاتة عالية بالجاناش. اكتبلنا نكتب إيه عليها.',
    leadTimeDays: 3,
    // The REQUIRED message case.
    personalisation: {
      label: 'Message on the cake',
      labelAr: 'الرسالة على التورتة',
      maxLength: 30,
      required: true,
    },
    facts: [SERVES('8-10 people', '8-10 أفراد'), READY('3 days', '3 أيام'), MADE],
  },
  // ---------------------------------------------------------------- fruit and vegetables
  {
    slug: 'tomatoes',
    name: 'Tomatoes',
    nameAr: 'طماطم',
    category: 'produce',
    price: 1_500,
    images: ['tomatoes.webp'],
    description: 'Firm red tomatoes, picked this week.',
    descriptionAr: 'طماطم حمرا جامدة من قطف الأسبوع ده.',
    options: [WEIGHTS()],
    facts: [PER_KG(30), ROW('Origin', 'المصدر', 'Egypt', 'مصر')],
  },
  {
    slug: 'cucumbers',
    name: 'Cucumbers, 1 kg',
    nameAr: 'خيار — 1 كجم',
    category: 'produce',
    price: 2_200,
    images: ['cucumbers.webp'],
    description: 'Crunchy green cucumbers for salads.',
    descriptionAr: 'خيار أخضر مقرمش للسلطة.',
    facts: [PER_KG(22), ROW('Origin', 'المصدر', 'Egypt', 'مصر')],
  },
  {
    slug: 'arugula',
    name: 'Arugula, bunch',
    nameAr: 'جرجير — حزمة',
    category: 'produce',
    price: 800,
    images: ['arugula.webp'],
    description: 'A fresh peppery bunch, washed and tied.',
    descriptionAr: 'حزمة جرجير طازة، متغسلة ومربوطة.',
    facts: [WEIGHT('1 bunch', 'حزمة'), ROW('Keep', 'الحفظ', 'Fridge, 3 days', 'التلاجة، 3 أيام')],
  },
  {
    slug: 'eggplant',
    name: 'Eggplant',
    nameAr: 'باذنجان',
    category: 'produce',
    price: 1_200,
    images: ['eggplant.webp'],
    description: 'Glossy dark eggplant for frying or baking.',
    descriptionAr: 'باذنجان أسود لامع للتحمير أو الفرن.',
    options: [WEIGHTS(1_200)],
    facts: [PER_KG(24), ROW('Origin', 'المصدر', 'Egypt', 'مصر')],
  },
  {
    slug: 'green-pepper',
    name: 'Green peppers, 500 g',
    nameAr: 'فلفل أخضر — 500 جم',
    category: 'produce',
    price: 1_600,
    images: ['green-pepper.webp'],
    description: 'Mild green peppers for stuffing or frying.',
    descriptionAr: 'فلفل أخضر هادي للحشو أو التحمير.',
    facts: [PER_KG(32), ROW('Origin', 'المصدر', 'Egypt', 'مصر')],
  },
  {
    slug: 'potatoes',
    name: 'Potatoes',
    nameAr: 'بطاطس',
    category: 'produce',
    price: 1_100,
    images: ['potatoes.webp'],
    description: 'Clean firm potatoes for frying and the oven.',
    descriptionAr: 'بطاطس نضيفة وجامدة للتحمير والفرن.',
    options: [WEIGHTS(1_100)],
    facts: [PER_KG(22), ROW('Origin', 'المصدر', 'Egypt', 'مصر')],
  },
  {
    slug: 'apples',
    name: 'Apples',
    nameAr: 'تفاح',
    category: 'produce',
    price: 2_250,
    images: ['apples.webp'],
    description: 'Crisp sweet apples, green and red.',
    descriptionAr: 'تفاح مقرمش حلو، أخضر وأحمر.',
    options: [WEIGHTS(2_250)],
    facts: [PER_KG(45), ROW('Origin', 'المصدر', 'Egypt', 'مصر')],
  },
  // ---------------------------------------------------------------- dairy and cheese
  {
    slug: 'rumi-cheese',
    name: 'Rumi cheese, 250 g',
    nameAr: 'جبنة رومي — 250 جم',
    category: 'dairy',
    price: 8_500,
    compareAtPrice: 11_000,
    images: ['rumi-cheese.webp'],
    description: 'Aged sharp rumi cheese, cut fresh.',
    descriptionAr: 'جبنة رومي قديمة حادة، متقطعة طازة.',
    facts: [WEIGHT('250 g', '250 جم'), ROW('Keep', 'الحفظ', 'Fridge, 2 weeks', 'التلاجة، أسبوعين')],
  },
  {
    slug: 'fresh-milk',
    name: 'Fresh milk, 1 litre',
    nameAr: 'لبن طازة — لتر',
    category: 'dairy',
    price: 3_200,
    images: ['fresh-milk.webp'],
    description: 'Full-fat fresh milk from a local farm, bottled this morning.',
    descriptionAr: 'لبن كامل الدسم من مزرعة قريبة، متعبّي الصبح.',
    facts: [WEIGHT('1 litre', 'لتر'), ROW('Keep', 'الحفظ', 'Fridge, 3 days', 'التلاجة، 3 أيام')],
  },
  {
    slug: 'baladi-yogurt',
    name: 'Baladi yogurt, 500 g',
    nameAr: 'زبادي بلدي — 500 جم',
    category: 'dairy',
    price: 2_800,
    images: ['baladi-yogurt.webp'],
    description: 'Thick set yogurt in a clay-style tub.',
    descriptionAr: 'زبادي متماسك في علبة بتشبه الفخار.',
    facts: [WEIGHT('500 g', '500 جم'), ROW('Keep', 'الحفظ', 'Fridge, 5 days', 'التلاجة، 5 أيام')],
  },
  // ---------------------------------------------------------------- meat and poultry
  {
    slug: 'whole-chicken',
    name: 'Whole chicken, about 1.2 kg',
    nameAr: 'فراخ كاملة — حوالي 1.2 كجم',
    category: 'meat-poultry',
    price: 14_000,
    images: ['whole-chicken.webp'],
    description: 'A cleaned whole chicken from a local farm.',
    descriptionAr: 'فرخة كاملة متنضفة من مزرعة قريبة.',
    facts: [
      WEIGHT('about 1.2 kg', 'حوالي 1.2 كجم'),
      ROW('Keep', 'الحفظ', 'Fridge, 2 days', 'التلاجة، يومين'),
    ],
  },
  {
    slug: 'minced-beef',
    name: 'Minced beef, 500 g',
    nameAr: 'لحمة مفرومة — 500 جم',
    category: 'meat-poultry',
    price: 18_500,
    images: ['minced-beef.webp'],
    description: 'Fresh minced beef, ground this morning.',
    descriptionAr: 'لحمة مفرومة طازة، متفرمة الصبح.',
    facts: [WEIGHT('500 g', '500 جم'), ROW('Keep', 'الحفظ', 'Fridge, 1 day', 'التلاجة، يوم')],
  },
  // ---------------------------------------------------------------- pantry
  {
    slug: 'egyptian-rice',
    name: 'Egyptian rice, 1 kg',
    nameAr: 'أرز مصري — 1 كجم',
    category: 'pantry',
    price: 3_400,
    images: ['egyptian-rice.webp'],
    description: 'Short-grain Egyptian rice in a plain paper bag.',
    descriptionAr: 'أرز مصري حبة قصيرة في كيس ورق سادة.',
    facts: [WEIGHT('1 kg', '1 كجم'), ROW('Origin', 'المصدر', 'Egypt', 'مصر')],
  },
  {
    slug: 'brown-lentils',
    name: 'Brown lentils, 500 g',
    nameAr: 'عدس بجبة — 500 جم',
    category: 'pantry',
    price: 2_600,
    images: ['brown-lentils.webp'],
    description: 'Whole brown lentils, cleaned and sorted.',
    descriptionAr: 'عدس بجبة كامل، منقّى ومتصنّف.',
    facts: [WEIGHT('500 g', '500 جم'), ROW('Origin', 'المصدر', 'Egypt', 'مصر')],
  },
  {
    slug: 'cooking-oil',
    name: 'Cooking oil, 1 litre',
    nameAr: 'زيت طبخ — لتر',
    category: 'pantry',
    price: 5_200,
    compareAtPrice: 6_500,
    images: ['cooking-oil.webp'], // the no-photo case lives in the lamma-noimg scenario store (a showroom never shows a placeholder)
    description: 'Refined vegetable oil for everyday cooking.',
    descriptionAr: 'زيت نباتي مكرر للطبخ اليومي.',
    facts: [WEIGHT('1 litre', 'لتر'), ROW('Keep', 'الحفظ', 'Cool and dry', 'مكان بارد وجاف')],
  },
  {
    slug: 'black-tea',
    name: 'Loose black tea',
    nameAr: 'شاي سايب',
    category: 'pantry',
    price: 4_500,
    images: ['black-tea.webp'],
    description: 'Strong loose black tea for a proper pot.',
    descriptionAr: 'شاي أسود سايب تقيل لإبريق مظبوط.',
    options: [
      {
        name: 'Pack',
        nameAr: 'العبوة',
        values: [
          { value: '125 g', valueAr: '125 جم' },
          { value: '250 g', valueAr: '250 جم', priceAdd: 3_500 },
        ],
      },
    ],
    // The sold-out variant case.
    soldOut: [['250 g']],
    facts: [WEIGHT('125 g / 250 g', '125 جم / 250 جم'), ROW('Origin', 'المصدر', 'Kenya', 'كينيا')],
  },
];

/** Every image file the catalogue and the home document name (the assets test checks each exists). */
export const LAMMA_IMAGE_FILES = [
  ...new Set([
    ...LAMMA_PRODUCTS.flatMap(p => p.images),
    ...LAMMA_CATEGORIES.map(c => c.image).filter(Boolean),
    'hero-table-2k.webp',
    'maker.webp',
  ]),
];
