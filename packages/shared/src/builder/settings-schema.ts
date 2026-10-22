/**
 * Settings-schema vocabulary for the visual builder (Shopify `schema` /
 * `settings_schema` model). Every section type, block type and the global
 * theme declare their settings with these descriptors; the Phase 2 editor
 * GENERATES its settings panel from them (no hand-built form per section).
 *
 * The descriptor vocabulary (typed prop kinds incl. choice/image/color/slot,
 * defaults, editor-only metadata) is designed after the MIT-licensed
 * `@plasmicapp/host` prop types (packages/host/src/prop-types.ts) and
 * Shopify's input settings. No code is copied: these are Ebda's own types.
 *
 * Validation stays with Zod (`propsSchema` on the registry = the layout PUT
 * schema); `tests/unit/builder-page-definition.test.ts` asserts every field
 * Zod accepts has a descriptor here, so the panel can never miss a field the
 * API stores (the silent-strip class, inverted).
 */
import type { StoreTheme, TemplateId } from '../types/store-theme';
import type { Viewport } from './viewports';

export type SettingType =
  | 'text'
  | 'textarea'
  | 'image'
  | 'video'
  | 'url'
  | 'color'
  | 'select'
  | 'range'
  | 'checkbox'
  // dynamic data pickers: store-scoped references, never copied data
  | 'category'
  | 'product_list'
  // compound editors that already exist in the page builder
  | 'typography'
  | 'dividers';

export interface SettingOption {
  value: string | number;
  labelEn: string;
  labelAr: string;
}

/**
 * When a control is shown (Ruling EP-1): visibility is a declared rule, never a render accident.
 * A rule narrows by the store's resolved `template`, its `look`, and the section's own variant
 * values (`variants: { layout: ['horizontal'] }` = shown while `layout` is `horizontal`). Every
 * key a rule names must hold (AND); a control with a list of rules shows when ANY rule holds
 * (OR). Absent = shown for every template (today's behaviour). Narrow a control only when the
 * flip probe proves the skin or variant ignores it (`scripts/editor-audit`).
 */
export interface ShownRule {
  templates?: readonly TemplateId[];
  looks?: readonly string[];
  variants?: Readonly<Record<string, readonly (string | number | boolean)[]>>;
}
export type ShownFor = ShownRule | readonly ShownRule[];

export interface SettingDefinition {
  id: string;
  type: SettingType;
  labelEn: string;
  labelAr: string;
  /** `content` settings are what a staff editor may change; `design` adds the rest (Webstudio content/design modes). */
  group: 'content' | 'design';
  default?: unknown;
  options?: readonly SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  /** Bilingual: the Arabic value lives at `${id}Ar`; the panel shows both side by side. */
  localized?: boolean;
  /** Viewports this setting may be overridden on (`responsive.<viewport>.settings`). */
  responsive?: readonly Viewport[];
  /** A one-line explanation under the control (bilingual), for a choice with a side effect. */
  hintEn?: string;
  hintAr?: string;
  /** Where the control is shown; absent = everywhere. See `ShownFor`. */
  shownFor?: ShownFor;
}

const opt = (value: string | number, labelEn: string, labelAr: string): SettingOption => ({
  value,
  labelEn,
  labelAr,
});

export const settingFactories = {
  text: (
    id: string,
    labelEn: string,
    labelAr: string,
    extra: Partial<SettingDefinition> = {}
  ): SettingDefinition => ({
    id,
    type: 'text',
    labelEn,
    labelAr,
    group: 'content',
    ...extra,
  }),
  textarea: (
    id: string,
    labelEn: string,
    labelAr: string,
    extra: Partial<SettingDefinition> = {}
  ): SettingDefinition => ({
    id,
    type: 'textarea',
    labelEn,
    labelAr,
    group: 'content',
    ...extra,
  }),
  image: (
    id: string,
    labelEn: string,
    labelAr: string,
    extra: Partial<SettingDefinition> = {}
  ): SettingDefinition => ({
    id,
    type: 'image',
    labelEn,
    labelAr,
    group: 'content',
    ...extra,
  }),
  /** A video URL (mp4/webm, <= 6 MB) uploaded via `POST /uploads/video`. */
  video: (
    id: string,
    labelEn: string,
    labelAr: string,
    extra: Partial<SettingDefinition> = {}
  ): SettingDefinition => ({
    id,
    type: 'video',
    labelEn,
    labelAr,
    group: 'content',
    ...extra,
  }),
  url: (id: string, labelEn: string, labelAr: string): SettingDefinition => ({
    id,
    type: 'url',
    labelEn,
    labelAr,
    group: 'content',
  }),
  color: (id: string, labelEn: string, labelAr: string): SettingDefinition => ({
    id,
    type: 'color',
    labelEn,
    labelAr,
    group: 'design',
  }),
  check: (
    id: string,
    labelEn: string,
    labelAr: string,
    group: 'content' | 'design' = 'design'
  ): SettingDefinition => ({
    id,
    type: 'checkbox',
    labelEn,
    labelAr,
    group,
  }),
  range: (
    id: string,
    labelEn: string,
    labelAr: string,
    min: number,
    max: number,
    step = 1,
    group: 'content' | 'design' = 'content'
  ): SettingDefinition => ({ id, type: 'range', labelEn, labelAr, group, min, max, step }),
  select: (
    id: string,
    labelEn: string,
    labelAr: string,
    options: readonly SettingOption[],
    extra: Partial<SettingDefinition> = {}
  ): SettingDefinition => ({
    id,
    type: 'select',
    labelEn,
    labelAr,
    group: 'design',
    options,
    ...extra,
  }),
};

