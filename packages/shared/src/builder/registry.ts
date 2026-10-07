/**
 * Section + block registry (visual builder Phase 1, Shopify-theme-editor model).
 *
 * One entry per section TYPE a `PageDefinition` may contain. Each declares:
 *   - `settings`  : the settings schema that drives the editor panel
 *                   (`settings-schema.ts`);
 *   - `blocks`    : the block types it accepts, each with its own settings
 *                   schema and a max count (hero -> `slide`);
 *   - `presets`   : what "Add section" inserts (name + starting settings);
 *   - `group`     : `header` / `footer` section group, or the page `template`;
 *   - `responsive`: which viewports may hide it, which settings vary per viewport;
 *   - `propsSchema`: the Zod VALIDATOR — the same schema the layout PUT uses
 *                   (`storeLayoutSchema.shape[legacyKey]`), applied to the
 *                   reconstructed legacy object.
 *
 * Phase 1 covers exactly the sections the storefront already renders (no new
 * renderers), so every entry maps onto a legacy layout key (`legacyKey`).
 * Adding a section type is a registry entry, not three hand-kept key lists.
 */
import { z } from 'zod';
import { storeLayoutSchema } from './layout-schema';
import { DEFAULT_LAYOUT_SETTINGS } from '../types/store-layout';
import type { LegacyHomeSectionKey } from './section-keys';
import { VIEWPORTS, type Viewport } from './viewports';
import {
  SETTING_OPTIONS,
  cardSettings,
  headingSettings,
  settingFactories as s,
  styleSettings,
  type SettingDefinition,
} from './settings-schema';

export { VIEWPORTS, VIEWPORT_RANGES, type Viewport } from './viewports';

/** Where a section lives: a shared section group, or the page template. */
export type SectionGroup = 'header' | 'template' | 'footer';

/** Layout keys a registry entry can project onto. */
export type LegacyLayoutKey = LegacyHomeSectionKey | 'announcement' | 'header' | 'footer';

export interface BlockDefinition {
  type: string;
  labelEn: string;
  labelAr: string;
  maxCount: number;
  settings: readonly SettingDefinition[];
}

export interface SectionPreset {
  nameEn: string;
  nameAr: string;
  settings: Record<string, unknown>;
  blocks?: Array<{ type: string; settings: Record<string, unknown> }>;
}

export interface SectionDefinition {
  type: string;
  labelEn: string;
  labelAr: string;
  /** Key in the legacy layout. Product carousels use `'extraCarousels'`. */
  legacyKey: LegacyLayoutKey | 'extraCarousels';
  /** Storefront renderer the web app maps this type onto. */
  rendererKey: string;
  group: SectionGroup;
  cardinality: 'one' | 'many';
  maxCount: number;
  settings: readonly SettingDefinition[];
  blocks: readonly BlockDefinition[];
  presets: readonly SectionPreset[];
  responsive: {
    hidden: readonly Viewport[];
    settings: Partial<Record<Viewport, readonly string[]>>;
  };
  /** Validates the reconstructed legacy section object. */
  propsSchema: z.ZodTypeAny;
}

const shape = storeLayoutSchema.shape;
const unwrap = (x: z.ZodTypeAny): z.ZodTypeAny =>
  x instanceof z.ZodOptional ? unwrap(x.unwrap()) : x;
const extraCarouselSchema = (unwrap(shape.extraCarousels) as z.ZodArray<z.ZodTypeAny>).element;
const { opt } = SETTING_OPTIONS;
const PACKAGED = DEFAULT_LAYOUT_SETTINGS as unknown as Record<
  string,
  Record<string, unknown> | undefined
>;

const ALL: readonly Viewport[] = VIEWPORTS;

function def(
  d: Omit<
    SectionDefinition,
    'propsSchema' | 'maxCount' | 'cardinality' | 'blocks' | 'responsive' | 'presets'
  > &
    Partial<
      Pick<SectionDefinition, 'cardinality' | 'maxCount' | 'blocks' | 'responsive' | 'presets'>
    >
): SectionDefinition {
  const key = d.legacyKey;
  return {
    cardinality: 'one',
    maxCount: 1,
    blocks: [],
    responsive: { hidden: ALL, settings: {} },
    // Default preset = the packaged defaults for the section (DEFAULT_LAYOUT_SETTINGS).
    presets: [{ nameEn: d.labelEn, nameAr: d.labelAr, settings: { ...(PACKAGED[key] ?? {}) } }],
    ...d,
    propsSchema: key === 'extraCarousels' ? extraCarouselSchema : unwrap(shape[key]),
  };
}

