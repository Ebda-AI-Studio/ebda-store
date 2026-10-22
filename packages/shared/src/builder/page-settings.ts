/**
 * Page-type settings (Task 8e): the non-section layout keys the old page builder edited (sizing, the product,
 * collection, cart, checkout and locations page surfaces, filters, reviews, the bottom bar, card defaults),
 * described with the same `SettingDefinition` vocabulary the section panel is generated from.
 *
 * Who writes what (Ruling VE-13, one layer owns each write):
 *   - the HOME document owns `sizing`, `bottomBar`, `locationsPage` and `productCardDefaults` (a look switch
 *     rewrites `productCardDefaults`, so a second writer would race it);
 *   - a product / collection / cart document owns the keys listed in `PAGE_OWNED_SETTING_KEYS`; publishing
 *     that page writes exactly those keys into `layout_settings`, and publishing home leaves them alone.
 * Every key is validated by `storeLayoutSchema` on write, like the layout PUT.
 */
import type { PageKind, SectionPageKind } from './page-kinds';
import {
  SETTING_OPTIONS,
  settingFactories as f,
  cardSettings,
  type SettingDefinition,
} from './settings-schema';

const { opt } = SETTING_OPTIONS;

export interface PageSettingsGroup {
  /** The `siteSettings` key. */
  key: string;
  labelEn: string;
  labelAr: string;
  /** `id` is the path inside the key (`bgColor`, or `discountBadge.position` one level down). */
  settings: SettingDefinition[];
}

/** The layout keys a product / collection / cart document owns. */
export const PAGE_OWNED_SETTING_KEYS: Record<SectionPageKind, readonly string[]> = {
  product: ['productDetailPage', 'reviewSection'],
  collection: ['productsPage', 'filterSidebar', 'categoriesPage'],
  cart: ['cartPage', 'checkoutPage'],
};

/** Every key owned by a section page (the home document leaves these to their page). */
export const ALL_PAGE_OWNED_KEYS: ReadonlySet<string> = new Set(
  Object.values(PAGE_OWNED_SETTING_KEYS).flat()
);

const surface = (extra: SettingDefinition[] = []): SettingDefinition[] => [
  f.color('bgColor', 'Page background', 'خلفية الصفحة'),
  f.select('colorScheme', 'Colour scheme', 'نمط الألوان', [
    opt('auto', 'Automatic', 'تلقائي'),
    opt('light', 'Light', 'فاتح'),
    opt('dark', 'Dark', 'داكن'),
  ]),
  f.select('density', 'Spacing', 'المسافات', [
    opt('compact', 'Compact', 'مضغوط'),
    opt('normal', 'Normal', 'عادي'),
    opt('spacious', 'Spacious', 'واسع'),
  ]),
  f.select('textScale', 'Text size', 'حجم النص', [
    opt('sm', 'Small', 'صغير'),
    opt('normal', 'Normal', 'عادي'),
    opt('lg', 'Large', 'كبير'),
    opt('xl', 'Extra large', 'كبير جداً'),
  ]),
  ...extra,
];

const imageAspect = () =>
  f.select('imageAspect', 'Photo shape', 'شكل الصور', [
    opt('square', 'Square', 'مربع'),
    opt('portrait', 'Portrait', 'طولي'),
    opt('landscape', 'Landscape', 'عرضي'),
    opt('wide', 'Wide', 'عريض'),
    opt('ultrawide', 'Ultra wide', 'عريض جداً'),
    opt('auto', 'Automatic', 'تلقائي'),
  ]);

const cornerOptions = [
  opt('top-left', 'Top left', 'أعلى اليسار'),
  opt('top-right', 'Top right', 'أعلى اليمين'),
  opt('bottom-left', 'Bottom left', 'أسفل اليسار'),
  opt('bottom-right', 'Bottom right', 'أسفل اليمين'),
];
const shapeOptions = [
  opt('rounded', 'Rounded', 'حواف دائرية'),
  opt('pill', 'Pill', 'كبسولة'),
  opt('square', 'Square', 'مربع'),
  opt('soft', 'Soft', 'ناعم'),
];