const SIZES = [
  opt('xxs', 'XXS', 'صغير جداً جداً'),
  opt('xs', 'XS', 'صغير جداً'),
  opt('sm', 'Small', 'صغير'),
  opt('md', 'Medium', 'متوسط'),
  opt('lg', 'Large', 'كبير'),
  opt('xl', 'XL', 'كبير جداً'),
];
const ASPECTS = [
  opt('theme', 'Theme default', 'حسب القالب'),
  opt('square', 'Square', 'مربع'),
  opt('portrait', 'Portrait', 'طولي'),
  opt('landscape', 'Landscape', 'عرضي'),
  opt('wide', 'Wide', 'عريض'),
  opt('ultrawide', 'Ultra wide', 'عريض جداً'),
];
const SHAPES = [
  opt('theme', 'Theme default', 'حسب القالب'),
  opt('circle', 'Circle', 'دائري'),
  opt('rounded-square', 'Rounded square', 'مربع بحواف دائرية'),
  opt('square', 'Square', 'مربع'),
  opt('soft', 'Soft', 'ناعم'),
  opt('portrait', 'Portrait', 'طولي'),
  opt('landscape', 'Landscape', 'عرضي'),
  opt('pill', 'Pill', 'كبسولة'),
];
const GAPS = [
  opt('tight', 'Tight', 'ضيق'),
  opt('normal', 'Normal', 'عادي'),
  opt('loose', 'Loose', 'واسع'),
  opt('xloose', 'Extra loose', 'واسع جداً'),
];
const PADDING = [opt('none', 'None', 'بدون'), ...GAPS];

/** Padding + width. Visibility is NOT a setting: it is `hidden` / `responsive.<viewport>.hidden`. */
export const spacingSettings = (): SettingDefinition[] => [
  settingFactories.select('paddingTop', 'Top spacing', 'المسافة العلوية', PADDING),
  settingFactories.select('paddingBottom', 'Bottom spacing', 'المسافة السفلية', PADDING),
  settingFactories.select('maxWidth', 'Width', 'العرض', [
    opt('contained', 'Contained', 'محدود'),
    opt('full', 'Full width', 'كامل العرض'),
  ]),
];

export const styleSettings = (): SettingDefinition[] => [
  settingFactories.color('bgColor', 'Background', 'الخلفية'),
  {
    id: 'typography',
    type: 'typography',
    labelEn: 'Typography',
    labelAr: 'الخطوط',
    group: 'design',
  },
  { id: 'dividers', type: 'dividers', labelEn: 'Dividers', labelAr: 'الفواصل', group: 'design' },
  ...spacingSettings(),
];

export const headingSettings = (withKicker = true): SettingDefinition[] => [
  settingFactories.text('title', 'Heading', 'العنوان', { localized: true }),
  ...(withKicker
    ? [
        settingFactories.text('kicker', 'Label above heading', 'نص فوق العنوان', {
          localized: true,
        }),
        settingFactories.text('subtitle', 'Subheading', 'العنوان الفرعي', { localized: true }),
        settingFactories.check('showKickerLines', 'Lines beside label', 'خطوط بجانب النص'),
        settingFactories.check(
          'showSubtitleLines',
          'Lines beside subheading',
          'خطوط بجانب العنوان الفرعي'
        ),
      ]
    : []),
];

