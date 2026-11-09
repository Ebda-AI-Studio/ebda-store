// Qamar demo catalogue (Phase B1 Task 6): a realistic Egyptian boutique, Arabic first, prices in
// piastres (1 EGP = 100). Data only: `scripts/storedemo/seed.mjs` writes it, the tests read it.
// Every B0 storefront feature appears at least once (tests/unit/qamar-demo-catalogue.test.ts):
// hex and image swatches, more than 5 swatches (+N on the card), Colour x Size x Length with a
// struck-out combination, facts (at most 2 on the card), made-to-order lead time, personalisation,
// size charts by category, a sale, a backorder, a product with no image and very long names.
// Photos are AI-generated ILLUSTRATIVE samples (Ruling TPL-3, scripts/qamar-demo/CREDITS.md).

/** @typedef {{ value: string, valueAr: string, hex?: string, image?: string }} QamarOptionValue */
/** @typedef {{ name: string, nameAr: string, values: QamarOptionValue[] }} QamarOption */
/**
 * @typedef {{ slug: string, name: string, nameAr: string, category: string, alsoIn?: string[],
 *   price: number, compareAtPrice?: number, images: string[], description: string, descriptionAr: string,
 *   options?: QamarOption[], soldOut?: string[][], backorder?: boolean,
 *   facts?: { key: string, keyAr: string, value: string, valueAr: string, onCard?: boolean }[],
 *   leadTimeDays?: number, personalisation?: { label: string, labelAr: string, maxLength: number, required: boolean },
 *   stock?: number }} QamarProduct
 */

export const QAMAR_CATEGORIES = [
  {
    slug: 'abayas',
    name: 'Abayas',
    nameAr: 'عبايات',
    sizeChart: 'abaya',
    image: 'linen-abaya-1.webp',
  },
  {
    slug: 'kaftans',
    name: 'Kaftans',
    nameAr: 'قفاطين',
    sizeChart: 'apparel',
    image: 'embroidered-kaftan-1.webp',
  },
  { slug: 'scarves', name: 'Scarves and shawls', nameAr: 'طرح وشيلان', image: 'silk-shawl-1.webp' },
  {
    slug: 'dresses',
    name: 'Evening dresses',
    nameAr: 'فساتين سهرة',
    sizeChart: 'apparel',
    image: 'evening-gown-rose-1.webp',
  },
  // Occasion categories (Vitrine's bands); products are cross-listed into them.
  { slug: 'wedding', name: 'Wedding', nameAr: 'فرح' },
  { slug: 'engagement', name: 'Engagement', nameAr: 'خطوبة' },
  { slug: 'evening', name: 'Evening', nameAr: 'سهرة' },
];

/** The two size charts, keyed by `QAMAR_CATEGORIES[].sizeChart`. */
export const QAMAR_SIZE_CHARTS = {
  abaya: {
    name: 'Abaya (size x length)',
    nameAr: 'عباية (مقاس x طول)',
    unit: 'cm',
    columns: [
      { label: 'Size', labelAr: 'المقاس' },
      { label: 'Length', labelAr: 'الطول' },
      { label: 'Chest', labelAr: 'الصدر' },
    ],
    rows: [
      ['S', '52', '96'],
      ['M', '54', '102'],
      ['L', '56', '108'],
      ['XL', '58', '114'],
    ],
    note: 'Length is measured from the shoulder to the hem.',
    noteAr: 'الطول بيتقاس من الكتف لحد الديل.',
  },
  apparel: {
    name: 'Clothing (S-XXL)',
    nameAr: 'ملابس (S-XXL)',
    unit: 'cm',
    columns: [
      { label: 'Size', labelAr: 'المقاس' },
      { label: 'Chest', labelAr: 'الصدر' },
      { label: 'Waist', labelAr: 'الوسط' },
      { label: 'Hips', labelAr: 'الأرداف' },
    ],
    rows: [
      ['S', '88', '70', '96'],
      ['M', '94', '76', '102'],
      ['L', '100', '82', '108'],
      ['XL', '106', '88', '114'],
      ['XXL', '112', '94', '120'],
    ],
    note: 'Between two sizes, take the larger one.',
    noteAr: 'لو بين مقاسين، المقاس الأكبر أريح.',
  },
};