/** The card controls that apply everywhere (listing, search, related), beyond the per-section subset. */
const cardDefaultSettings = (): SettingDefinition[] => [
  ...cardSettings(),
  f.select('cardImageAspect', 'Photo ratio', 'نسبة الصورة', [
    opt('1:1', '1:1', '1:1'),
    opt('4:5', '4:5', '4:5'),
    opt('3:4', '3:4', '3:4'),
    opt('16:9', '16:9', '16:9'),
    opt('auto', 'Automatic', 'تلقائي'),
  ]),
  f.select('cardImageRadius', 'Photo corners', 'حواف الصورة', [
    opt('none', 'Square', 'حادة'),
    opt('sm', 'Slight', 'خفيفة'),
    opt('md', 'Medium', 'متوسطة'),
    opt('lg', 'Large', 'كبيرة'),
    opt('full', 'Full', 'دائرية'),
  ]),
  f.check('showCardName', 'Show product name', 'إظهار اسم المنتج'),
  f.check('showCardPrice', 'Show price', 'إظهار السعر'),
  f.select('productNameCase', 'Name letters', 'حروف الاسم', [
    opt('normal', 'As typed', 'زي ما اتكتب'),
    opt('uppercase', 'Capitals', 'حروف كبيرة'),
  ]),
  f.select('ctaMode', 'Card button', 'زر البطاقة', [
    opt('auto', 'View, or add to cart', 'عرض أو إضافة للسلة'),
    opt('viewOnly', 'View only', 'عرض فقط'),
  ]),
  f.check('ctaLabel', 'Button label', 'نص الزر'),
  f.text('ctaLabelTextEn', 'Button text (English)', 'نص الزر (إنجليزي)'),
  f.text('ctaLabelTextAr', 'Button text (Arabic)', 'نص الزر (عربي)'),
  f.select('ctaSize', 'Button size', 'حجم الزر', [
    opt('sm', 'Small', 'صغير'),
    opt('md', 'Medium', 'متوسط'),
    opt('lg', 'Large', 'كبير'),
  ]),
  f.select('ctaShape', 'Button shape', 'شكل الزر', shapeOptions),
  f.color('ctaColor', 'Button colour', 'لون الزر'),
  f.color('ctaTextColor', 'Button text colour', 'لون نص الزر'),
  f.check('oosLabel', 'Sold-out label', 'علامة نفد'),
  f.text('oosLabelTextEn', 'Sold-out text (English)', 'نص نفد (إنجليزي)'),
  f.text('oosLabelTextAr', 'Sold-out text (Arabic)', 'نص نفد (عربي)'),
  f.select('oosLabelShape', 'Sold-out label shape', 'شكل علامة نفد', shapeOptions),
  f.select('oosLabelPlacement', 'Sold-out label place', 'مكان علامة نفد', [
    opt('top-start', 'Top start', 'أعلى البداية'),
    opt('top-end', 'Top end', 'أعلى النهاية'),
    opt('bottom-start', 'Bottom start', 'أسفل البداية'),
    opt('bottom-end', 'Bottom end', 'أسفل النهاية'),
  ]),
  f.color('oosLabelColor', 'Sold-out label colour', 'لون علامة نفد'),
  f.color('oosLabelTextColor', 'Sold-out text colour', 'لون نص علامة نفد'),
  f.color('oosDimColor', 'Sold-out dimming', 'لون تعتيم نفد'),
  f.select('discountBadge.position', 'Discount badge corner', 'ركن شارة الخصم', cornerOptions),
  f.color('discountBadge.color', 'Discount badge colour', 'لون شارة الخصم'),
  f.select('customBadge.position', 'Custom badge corner', 'ركن الشارة المخصصة', cornerOptions),
  f.color('customBadge.color', 'Custom badge colour', 'لون الشارة المخصصة'),
];