export const cardSettings = (): SettingDefinition[] => [
  settingFactories.select('cardSize', 'Card size', 'حجم البطاقة', SIZES),
  settingFactories.select('cardAspect', 'Card shape ratio', 'نسبة البطاقة', ASPECTS),
  settingFactories.select('cardShape', 'Card shape', 'شكل البطاقة', SHAPES),
  settingFactories.select('cardGap', 'Space between cards', 'المسافة بين البطاقات', GAPS),
  settingFactories.check('showLabel', 'Show name', 'إظهار الاسم'),
  settingFactories.check('showHover', 'Hover effect', 'تأثير التمرير'),
  settingFactories.check('showCardFrame', 'Card frame', 'إطار البطاقة'),
  settingFactories.select('cardFrameStyle', 'Frame style', 'نمط الإطار', [
    opt('soft', 'Soft', 'ناعم'),
    opt('outline', 'Outline', 'حدود'),
    opt('shadow', 'Shadow', 'ظل'),
    opt('paper', 'Paper', 'ورقي'),
  ]),
  settingFactories.select('cardFrameWidth', 'Frame thickness', 'سماكة الإطار', [
    opt('thin', 'Thin', 'رفيع'),
    opt('normal', 'Normal', 'عادي'),
    opt('thick', 'Thick', 'سميك'),
    opt('xthick', 'Extra thick', 'سميك جداً'),
  ]),
  settingFactories.select('cardFrameSize', 'Frame padding', 'حشوة الإطار', [
    opt('compact', 'Compact', 'مضغوط'),
    opt('normal', 'Normal', 'عادي'),
    opt('comfortable', 'Comfortable', 'مريح'),
    opt('spacious', 'Spacious', 'واسع'),
  ]),
  settingFactories.color('cardFrameColor', 'Frame colour', 'لون الإطار'),
];

export const SETTING_OPTIONS = { SIZES, ASPECTS, SHAPES, GAPS, PADDING, opt };

/**
 * Global THEME settings (Shopify `settings_schema.json`): colours,
 * typography, buttons, spacing/background. These live on the store theme
 * (`stores.theme`, written by the theme PUT — its own single writer), not in
 * a page document; sections reference them as `token:<name>`. Typed against
 * `StoreTheme`, so a renamed theme key is a compile error here.
 */
export interface ThemeSettingDefinition extends Omit<SettingDefinition, 'id' | 'group'> {
  id: keyof StoreTheme;
}
export interface ThemeSettingsGroup {
  id: 'header' | 'colors' | 'typography' | 'buttons' | 'cards' | 'spacing';
  labelEn: string;
  labelAr: string;
  settings: ThemeSettingDefinition[];
}

const themeColor = (
  id: keyof StoreTheme,
  labelEn: string,
  labelAr: string
): ThemeSettingDefinition => ({
  id,
  type: 'color',
  labelEn,
  labelAr,
});