const SIZES = (list = ['S', 'M', 'L', 'XL']) => ({
  name: 'Size',
  nameAr: 'المقاس',
  values: list.map(v => ({ value: v, valueAr: v })),
});
const LENGTHS = {
  name: 'Length',
  nameAr: 'الطول',
  values: ['52', '54', '56', '58'].map(v => ({ value: v, valueAr: v })),
};
const FABRIC = (en, ar, onCard = true) => ({
  key: 'Fabric',
  keyAr: 'الخامة',
  value: en,
  valueAr: ar,
  onCard,
});
const CARE = (en, ar) => ({ key: 'Care', keyAr: 'العناية', value: en, valueAr: ar });
const imgs = slug => [`${slug}-1.webp`, `${slug}-2.webp`];

/** @type {QamarProduct[]} */
export const QAMAR_PRODUCTS = [
  {
    slug: 'linen-abaya',
    name: 'Linen abaya',
    nameAr: 'عباية كتان',
    category: 'abayas',
    price: 149000,
    images: imgs('linen-abaya'),
    description:
      'A loose abaya in Egyptian linen with wide sleeves. Light for the Cairo summer, made in our workshop in Heliopolis.',
    descriptionAr:
      'عباية واسعة من الكتان المصري بأكمام عريضة. خفيفة لصيف القاهرة، ومتفصلة في ورشتنا في مصر الجديدة.',
    options: [
      {
        name: 'Colour',
        nameAr: 'اللون',
        values: [
          { value: 'Rose', valueAr: 'وردي', image: 'swatch-rose-linen.webp' },
          { value: 'Teal', valueAr: 'تركواز', hex: '#1F4E54' },
          { value: 'Black', valueAr: 'أسود', hex: '#141414' },
        ],
      },
      SIZES(),
      LENGTHS,
    ],
    soldOut: [['Rose', 'M', '56']],
    facts: [
      FABRIC('Egyptian linen', 'كتان مصري'),
      CARE('Hand wash', 'غسيل يدوي'),
      { key: 'Fit', keyAr: 'القصة', value: 'Loose', valueAr: 'واسعة' },
    ],
    personalisation: {
      label: 'Name to embroider',
      labelAr: 'الاسم للتطريز',
      maxLength: 12,
      required: false,
    },
  },
  {
    slug: 'embroidered-kaftan',
    name: 'Embroidered kaftan',
    nameAr: 'قفطان مطرز',
    category: 'kaftans',
    alsoIn: ['evening'],
    price: 225000,
    images: imgs('embroidered-kaftan'),
    description:
      'Ivory kaftan with oxblood hand embroidery around the neck. Made to order: each one is embroidered after you order it.',
    descriptionAr:
      'قفطان أوف وايت بتطريز يدوي نبيتي حوالين الرقبة. بيتعمل مخصوص: كل قطعة بتتطرز بعد ما تطلبيها.',
    options: [SIZES(['S', 'M', 'L', 'XL', 'XXL'])],
    leadTimeDays: 5,
    facts: [
      FABRIC('Cotton voile', 'قطن فوال'),
      { key: 'Embroidery', keyAr: 'التطريز', value: 'By hand', valueAr: 'يدوي', onCard: true },
    ],
  },
  {
    slug: 'crepe-abaya-sale',
    name: 'Crepe abaya',
    nameAr: 'عباية كريب',
    category: 'abayas',
    price: 115000,
    compareAtPrice: 145000,
    images: imgs('crepe-abaya-sale'),
    description: 'A flowing black crepe abaya that does not crease. Last pieces of the season.',
    descriptionAr: 'عباية كريب سودا بتنزل حلو ومبتتكرمشش. آخر قطع من الموسم.',
    options: [SIZES(), LENGTHS],
    facts: [FABRIC('Crepe', 'كريب'), CARE('Machine wash, cold', 'غسالة على البارد')],
  },
  {
    slug: 'chiffon-scarf',
    name: 'Chiffon scarf',
    nameAr: 'طرحة شيفون',
    category: 'scarves',
    price: 32000,
    images: imgs('chiffon-scarf'),
    description: 'A soft chiffon scarf, 180 by 70 cm, in seven colours.',
    descriptionAr: 'طرحة شيفون ناعمة، 180 في 70 سم، بسبع ألوان.',
    options: [
      {
        name: 'Colour',
        nameAr: 'اللون',
        values: [
          { value: 'Rose', valueAr: 'وردي', hex: '#C9A0A0' },
          { value: 'Teal', valueAr: 'تركواز', hex: '#1F4E54' },
          { value: 'Black', valueAr: 'أسود', hex: '#141414' },
          { value: 'Ivory', valueAr: 'أوف وايت', hex: '#F2EEE6' },
          { value: 'Mauve', valueAr: 'موف', hex: '#8E6C88' },
          { value: 'Olive', valueAr: 'زيتي', hex: '#6B6B3A' },
          { value: 'Navy', valueAr: 'كحلي', hex: '#1E2A44' },
        ],
      },
    ],
    facts: [
      FABRIC('Chiffon', 'شيفون'),
      { key: 'Size', keyAr: 'المقاس', value: '180 x 70 cm', valueAr: '180 × 70 سم' },
    ],
  },
  {
    slug: 'evening-gown-rose',
    name: 'Satin evening gown',
    nameAr: 'فستان سهرة ستان',
    category: 'dresses',
    alsoIn: ['evening', 'wedding'],
    price: 390000,
    images: imgs('evening-gown-rose'),
    description:
      'Dusty rose satin gown with long sleeves. Out of stock now: order it and we ship it as soon as the next run is ready.',
    descriptionAr:
      'فستان ستان وردي هادي بأكمام طويلة. خلصان دلوقتي: ينفع يتطلب ونشحنه أول ما الدفعة الجاية تجهز.',
    options: [SIZES(['S', 'M', 'L', 'XL', 'XXL'])],
    backorder: true,
    stock: 0,
    facts: [FABRIC('Satin', 'ستان')],
  },
  {
    slug: 'hand-embroidered-abaya',
    name: 'Black abaya, gold hand embroidery and belt',
    nameAr: 'عباية سوداء مطرزة يدويًا بخيط ذهبي مع حزام جلد طبيعي وأكمام واسعة للسهرات',
    category: 'abayas',
    alsoIn: ['evening'],
    price: 289000,
    images: imgs('hand-embroidered-abaya'),
    description:
      'Black abaya with gold thread embroidery down the front and a natural leather belt. The long name is part of the demo.',
    descriptionAr:
      'عباية سودا بتطريز بخيط دهبي على الصدر وحزام جلد طبيعي. الاسم الطويل جزء من التجربة.',
    options: [SIZES(), LENGTHS],
    facts: [FABRIC('Nida crepe', 'كريب ندى'), CARE('Dry clean', 'تنظيف جاف')],
  },
  {
    slug: 'classic-black-abaya',
    name: 'Classic black abaya',
    nameAr: 'عباية سوداء كلاسيك',
    category: 'abayas',
    price: 129000,
    images: imgs('classic-black-abaya'),
    description: 'The everyday black abaya, cut straight, with a hidden button placket.',
    descriptionAr: 'العباية السودا اللي بتلبسيها كل يوم، قصة مستقيمة وزراير مخفية.',
    options: [SIZES(), LENGTHS],
    facts: [FABRIC('Crepe', 'كريب')],
  },
  {
    slug: 'open-front-abaya',
    name: 'Open-front abaya',
    nameAr: 'عباية مفتوحة',
    category: 'abayas',
    price: 165000,
    images: imgs('open-front-abaya'),
    description: 'An open abaya to wear over a dress, with a fine piping along the front.',
    descriptionAr: 'عباية مفتوحة تتلبس فوق فستان، بكردون رفيع على الطرف.',
    options: [
      {
        name: 'Colour',
        nameAr: 'اللون',
        values: [
          { value: 'Navy', valueAr: 'كحلي', hex: '#1E2A44' },
          { value: 'Black', valueAr: 'أسود', hex: '#141414' },
        ],
      },
      SIZES(),
    ],
    facts: [FABRIC('Linen blend', 'كتان مخلوط')],
  },
  {
    slug: 'linen-kaftan',
    name: 'Linen kaftan',
    nameAr: 'قفطان كتان',
    category: 'kaftans',
    price: 175000,
    images: imgs('linen-kaftan'),
    description: 'Teal linen kaftan with side slits and wooden buttons.',
    descriptionAr: 'قفطان كتان تركواز بفتحات جانبية وزراير خشب.',
    options: [
      {
        name: 'Colour',
        nameAr: 'اللون',
        values: [
          { value: 'Teal', valueAr: 'تركواز', image: 'swatch-teal-linen.webp' },
          { value: 'Ivory', valueAr: 'أوف وايت', hex: '#F2EEE6' },
        ],
      },
      SIZES(['S', 'M', 'L', 'XL', 'XXL']),
    ],
    facts: [FABRIC('Egyptian linen', 'كتان مصري')],
  },
  {
    slug: 'velvet-kaftan',
    name: 'Velvet kaftan',
    nameAr: 'قفطان قطيفة',
    category: 'kaftans',
    alsoIn: ['evening'],
    price: 260000,
    images: imgs('velvet-kaftan'),
    description: 'Deep oxblood velvet kaftan for winter evenings.',
    descriptionAr: 'قفطان قطيفة نبيتي غامق لسهرات الشتا.',
    options: [SIZES(['S', 'M', 'L', 'XL', 'XXL'])],
    facts: [FABRIC('Velvet', 'قطيفة'), CARE('Dry clean', 'تنظيف جاف')],
  },
  {
    slug: 'silk-shawl',
    name: 'Silk shawl',
    nameAr: 'شال حرير',
    category: 'scarves',
    alsoIn: ['wedding'],
    price: 54000,
    images: imgs('silk-shawl'),
    description: 'Champagne silk shawl with a hand-rolled hem.',
    descriptionAr: 'شال حرير شامبين بحاشية ملفوفة باليد.',
    stock: 18,
    facts: [FABRIC('Silk', 'حرير')],
  },
  {
    slug: 'cotton-scarf-set',
    name: 'Cotton scarf set (3 pieces)',
    nameAr: 'طقم طرح قطن (3 قطع)',
    category: 'scarves',
    price: 45000,
    images: imgs('cotton-scarf-set'),
    description: 'Three cotton jersey scarves: black, ivory and tobacco brown.',
    descriptionAr: 'تلات طرح قطن جيرسيه: أسود وأوف وايت وبني.',
    stock: 30,
    facts: [FABRIC('Cotton jersey', 'قطن جيرسيه')],
  },
  {
    slug: 'satin-midi-dress',
    name: 'Satin midi dress',
    nameAr: 'فستان ستان ميدي',
    category: 'dresses',
    alsoIn: ['engagement', 'evening'],
    price: 285000,
    images: imgs('satin-midi-dress'),
    description: 'Deep teal satin midi dress with long sleeves and covered buttons.',
    descriptionAr: 'فستان ستان ميدي تركواز غامق بأكمام طويلة وزراير متغلفة.',
    options: [SIZES(['S', 'M', 'L', 'XL', 'XXL'])],
    facts: [FABRIC('Satin', 'ستان')],
  },
  {
    slug: 'tulle-engagement-dress',
    name: 'Tulle engagement dress',
    nameAr: 'فستان خطوبة تول',
    category: 'dresses',
    alsoIn: ['engagement'],
    price: 420000,
    images: imgs('tulle-engagement-dress'),
    description: 'Blush tulle in soft layers, lined, with long sleeves.',
    descriptionAr: 'تول بينك فاتح طبقات ناعمة، مبطن، بأكمام طويلة.',
    options: [SIZES(['S', 'M', 'L', 'XL', 'XXL'])],
    leadTimeDays: 7,
    facts: [FABRIC('Tulle, lined', 'تول مبطن')],
  },
  {
    slug: 'beaded-evening-dress',
    name: 'Beaded evening dress in champagne, long sleeves, fully lined',
    nameAr: 'فستان سهرة مطرز بالخرز',
    category: 'dresses',
    alsoIn: ['wedding', 'evening'],
    price: 450000,
    images: imgs('beaded-evening-dress'),
    description:
      'Champagne dress with glass bead embroidery on the sleeves. The long English name is part of the demo.',
    descriptionAr: 'فستان شامبين بتطريز خرز على الأكمام.',
    options: [SIZES(['S', 'M', 'L', 'XL', 'XXL'])],
    facts: [FABRIC('Crepe with beads', 'كريب بالخرز')],
  },
  {
    slug: 'wedding-guest-kaftan',
    name: 'Wedding guest kaftan',
    nameAr: 'قفطان فرح',
    category: 'kaftans',
    alsoIn: ['wedding'],
    price: 310000,
    images: imgs('wedding-guest-kaftan'),
    description: 'Dusty rose chiffon kaftan with a champagne trim, for a wedding night.',
    descriptionAr: 'قفطان شيفون وردي هادي بشريط شامبين، لليلة الفرح.',
    options: [SIZES(['S', 'M', 'L', 'XL', 'XXL'])],
    facts: [FABRIC('Chiffon', 'شيفون')],
  },
  {
    slug: 'pleated-dress',
    name: 'Pleated dress',
    nameAr: 'فستان بليسيه',
    category: 'dresses',
    alsoIn: ['evening'],
    price: 240000,
    images: imgs('pleated-dress'),
    description: 'Long plum dress in fine knife pleats.',
    descriptionAr: 'فستان طويل بلون البرقوق ببليسيه رفيع.',
    options: [SIZES(['S', 'M', 'L', 'XL'])],
    facts: [FABRIC('Pleated crepe', 'كريب بليسيه')],
  },
];