export const PAGE_SETTINGS: Record<PageKind, PageSettingsGroup[]> = {
  home: [
    {
      key: 'sizing',
      labelEn: 'Image shapes',
      labelAr: 'أشكال الصور',
      settings: [
        f.select('heroAspect', 'Hero banner', 'بانر الرئيسية', [
          opt('2.45:1', 'Wide 2.45:1', 'عريض 2.45:1'),
          opt('16:9', '16:9', '16:9'),
          opt('4:3', '4:3', '4:3'),
        ]),
        f.select('productImageAspect', 'Product photos', 'صور المنتجات', [
          opt('1:1', '1:1', '1:1'),
          opt('3:4', '3:4', '3:4'),
        ]),
        f.select('categoryImageAspect', 'Category photos', 'صور التصنيفات', [
          opt('1:1', '1:1', '1:1'),
          opt('3:4', '3:4', '3:4'),
          opt('2:3', '2:3', '2:3'),
        ]),
      ],
    },
    {
      key: 'productCardDefaults',
      labelEn: 'Product cards everywhere',
      labelAr: 'بطاقات المنتجات في كل المتجر',
      settings: cardDefaultSettings(),
    },
    {
      key: 'bottomBar',
      labelEn: 'Phone bottom bar',
      labelAr: 'الشريط السفلي في الموبايل',
      settings: [
        f.color('bgColor', 'Background', 'الخلفية'),
        f.color('activeColor', 'Active icon', 'الأيقونة النشطة'),
        f.color('inactiveColor', 'Other icons', 'باقي الأيقونات'),
      ],
    },
    {
      key: 'locationsPage',
      labelEn: 'Locations page',
      labelAr: 'صفحة الفروع',
      settings: surface(),
    },
  ],
  product: [
    {
      key: 'productDetailPage',
      labelEn: 'Product page',
      labelAr: 'صفحة المنتج',
      settings: surface([imageAspect()]),
    },
    {
      key: 'reviewSection',
      labelEn: 'Reviews',
      labelAr: 'التقييمات',
      settings: [
        f.check(
          'enabled',
          'Show reviews on the product page',
          'إظهار التقييمات في صفحة المنتج',
          'content'
        ),
      ],
    },
  ],
  collection: [
    {
      key: 'productsPage',
      labelEn: 'Products page',
      labelAr: 'صفحة المنتجات',
      settings: surface(),
    },
    {
      key: 'filterSidebar',
      labelEn: 'Filters',
      labelAr: 'الفلاتر',
      settings: [
        {
          ...f.check('enabled', 'Show the filter panel', 'إظهار لوحة الفلاتر', 'content'),
          default: true,
        },
        {
          ...f.check('defaultOpen', 'Open by default', 'تكون مفتوحة من الأول', 'content'),
          default: true,
        },
        f.color('bgColor', 'Filter panel background', 'خلفية لوحة الفلاتر'),
        f.color('textColor', 'Filter panel text', 'لون نص لوحة الفلاتر'),
      ],
    },
    {
      key: 'categoriesPage',
      labelEn: 'Categories page',
      labelAr: 'صفحة التصنيفات',
      settings: surface(),
    },
  ],
  cart: [
    { key: 'cartPage', labelEn: 'Cart', labelAr: 'السلة', settings: surface() },
    { key: 'checkoutPage', labelEn: 'Checkout', labelAr: 'إتمام الطلب', settings: surface() },
  ],
};

/**
 * Keys whose layout schema is all-or-nothing: the first write to one that is absent starts from these values
 * (the template baseline's), so a single toggle never produces an invalid object.
 */
export const GROUP_FLOORS: Record<string, Record<string, unknown>> = {
  filterSidebar: { enabled: true, defaultOpen: true },
};

/** The setting a `(key, path)` pair names on this page, or undefined (an unknown or foreign one). */
export function pageSettingFor(
  pageKey: string,
  key: string,
  path: string
): SettingDefinition | undefined {
  const kind = (pageKey in PAGE_SETTINGS ? pageKey : 'home') as PageKind;
  return PAGE_SETTINGS[kind].find(g => g.key === key)?.settings.find(s => s.id === path);
}

/** The owned keys of `layout` for one section page: what a fresh document for it holds. */
export function pickOwnedSettings(
  kind: SectionPageKind,
  layout: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PAGE_OWNED_SETTING_KEYS[kind])
    if (layout && layout[k] !== undefined) out[k] = layout[k];
  return out;
}