export const THEME_SETTINGS_SCHEMA: readonly ThemeSettingsGroup[] = [
  // First, like the header is on the storefront (the admin mirrors the storefront top to bottom).
  {
    id: 'header',
    labelEn: 'Header',
    labelAr: 'الهيدر',
    settings: [
      {
        id: 'headerLogoPlacement',
        type: 'select',
        labelEn: 'Logo position',
        labelAr: 'مكان الشعار',
        options: [opt('start', 'Start', 'في البداية'), opt('centre', 'Centre', 'في المنتصف')],
        // the headers built on the shared minimal header read it
        shownFor: { templates: ['qamar', 'souq', 'jasmine', 'lamma'] },
      },
      {
        id: 'headerSearch',
        type: 'select',
        labelEn: 'Search',
        labelAr: 'البحث',
        options: [
          opt('prominent', 'Search field', 'خانة بحث ظاهرة'),
          opt('icon', 'Icon', 'أيقونة'),
        ],
        // only the Souq header turns the search into a field
        shownFor: { templates: ['souq'] },
      },
    ],
  },
  {
    id: 'colors',
    labelEn: 'Colours',
    labelAr: 'الألوان',
    settings: [
      themeColor('primaryColor', 'Primary', 'الأساسي'),
      themeColor('secondaryColor', 'Secondary', 'الثانوي'),
      themeColor('accentColor', 'Accent', 'المميز'),
      themeColor('backgroundColor', 'Background', 'الخلفية'),
      themeColor('foregroundColor', 'Text', 'النص'),
      themeColor('mutedColor', 'Muted', 'الخافت'),
      themeColor('borderColor', 'Borders', 'الحدود'),
      themeColor('cardColor', 'Cards', 'البطاقات'),
    ],
  },
  {
    id: 'typography',
    labelEn: 'Typography',
    labelAr: 'الخطوط',
    settings: [
      {
        id: 'fontFamily',
        type: 'select',
        labelEn: 'Font style',
        labelAr: 'نمط الخط',
        options: [
          opt('default', 'Default', 'افتراضي'),
          opt('serif', 'Serif', 'مذيل'),
          opt('modern', 'Modern', 'حديث'),
          opt('rounded', 'Rounded', 'دائري'),
        ],
      },
      { id: 'headingFont', type: 'text', labelEn: 'Heading font', labelAr: 'خط العناوين' },
      { id: 'bodyFont', type: 'text', labelEn: 'Body font', labelAr: 'خط النص' },
      {
        id: 'uppercaseStyle',
        type: 'checkbox',
        labelEn: 'Uppercase headings',
        labelAr: 'عناوين بأحرف كبيرة',
      },
      {
        id: 'arabicNumerals',
        type: 'checkbox',
        // Ruling NUMERALS-1: unchecked = Western 123 (default, both languages).
        labelEn: 'Store numerals: ١٢٣ on Arabic pages (default 123)',
        labelAr: 'شكل الأرقام في المتجر: ١٢٣ في الصفحات العربية (الافتراضي 123)',
      },
    ],
  },
  {
    id: 'buttons',
    labelEn: 'Buttons and corners',
    labelAr: 'الأزرار والحواف',
    settings: [
      {
        id: 'borderRadius',
        type: 'select',
        labelEn: 'Corner radius',
        labelAr: 'استدارة الحواف',
        options: [
          opt('none', 'None', 'بدون'),
          opt('sm', 'Small', 'صغيرة'),
          opt('md', 'Medium', 'متوسطة'),
          opt('lg', 'Large', 'كبيرة'),
          opt('xl', 'Extra large', 'كبيرة جداً'),
        ],
      },
    ],
  },
  {
    // Merchant switches the form page builder used to own (Ruling VE-17). None is look-owned: a look
    // switch (keep or reset) never touches them. Their readers are the shared and per-skin product
    // cards, so none is narrowed with `shownFor`.
    id: 'cards',
    labelEn: 'Product cards',
    labelAr: 'كروت المنتجات',
    settings: [
      {
        id: 'showBrandBadge',
        type: 'checkbox',
        labelEn: 'Store name on cards',
        labelAr: 'اسم المتجر على كل كارت',
        hintEn: 'A small pill with the store name in the corner of every product card.',
        hintAr: 'كبسولة صغيرة باسم المتجر في ركن كل كارت منتج.',
      },
      {
        id: 'showNewBadge',
        type: 'checkbox',
        labelEn: '"New" badge on cards',
        labelAr: 'شارة «جديد» على الكروت',
        hintEn:
          'A "New" chip on products you mark as new or added in the last 14 days. Off by default.',
        hintAr: 'بتظهر على المنتجات اللي علّمتها جديدة أو اتضافت في آخر 14 يوم. مقفولة في الأول.',
      },
      {
        id: 'showQuickAdd',
        type: 'checkbox',
        labelEn: 'Quick add (+) on carousel cards',
        labelAr: 'إضافة سريعة (+) على كروت الكاروسيل',
        hintEn:
          'A one-tap add-to-cart circle. When on, the Add to cart button under the same card is hidden.',
        hintAr:
          'دايرة بتضيف للسلة بلمسة واحدة. لما تتفعّل، زرار «أضف للسلة» اللي تحت الكارت بيختفي.',
      },
      {
        id: 'normalizeProductImages',
        type: 'checkbox',
        labelEn: 'Even product image sizes',
        labelAr: 'توحيد مقاسات صور المنتجات',
        hintEn:
          'Every card image fills its frame the same way. The photos themselves are never changed; turn it off to go back.',
        hintAr:
          'كل صور الكروت بتملى إطارها بنفس الشكل. الصور نفسها مبتتغيرش، ولو قفلته بترجع زي ما كانت.',
      },
      {
        id: 'saleBadgeLegacyCorner',
        type: 'checkbox',
        labelEn: 'Keep the old sale badge corner',
        labelAr: 'شارة الخصم في الركن القديم',
        hintEn:
          'Off (recommended): the sale badge sits in the top corner so the Add to cart bar never covers it. On: it stays bottom-left as before.',
        hintAr:
          'مقفول (الأفضل): الشارة في ركن الصورة العلوي فمتتغطاش بزرار الإضافة. مفتوح: بتفضل تحت على الشمال زي الأول.',
      },
    ],
  },
  {
    id: 'spacing',
    labelEn: 'Background and rhythm',
    labelAr: 'الخلفية والإيقاع',
    settings: [
      {
        id: 'backgroundPreset',
        type: 'select',
        labelEn: 'Section backgrounds',
        labelAr: 'خلفيات الأقسام',
        options: [
          opt('none', 'None', 'بدون'),
          opt('warmSand', 'Warm sand', 'رملي دافئ'),
          opt('coolGrey', 'Cool grey', 'رمادي'),
          opt('pureWhite', 'White', 'أبيض'),
          opt('brandColor', 'Brand colour', 'لون العلامة'),
        ],
      },
      themeColor('bgPage', 'Page background', 'خلفية الصفحة'),
      themeColor('bgSectionAlt', 'Alternate section background', 'خلفية الأقسام البديلة'),
    ],
  },
];