/** Shop-the-look blocks (Task 7): one photo, three product slugs each. */
export const QAMAR_LOOKS_STORY = [
  {
    id: 'look-1',
    image: 'look-1.webp',
    title: 'Linen in rose',
    titleAr: 'كتان وردي',
    items: ['linen-abaya', 'chiffon-scarf', 'silk-shawl'],
  },
  {
    id: 'look-2',
    image: 'look-2.webp',
    title: 'Teal for the evening',
    titleAr: 'تركواز للسهرة',
    items: ['satin-midi-dress', 'silk-shawl', 'open-front-abaya'],
  },
  {
    id: 'look-3',
    image: 'look-3.webp',
    title: 'Embroidered ivory',
    titleAr: 'أوف وايت مطرز',
    items: ['embroidered-kaftan', 'cotton-scarf-set', 'classic-black-abaya'],
  },
];

/** Occasion band tiles (Task 8). `tone` is the collection block's band colour. */
export const QAMAR_OCCASIONS = [
  {
    slug: 'wedding',
    label: 'Wedding',
    labelAr: 'فرح',
    image: 'occasion-wedding.webp',
    tone: 'primary',
  },
  {
    slug: 'engagement',
    label: 'Engagement',
    labelAr: 'خطوبة',
    image: 'occasion-engagement.webp',
    tone: 'accent',
  },
  {
    slug: 'evening',
    label: 'Evening',
    labelAr: 'سهرة',
    image: 'occasion-evening.webp',
    tone: 'line',
  },
];

