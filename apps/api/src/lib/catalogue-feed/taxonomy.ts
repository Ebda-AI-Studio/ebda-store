/**
 * Google product taxonomy mapping for common store categories. Every id below was checked against Google's
 * official taxonomy-with-ids file (https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt, 2026-11-14).
 * Match is by WHOLE WORD on the category's own name/slug (English or Arabic), deepest category first; a category
 * that matches nothing yields NO google_product_category - never a guess (Ruling FEEDS-6). A merchant can pin an
 * exact id with a product fact named `google_product_category`.
 */
export interface GoogleCategory {
  id: number;
  /** Full path in Google's taxonomy (TikTok accepts three levels at most). */
  path: string;
}

const C = (id: number, path: string): GoogleCategory => ({ id, path });

const CLOTHING = C(1604, 'Apparel & Accessories > Clothing');
const SHOES = C(187, 'Apparel & Accessories > Shoes');

/** [keywords (lowercase, whole words), category]. First match wins, so specific rows come first. */
const TABLE: Array<[string[], GoogleCategory]> = [
  [['watch', 'watches', 'ساعة', 'ساعات'], C(201, 'Apparel & Accessories > Jewelry > Watches')],
  [
    ['necklace', 'necklaces', 'عقد', 'عقود', 'سلسلة'],
    C(196, 'Apparel & Accessories > Jewelry > Necklaces'),
  ],
  [['ring', 'rings', 'خاتم', 'خواتم'], C(200, 'Apparel & Accessories > Jewelry > Rings')],
  [
    ['bracelet', 'bracelets', 'اسورة', 'أسورة', 'اساور', 'أساور'],
    C(191, 'Apparel & Accessories > Jewelry > Bracelets'),
  ],
  [
    ['earring', 'earrings', 'حلق', 'اقراط', 'أقراط'],
    C(194, 'Apparel & Accessories > Jewelry > Earrings'),
  ],
  [
    ['jewelry', 'jewellery', 'gold', 'silver', 'مجوهرات', 'ذهب', 'فضة', 'دهب'],
    C(188, 'Apparel & Accessories > Jewelry'),
  ],
  [
    ['handbag', 'handbags', 'شنطة', 'شنط', 'حقيبة', 'حقائب'],
    C(3032, 'Apparel & Accessories > Handbags, Wallets & Cases > Handbags'),
  ],
  [['bag', 'bags', 'luggage', 'backpack', 'backpacks'], C(5181, 'Luggage & Bags')],
  [
    [
      'shoes',
      'shoe',
      'sneakers',
      'sandals',
      'boots',
      'footwear',
      'حذاء',
      'احذية',
      'أحذية',
      'جزمة',
      'جزم',
      'كوتشي',
      'صندل',
    ],
    SHOES,
  ],
  [
    [
      'clothing',
      'clothes',
      'apparel',
      'fashion',
      'dress',
      'dresses',
      'shirt',
      'shirts',
      'tshirt',
      'pants',
      'jeans',
      'jacket',
      'abaya',
      'abayas',
      'hoodie',
      'hoodies',
      'ملابس',
      'لبس',
      'هدوم',
      'فستان',
      'فساتين',
      'قميص',
      'قمصان',
      'بنطلون',
      'عباية',
      'عبايات',
      'جاكيت',
      'تيشيرت',
    ],
    CLOTHING,
  ],
  [
    ['accessories', 'accessory', 'اكسسوارات', 'إكسسوارات', 'اكسسوار'],
    C(167, 'Apparel & Accessories > Clothing Accessories'),
  ],
  [
    ['perfume', 'perfumes', 'fragrance', 'fragrances', 'cologne', 'عطر', 'عطور', 'برفان'],
    C(479, 'Health & Beauty > Personal Care > Cosmetics > Perfume & Cologne'),
  ],
  [
    ['makeup', 'cosmetics', 'مكياج', 'ميك', 'مستحضرات'],
    C(473, 'Health & Beauty > Personal Care > Cosmetics'),
  ],
  [['beauty', 'skincare', 'haircare', 'تجميل', 'جمال', 'عناية'], C(469, 'Health & Beauty')],
  [['health', 'صحة', 'صحي'], C(491, 'Health & Beauty > Health Care')],
  [
    [
      'phone',
      'phones',
      'mobile',
      'mobiles',
      'smartphone',
      'smartphones',
      'موبايل',
      'موبايلات',
      'هاتف',
      'هواتف',
    ],
    C(267, 'Electronics > Communications > Telephony > Mobile Phones'),
  ],
  [['camera', 'cameras', 'كاميرا', 'كاميرات'], C(141, 'Cameras & Optics')],
  [
    [
      'electronics',
      'electronic',
      'gadgets',
      'laptop',
      'laptops',
      'الكترونيات',
      'إلكترونيات',
      'لابتوب',
    ],
    C(222, 'Electronics'),
  ],
  [['furniture', 'sofa', 'sofas', 'أثاث', 'اثاث', 'مفروشات', 'كنب'], C(436, 'Furniture')],
  [['kitchen', 'cookware', 'مطبخ'], C(638, 'Home & Garden > Kitchen & Dining')],
  [
    ['bedding', 'linens', 'blankets', 'مفارش', 'بطاطين', 'لحاف'],
    C(4171, 'Home & Garden > Linens & Bedding'),
  ],
  [['decor', 'decoration', 'ديكور', 'ديكورات'], C(696, 'Home & Garden > Decor')],
  [['home', 'garden', 'منزل', 'البيت', 'بيت', 'حديقة'], C(536, 'Home & Garden')],
  [
    [
      'food',
      'grocery',
      'groceries',
      'snacks',
      'sweets',
      'dates',
      'honey',
      'اكل',
      'أكل',
      'طعام',
      'بقالة',
      'حلويات',
      'تمر',
      'عسل',
    ],
    C(422, 'Food, Beverages & Tobacco > Food Items'),
  ],
  [
    ['beverages', 'drinks', 'coffee', 'tea', 'مشروبات', 'قهوة', 'شاي'],
    C(413, 'Food, Beverages & Tobacco > Beverages'),
  ],
  [['toys', 'toy', 'games', 'game', 'العاب', 'ألعاب', 'لعب'], C(1239, 'Toys & Games')],
  [
    ['baby', 'babies', 'kids', 'children', 'اطفال', 'أطفال', 'بيبي', 'رضع'],
    C(537, 'Baby & Toddler'),
  ],
  [['sports', 'sport', 'fitness', 'gym', 'رياضة', 'رياضي', 'لياقة'], C(988, 'Sporting Goods')],
  [['pet', 'pets', 'حيوانات', 'اليفة', 'أليفة'], C(1, 'Animals & Pet Supplies')],
  [['books', 'book', 'كتب', 'كتاب'], C(784, 'Media > Books')],
  [['office', 'stationery', 'مكتب', 'قرطاسية', 'ادوات مكتبية'], C(922, 'Office Supplies')],
  [['art', 'crafts', 'gifts', 'gift', 'فن', 'هدايا', 'هدية'], C(8, 'Arts & Entertainment')],
];

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** The Google category for one category name/slug, or null. */
export function googleCategoryFor(
  ...labels: Array<string | null | undefined>
): GoogleCategory | null {
  const w = new Set(labels.flatMap(l => (l ? words(l) : [])));
  if (w.size === 0) return null;
  for (const [keys, cat] of TABLE) if (keys.some(k => w.has(k))) return cat;
  return null;
}

/** Apparel (166) feeds need color/size/gender/age_group on free listings; the health report uses this. */
export const isApparel = (c: GoogleCategory | null): boolean =>
  !!c &&
  (c.id === 1604 ||
    c.id === 187 ||
    c.path.startsWith('Apparel & Accessories > Clothing') ||
    c.path.startsWith('Apparel & Accessories > Shoes'));