export const HERO_SLIDE_BLOCK: BlockDefinition = {
  type: 'slide',
  labelEn: 'Slide',
  labelAr: 'شريحة',
  // Same cap as the layout schema (`hero.slides.max(10)`).
  maxCount: 10,
  settings: [
    s.image('image', 'Image', 'الصورة', { localized: true }),
    s.image('imageMobile', 'Mobile image', 'صورة الجوال', { localized: true }),
    s.text('alt', 'Image description', 'وصف الصورة'),
    s.text('headline', 'Headline', 'العنوان', { localized: true }),
    s.text('ctaText', 'Button text', 'نص الزر', { localized: true }),
    s.url('ctaHref', 'Button link', 'رابط الزر'),
    s.url('link', 'Whole-slide link', 'رابط الشريحة'),
  ],
};

const carouselLimit = (max: number) => s.range('limit', 'Products to show', 'عدد المنتجات', 1, max);

export const SECTION_REGISTRY: readonly SectionDefinition[] = [
  def({
    type: 'announcement',
    labelEn: 'Announcement bar',
    labelAr: 'شريط الإعلانات',
    legacyKey: 'announcement',
    rendererKey: 'chrome.announcement',
    group: 'header',
    settings: styleSettings(),
  }),
  def({
    type: 'header',
    labelEn: 'Header',
    labelAr: 'الترويسة',
    legacyKey: 'header',
    rendererKey: 'chrome.header',
    group: 'header',
    settings: [s.check('sticky', 'Sticky header', 'ترويسة ثابتة'), ...styleSettings()],
  }),
  def({
    type: 'hero',
    labelEn: 'Hero banner',
    labelAr: 'البانر الرئيسي',
    legacyKey: 'hero',
    rendererKey: 'home.hero',
    group: 'template',
    blocks: [HERO_SLIDE_BLOCK],
    presets: [
      {
        nameEn: 'Slideshow',
        nameAr: 'عرض شرائح',
        settings: { mode: 'slider', autoplayMs: 5000 },
        blocks: [],
      },
      {
        nameEn: 'Single banner',
        nameAr: 'بانر واحد',
        settings: { mode: 'single', autoplayMs: 5000 },
        blocks: [],
      },
    ],
    settings: [
      s.select(
        'mode',
        'Layout',
        'التخطيط',
        [opt('single', 'Single banner', 'بانر واحد'), opt('slider', 'Slideshow', 'عرض شرائح')],
        {
          group: 'content',
        }
      ),
      s.range(
        'autoplayMs',
        'Slide duration (ms)',
        'مدة الشريحة (ملي ثانية)',
        1000,
        30000,
        500,
        'design'
      ),
      s.select('presentation', 'Presentation', 'طريقة العرض', [
        opt('full-bleed', 'Full bleed', 'بعرض الشاشة'),
        opt('framed', 'Framed', 'داخل إطار'),
      ]),
      ...styleSettings(),
    ],
  }),
  def({
    type: 'category-grid',
    labelEn: 'Categories',
    labelAr: 'الفئات',
    legacyKey: 'categories',
    rendererKey: 'home.categories',
    group: 'template',
    // The storefront already renders a separate mobile layout + caption.
    responsive: { hidden: ALL, settings: { mobile: ['layout', 'captionPosition'] } },
    settings: [
      ...headingSettings(),
      s.select(
        'layout',
        'Layout',
        'التخطيط',
        [opt('grid', 'Grid', 'شبكة'), opt('horizontal', 'Scrolling row', 'صف متحرك')],
        {
          responsive: ['mobile'],
        }
      ),
      s.select(
        'captionPosition',
        'Name position',
        'موضع الاسم',
        [opt('below', 'Below', 'أسفل'), opt('overlay', 'On image', 'على الصورة')],
        {
          responsive: ['mobile'],
        }
      ),
      s.select('desktopColumns', 'Columns (desktop)', 'الأعمدة (سطح المكتب)', [
        opt(2, '2', '٢'),
        opt(3, '3', '٣'),
        opt(4, '4', '٤'),
      ]),
      s.select('mobileColumns', 'Columns (mobile)', 'الأعمدة (الجوال)', [
        opt(1, '1', '١'),
        opt(2, '2', '٢'),
        opt(3, '3', '٣'),
      ]),
      ...cardSettings(),
      ...styleSettings(),
    ],
  }),
  def({
    type: 'new-arrivals',
    labelEn: 'New arrivals',
    labelAr: 'أحدث المنتجات',
    legacyKey: 'newArrivals',
    rendererKey: 'home.newArrivals',
    group: 'template',
    settings: [...headingSettings(), carouselLimit(48), ...cardSettings(), ...styleSettings()],
  }),
  def({
    type: 'best-sellers',
    labelEn: 'Best sellers',
    labelAr: 'الأكثر مبيعاً',
    legacyKey: 'bestSellers',
    rendererKey: 'home.bestSellers',
    group: 'template',
    settings: [...headingSettings(), carouselLimit(48), ...cardSettings(), ...styleSettings()],
  }),
  def({
    type: 'brand-story',
    labelEn: 'Brand story',
    labelAr: 'قصة العلامة',
    legacyKey: 'brandStory',
    rendererKey: 'home.brandStory',
    group: 'template',
    settings: styleSettings(),
  }),
  def({
    type: 'blog-carousel',
    labelEn: 'Blog posts',
    labelAr: 'المدونة',
    legacyKey: 'blogCarousel',
    rendererKey: 'home.blogCarousel',
    group: 'template',
    settings: [s.range('limit', 'Posts to show', 'عدد المقالات', 1, 20), ...styleSettings()],
  }),
  def({
    type: 'trust-strip',
    labelEn: 'Trust strip',
    labelAr: 'شريط الثقة',
    legacyKey: 'trustStrip',
    rendererKey: 'home.trustStrip',
    group: 'template',
    settings: [
      s.select('layout', 'Layout', 'التخطيط', [
        opt('horizontal', 'Row', 'صف'),
        opt('vertical', 'Stacked', 'عمودي'),
      ]),
      s.select('size', 'Size', 'الحجم', [
        opt('sm', 'Small', 'صغير'),
        opt('md', 'Medium', 'متوسط'),
        opt('lg', 'Large', 'كبير'),
      ]),
      s.color('iconColor', 'Icon colour', 'لون الأيقونة'),
      s.color('iconBgColor', 'Icon background', 'خلفية الأيقونة'),
      s.color('textColor', 'Text colour', 'لون النص'),
      ...styleSettings(),
    ],
  }),
  def({
    type: 'testimonials',
    labelEn: 'Customer reviews',
    labelAr: 'آراء العملاء',
    legacyKey: 'testimonials',
    rendererKey: 'home.testimonials',
    group: 'template',
    settings: [
      ...headingSettings(false),
      s.range('minRating', 'Minimum rating', 'أقل تقييم', 1, 5),
      s.check('verifiedOnly', 'Verified purchases only', 'مشتريات موثقة فقط', 'content'),
      ...styleSettings(),
    ],
  }),
  def({
    type: 'product-carousel',
    labelEn: 'Product carousel',
    labelAr: 'شريط منتجات',
    legacyKey: 'extraCarousels',
    rendererKey: 'home.productCarousel',
    group: 'template',
    cardinality: 'many',
    // Same cap as the layout schema (`extraCarousels.max(8)`).
    maxCount: 8,
    presets: [
      {
        nameEn: 'Newest products',
        nameAr: 'أحدث المنتجات',
        settings: { productSource: 'newest', limit: 12 },
      },
      {
        nameEn: 'From a category',
        nameAr: 'من فئة',
        settings: { productSource: 'category', limit: 12 },
      },
      {
        nameEn: 'Hand-picked products',
        nameAr: 'منتجات مختارة',
        settings: { productSource: 'manual', limit: 12 },
      },
    ],
    settings: [
      s.select(
        'productSource',
        'Products',
        'المنتجات',
        [
          opt('newest', 'Newest', 'الأحدث'),
          opt('best_seller', 'Best sellers', 'الأكثر مبيعاً'),
          opt('featured', 'Featured', 'المميزة'),
          opt('category', 'From a category', 'من فئة'),
          opt('manual', 'Hand-picked', 'مختارة يدوياً'),
        ],
        { group: 'content' }
      ),
      {
        id: 'categorySlug',
        type: 'category',
        labelEn: 'Category',
        labelAr: 'الفئة',
        group: 'content',
      },
      s.range(
        'categoryFetchLimit',
        'Products to load from the category',
        'عدد منتجات الفئة',
        1,
        200
      ),
      {
        id: 'manualProductIds',
        type: 'product_list',
        labelEn: 'Products',
        labelAr: 'المنتجات',
        group: 'content',
        max: 50,
      },
      ...headingSettings(),
      carouselLimit(50),
      ...cardSettings(),
      ...styleSettings(),
    ],
  }),
  def({
    type: 'footer',
    labelEn: 'Footer',
    labelAr: 'التذييل',
    legacyKey: 'footer',
    rendererKey: 'chrome.footer',
    group: 'footer',
    settings: styleSettings(),
  }),
];

const BY_TYPE = new Map(SECTION_REGISTRY.map(d => [d.type, d]));
const BY_LEGACY_KEY = new Map(SECTION_REGISTRY.map(d => [d.legacyKey, d]));

export function getSectionDefinition(type: string): SectionDefinition | undefined {
  return BY_TYPE.get(type);
}

export function sectionDefinitionForLegacyKey(
  key: LegacyLayoutKey | 'extraCarousels'
): SectionDefinition {
  const d = BY_LEGACY_KEY.get(key);
  if (!d) throw new Error(`no section registered for layout key ${key}`);
  return d;
}

/** Stable section id for a fixed (cardinality one) legacy key: `newArrivals` -> `new-arrivals`. */
export function legacySectionId(key: LegacyLayoutKey): string {
  return key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}