/** Page imagery the home document uses (heroes are one per look, C10). */
export const QAMAR_PAGE_IMAGES = {
  heroAtelier: 'hero-atelier-2k.webp',
  heroVitrine: 'hero-vitrine-2k.webp',
  lookbook: ['lookbook-1-2k.webp', 'lookbook-2-2k.webp', 'lookbook-3-2k.webp'],
  break: 'break-atelier.webp',
  video: 'hero-1080.mp4',
  videoMobile: 'hero-540.mp4',
};

/** Every file under assets/ the catalogue references (the test checks presence, budget, no extras). */
export const ASSET_FILES = [
  ...new Set([
    ...QAMAR_PRODUCTS.flatMap(p => p.images),
    ...QAMAR_PRODUCTS.flatMap(p =>
      (p.options ?? []).flatMap(o => o.values.map(v => v.image).filter(Boolean))
    ),
    ...QAMAR_LOOKS_STORY.map(l => l.image),
    ...QAMAR_OCCASIONS.map(o => o.image),
    QAMAR_PAGE_IMAGES.heroAtelier,
    QAMAR_PAGE_IMAGES.heroVitrine,
    ...QAMAR_PAGE_IMAGES.lookbook,
    QAMAR_PAGE_IMAGES.break,
    QAMAR_PAGE_IMAGES.video,
    QAMAR_PAGE_IMAGES.videoMobile,
  ]),
];
