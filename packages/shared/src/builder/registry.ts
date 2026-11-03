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
import { z } from 'zod/v3';
import { storeLayoutSchema } from './layout-schema';
import {
  imageTextSchema,
  newsletterSchema,
  featuredCollectionSchema,
  productSpotlightSchema,
  collectionListSchema,
  collectionBlockSchema,
  trustBadgesSchema,
  trustBadgeBlockSchema,
  shopTheLookSchema,
  shopTheLookBlockSchema,
  stepsSchema,
  stepsBlockSchema,
  makerProfileSchema,
  giftFinderSchema,
  giftOccasionBlockSchema,
  giftBudgetBlockSchema,
  TRUST_BADGE_ICONS,
} from './sections-document-only';
import { PLACEHOLDER_STARTER_COPY } from './placeholder-copy';
import { DEFAULT_LAYOUT_SETTINGS } from '../types/store-layout';
import type { LegacyHomeSectionKey } from './section-keys';
import { VIEWPORTS, type Viewport } from './viewports';
import { PAGE_KINDS, type PageKind } from './page-kinds';
import { pageKindDefs } from './page-section-defs';
import {
  SETTING_OPTIONS,
  cardSettings,
  headingSettings,
  settingFactories as s,
  spacingSettings,
  styleSettings,
  type SettingDefinition,
  type ShownFor,
  type ShownRule,
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
  /** Validator for a block's settings (document-only sections; hero slides are validated through the layout schema). */
  propsSchema?: z.ZodTypeAny;
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
  /**
   * Key in the legacy layout. Product carousels use `'extraCarousels'`.
   * `null` = a DOCUMENT-ONLY type (Phase 2: image-text, newsletter): never
   * projected into `layout_settings`, rendered from the published document.
   */
  legacyKey: LegacyLayoutKey | 'extraCarousels' | null;
  /** Storefront renderer the web app maps this type onto. */
  rendererKey: string;
  group: SectionGroup;
  /** Page kinds this type may appear on (default: the home page only). */
  pages: readonly PageKind[];
  /** The page's main content: movable, but never removed or hidden (see `page-kinds.ts`). */
  pinned: boolean;
  cardinality: 'one' | 'many';
  maxCount: number;
  settings: readonly SettingDefinition[];
  /**
   * Keys the save schema still accepts and stored documents may still carry, but no renderer
   * reads on any skin, so the editor has no control for them (Ruling EP-5: removed, never
   * migrated or deleted). Listed so the descriptor-parity test can tell them from a forgotten field.
   */
  retired: readonly string[];
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

type DefInput = Parameters<typeof defBase>[0];
export type SectionDefInput = DefInput;

/**
 * `responsive.settings` is declared once, on the setting (`responsive: ['mobile']`); the section
 * lists are derived from it, plus any explicit list the definition passes (kept for categories).
 */
function withDerivedResponsive(
  settings: readonly SettingDefinition[],
  explicit: SectionDefinition['responsive']
): SectionDefinition['responsive'] {
  const out: Partial<Record<Viewport, string[]>> = {};
  for (const v of VIEWPORTS) out[v] = [...(explicit.settings[v] ?? [])];
  for (const st of settings)
    for (const v of st.responsive ?? []) if (!out[v]!.includes(st.id)) out[v]!.push(st.id);
  const settingsByVp: Partial<Record<Viewport, readonly string[]>> = {};
  for (const v of VIEWPORTS) if (out[v]!.length > 0) settingsByVp[v] = out[v]!;
  return { hidden: explicit.hidden, settings: settingsByVp };
}

function def(d: DefInput): SectionDefinition {
  const r = defBase(d);
  return { ...r, responsive: withDerivedResponsive(r.settings, r.responsive) };
}

function defBase(
  d: Omit<
    SectionDefinition,
    | 'propsSchema'
    | 'maxCount'
    | 'cardinality'
    | 'blocks'
    | 'responsive'
    | 'presets'
    | 'pages'
    | 'pinned'
    | 'retired'
  > &
    Partial<
      Pick<
        SectionDefinition,
        | 'cardinality'
        | 'maxCount'
        | 'blocks'
        | 'responsive'
        | 'presets'
        | 'propsSchema'
        | 'pages'
        | 'pinned'
        | 'retired'
      >
    >
): SectionDefinition {
  const key = d.legacyKey;
  if (key === null) {
    if (!d.propsSchema) throw new Error(`document-only section ${d.type} needs a propsSchema`);
    return {
      cardinality: 'many',
      pages: ['home'],
      pinned: false,
      retired: [],
      maxCount: 8,
      blocks: [],
      responsive: { hidden: ALL, settings: {} },
      presets: [{ nameEn: d.labelEn, nameAr: d.labelAr, settings: {} }],
      ...d,
      propsSchema: d.propsSchema,
    };
  }
  return {
    cardinality: 'one',
    pages: ['home'],
    pinned: false,
    retired: [],
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
    s.video('video', 'Background video (optional)', 'فيديو الخلفية (اختياري)', {
      localized: false,
    }),
    s.video('videoMobile', 'Mobile video', 'فيديو الجوال'),
    s.select('focus', 'Image focus', 'تركيز الصورة', [
      opt('center', 'Centre', 'الوسط'),
      opt('top', 'Top (keeps heads in frame)', 'أعلى (يحافظ على الرأس)'),
      opt('bottom', 'Bottom', 'أسفل'),
    ]),
    s.text('alt', 'Image description', 'وصف الصورة'),
    s.text('headline', 'Headline', 'العنوان', { localized: true }),
    s.text('ctaText', 'Button text', 'نص الزر', { localized: true }),
    s.url('ctaHref', 'Button link', 'رابط الزر'),
    s.url('link', 'Whole-slide link', 'رابط الشريحة'),
  ],
};

const BADGE_ICON_LABELS: Record<(typeof TRUST_BADGE_ICONS)[number], [string, string]> = {
  cod: ['Cash on delivery', 'الدفع عند الاستلام'],
  instapay: ['InstaPay', 'إنستاباي'],
  shipping: ['Delivery', 'التوصيل'],
  certified: ['Certified', 'معتمد'],
  returns: ['Returns', 'الاسترجاع'],
  gift: ['Gift wrap', 'تغليف هدايا'],
  engraving: ['Engraving', 'حفر'],
  support: ['Support', 'الدعم'],
};

const without = (list: readonly SettingDefinition[], ids: readonly string[]) =>
  list.filter(x => !ids.includes(x.id));
/** `list` with a `shownFor` rule added to the settings named in `rules`. */
const narrowed = (list: readonly SettingDefinition[], rules: Record<string, ShownFor>) =>
  list.map(x => (x.id in rules ? { ...x, shownFor: rules[x.id] } : x));
/**
 * Spacing the skin's renderer ignores. The carousels and the hero lay themselves out inside their
 * own container (`PageRenderer` comment on the hero wrapper; `T.ProductCarousel` ignores the
 * `innerContainerClass`), so Width, and for the hero Top / Bottom spacing, did nothing on any skin.
 */
/**
 * Every skin except Dahab (Ruling B5-35). Dahab's cards, tiles, heading row and hero are the
 * look's own fixed design: one card size, the look's frame and corners, no label above the heading,
 * a hero that always anchors its copy at the inline start. A control only the other skins read is
 * therefore not offered on Dahab. It is an exclusion (`notTemplates`), so an unknown or
 * legacy template keeps the universal controls (Ruling B5-37); a skin added later that ignores them
 * must be added to the exclusion (the matrix fails until it is).
 */
const NOT_DAHAB: ShownRule = { notTemplates: ['dahab'] };
/** Card design Dahab's card ignores; it reads Show name and Hover effect (both wired). */
const DAHAB_FIXED_CARD: Record<string, ShownFor> = Object.fromEntries(
  [
    'cardSize',
    'cardAspect',
    'cardShape',
    'cardGap',
    'showCardFrame',
    'cardFrameStyle',
    'cardFrameWidth',
    'cardFrameSize',
    'cardFrameColor',
  ].map(id => [id, NOT_DAHAB])
);
/** The heading row's label above the title and its flanking lines: Dahab's heading has none. */
const DAHAB_NO_KICKER: Record<string, ShownFor> = Object.fromEntries(
  ['kicker', 'showKickerLines', 'showSubtitleLines'].map(id => [id, NOT_DAHAB])
);
/** Category cards honour Aspect / Name / Hover in the scrolling row. */
const CATEGORY_CARD_LOOK: ShownFor = [
  // the scrolling row of every skin but Dahab (its tiles are the look's own)
  { ...NOT_DAHAB, variants: { layout: ['horizontal'] } },
];
const NO_WIDTH = ['maxWidth'] as const;
/** The hero is aspect-driven: no Width. Its Top / Bottom spacing is an outer margin (Ruling SP-3). */
const NO_HERO_SPACING = ['maxWidth'] as const;

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
        opt('collage', 'Collage (3 photos)', 'كولاج (3 صور)'),
      ]),
      s.select(
        'frame',
        'Frame line (framed only)',
        'خط الإطار (داخل إطار فقط)',
        [opt('none', 'None', 'بدون'), opt('line', 'Hairline', 'خط رفيع')],
        // Dahab's hero is one full-bleed photograph over a fade, with no frame to draw a line in
        { shownFor: NOT_DAHAB }
      ),
      s.select(
        'textAnchor',
        'Text position',
        'موضع النص',
        [
          opt('center', 'Centre', 'في المنتصف'),
          opt('bottom-start', 'Bottom corner', 'في الركن السفلي'),
        ],
        {
          // Dahab always sets its copy at the inline start
          shownFor: NOT_DAHAB,
          // M-6 (B1-48): below xl the anchored copy leaves the photo, so its colour is the page's.
          hintEn:
            'On phones and tablets the text sits under the photo in the page colours, so the headline colour applies only on large screens.',
          hintAr:
            'على الجوال والتابلت يظهر النص أسفل الصورة بألوان الصفحة، لذا يُطبَّق لون العنوان على الشاشات الكبيرة فقط.',
        }
      ),
      ...without(styleSettings(), NO_HERO_SPACING),
    ],
    retired: NO_HERO_SPACING,
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
      ...narrowed(headingSettings(), DAHAB_NO_KICKER),
      s.select(
        'layout',
        'Layout',
        'التخطيط',
        [
          opt('grid', 'Grid', 'شبكة'),
          opt('horizontal', 'Scrolling row', 'صف متحرك'),
          opt('chips', 'Text chips', 'أزرار نصية'),
          opt('rail', 'Image rail', 'شريط'),
          opt('tiles', 'Square tiles', 'مربعات'),
        ],
        {
          responsive: ['mobile'],
        }
      ),
      s.select(
        'source',
        'Shows',
        'يعرض',
        [
          opt('categories', 'Categories', 'الأقسام'),
          opt('tags', 'Tags (skin type, concern)', 'الوسوم (نوع البشرة، المشكلة)'),
        ],
        {
          hintEn: 'Tags show as text chips. Each chip opens the products that carry the tag.',
          hintAr: 'الوسوم بتظهر كأزرار نصية، وكل زر بيفتح المنتجات اللي عليها الوسم.',
        }
      ),
      s.select(
        'captionPosition',
        'Name position',
        'موضع الاسم',
        [opt('below', 'Below', 'أسفل'), opt('overlay', 'On image', 'على الصورة')],
        {
          responsive: ['mobile'],
          // Dahab's tiles always carry the name below the photograph
          shownFor: NOT_DAHAB,
        }
      ),
      s.select(
        'tint',
        'Tile colours',
        'ألوان المربعات',
        [opt('none', 'Plain', 'سادة'), opt('aisles', 'Aisle colours', 'ألوان الممرات')],
        {
          // only a look that defines aisle colours (Lamma's market) paints them
          shownFor: { looks: ['lamma.market'], variants: { layout: ['tiles'] } },
          hintEn: 'Square tiles take the look’s aisle colours as soft tints. Names always show.',
          hintAr: 'مربعات الأقسام بتاخد ألوان الممرات كدرجات فاتحة، والاسم بيظهر دايمًا.',
        }
      ),
      s.select('desktopColumns', 'Columns (desktop)', 'الأعمدة (سطح المكتب)', [
        opt(2, '2', '2'),
        opt(3, '3', '3'),
        opt(4, '4', '4'),
      ]),
      s.select('mobileColumns', 'Columns (mobile)', 'الأعمدة (الجوال)', [
        opt(1, '1', '1'),
        opt(2, '2', '2'),
        opt(3, '3', '3'),
      ]),
      // The grid and the aisle tiles ignore these on every skin built since the looks (their
      // cards are their own); the scrolling row reads them.
      ...narrowed(cardSettings(), {
        ...DAHAB_FIXED_CARD,
        cardAspect: CATEGORY_CARD_LOOK,
        showLabel: CATEGORY_CARD_LOOK,
        showHover: CATEGORY_CARD_LOOK,
      }),
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
    settings: [
      ...narrowed(headingSettings(), DAHAB_NO_KICKER),
      carouselLimit(48),
      ...narrowed(cardSettings(), DAHAB_FIXED_CARD),
      ...without(styleSettings(), NO_WIDTH),
    ],
    retired: NO_WIDTH,
  }),
  def({
    type: 'best-sellers',
    labelEn: 'Best sellers',
    labelAr: 'الأكثر مبيعاً',
    legacyKey: 'bestSellers',
    rendererKey: 'home.bestSellers',
    group: 'template',
    settings: [
      ...narrowed(headingSettings(), DAHAB_NO_KICKER),
      carouselLimit(48),
      ...narrowed(cardSettings(), DAHAB_FIXED_CARD),
      ...without(styleSettings(), NO_WIDTH),
    ],
    retired: NO_WIDTH,
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
    blocks: [
      {
        type: 'item',
        labelEn: 'Trust item',
        labelAr: 'عنصر ثقة',
        maxCount: 6,
        settings: [
          s.select(
            'icon',
            'Icon',
            'الأيقونة',
            TRUST_BADGE_ICONS.map(i => opt(i, BADGE_ICON_LABELS[i][0], BADGE_ICON_LABELS[i][1])),
            { group: 'content' }
          ),
          s.text('title', 'Title', 'العنوان', { localized: true }),
          s.text('text', 'Subtitle (optional)', 'سطر فرعي (اختياري)', { localized: true }),
        ],
      },
    ],
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
      s.select('layout', 'Layout', 'طريقة العرض', [
        opt('row', 'Row of reviews', 'صف آراء'),
        opt('single', 'One quote', 'رأي واحد'),
      ]),
      s.range('minRating', 'Minimum rating', 'أقل تقييم', 1, 5),
      s.check('verifiedOnly', 'Verified purchases only', 'مشتريات موثقة فقط', 'content'),
      ...without(styleSettings(), NO_WIDTH),
    ],
    retired: NO_WIDTH,
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
          opt('on_sale', 'On sale', 'المنتجات المخفّضة'),
          opt(
            'reorder',
            'Order again (the customer’s last products)',
            'اطلب تاني (آخر منتجات الزبون)'
          ),
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
      ...narrowed(headingSettings(), DAHAB_NO_KICKER),
      carouselLimit(50),
      ...narrowed(cardSettings(), DAHAB_FIXED_CARD),
      ...without(styleSettings(), NO_WIDTH),
    ],
    retired: NO_WIDTH,
  }),
  def({
    type: 'image-text',
    pages: PAGE_KINDS,
    labelEn: 'Image with text',
    labelAr: 'صورة مع نص',
    legacyKey: null,
    rendererKey: 'section.imageText',
    group: 'template',
    propsSchema: imageTextSchema,
    presets: [
      {
        nameEn: 'Image with text',
        nameAr: 'صورة مع نص',
        settings: {
          heading: 'Our story',
          headingAr: 'حكايتنا',
          body: PLACEHOLDER_STARTER_COPY.imageTextBody.en,
          bodyAr: PLACEHOLDER_STARTER_COPY.imageTextBody.ar,
          imagePosition: 'start',
          imageAspect: 'square',
        },
      },
      {
        nameEn: 'Text first',
        nameAr: 'النص أولاً',
        settings: {
          heading: 'Made by hand',
          headingAr: 'شغل يدوي',
          imagePosition: 'end',
          imageAspect: 'portrait',
        },
      },
    ],
    settings: [
      s.image('image', 'Image', 'الصورة', { localized: true }),
      s.text('alt', 'Image description', 'وصف الصورة', { localized: true }),
      s.text('heading', 'Heading', 'العنوان', { localized: true }),
      s.textarea('body', 'Text', 'النص', { localized: true }),
      s.text('buttonText', 'Button text', 'نص الزر', { localized: true }),
      s.url('buttonLink', 'Button link', 'رابط الزر'),
      s.select('layout', 'Layout', 'التخطيط', [
        opt('split', 'Side by side', 'جنب بعض'),
        opt('full-bleed', 'Full-width image', 'صورة بعرض الشاشة'),
      ]),
      s.select('imagePosition', 'Image side', 'جهة الصورة', [
        opt('start', 'Start (right in Arabic)', 'البداية (يمين في العربية)'),
        opt('end', 'End (left in Arabic)', 'النهاية (يسار في العربية)'),
      ]),
      s.select('imageAspect', 'Image shape', 'شكل الصورة', [
        opt('square', 'Square', 'مربع'),
        opt('portrait', 'Portrait', 'طولي'),
        opt('landscape', 'Landscape', 'عرضي'),
      ]),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
    ],
  }),
  def({
    type: 'newsletter',
    pages: PAGE_KINDS,
    labelEn: 'Newsletter signup',
    labelAr: 'الاشتراك في النشرة',
    legacyKey: null,
    rendererKey: 'section.newsletter',
    group: 'template',
    propsSchema: newsletterSchema,
    maxCount: 2,
    presets: [
      {
        nameEn: 'Newsletter signup',
        nameAr: 'الاشتراك في النشرة',
        settings: {
          heading: 'Get our offers first',
          headingAr: 'اعرف عروضنا الأول',
          body: 'New arrivals and discounts, straight to your inbox.',
          bodyAr: 'الجديد والخصومات توصلك على الإيميل.',
        },
      },
    ],
    settings: [
      s.text('heading', 'Heading', 'العنوان', { localized: true }),
      s.textarea('body', 'Text', 'النص', { localized: true }),
      s.text('buttonText', 'Button text', 'نص الزر', { localized: true }),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
    ],
  }),
  def({
    type: 'featured-collection',
    labelEn: 'Featured collection',
    labelAr: 'مجموعة مميزة',
    legacyKey: null,
    rendererKey: 'section.featuredCollection',
    group: 'template',
    propsSchema: featuredCollectionSchema,
    presets: [
      {
        nameEn: 'Newest products grid',
        nameAr: 'شبكة أحدث المنتجات',
        settings: {
          heading: 'New in',
          headingAr: 'وصل حديثاً',
          productSource: 'newest',
          limit: 8,
          columns: 4,
          mobileColumns: 2,
          buttonText: 'View all',
          buttonTextAr: 'عرض الكل',
          buttonLink: '/products',
        },
      },
      {
        nameEn: 'One collection',
        nameAr: 'مجموعة واحدة',
        settings: {
          heading: 'Collection',
          headingAr: 'مجموعة',
          productSource: 'category',
          limit: 4,
          columns: 4,
          mobileColumns: 2,
        },
      },
    ],
    settings: [
      s.text('heading', 'Heading', 'العنوان', { localized: true }),
      s.text('subheading', 'Subheading', 'العنوان الفرعي', { localized: true }),
      s.select(
        'productSource',
        'Products',
        'المنتجات',
        [
          opt('newest', 'Newest', 'الأحدث'),
          opt('best_seller', 'Best sellers', 'الأكثر مبيعاً'),
          opt('featured', 'Featured', 'المميزة'),
          opt('category', 'From a category', 'من فئة'),
          opt('on_sale', 'On sale', 'المنتجات المخفّضة'),
          opt(
            'reorder',
            'Order again (the customer’s last products)',
            'اطلب تاني (آخر منتجات الزبون)'
          ),
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
      {
        id: 'manualProductIds',
        type: 'product_list',
        labelEn: 'Products',
        labelAr: 'المنتجات',
        group: 'content',
        max: 24,
      },
      s.range('limit', 'Products to show', 'عدد المنتجات', 2, 24),
      s.select(
        'layout',
        'Layout',
        'التخطيط',
        [opt('grid', 'Grid', 'شبكة'), opt('menu', 'Menu by category', 'قائمة بالأقسام')],
        {
          hintEn: 'A menu lists dishes in rows, grouped by category, with category tabs.',
          hintAr: 'القائمة بتعرض الأطباق في صفوف حسب القسم، ومعاها تابات للأقسام.',
        }
      ),
      s.select(
        'tabs',
        'Category tabs (menu)',
        'تابات الأقسام (القائمة)',
        [opt('categories', 'Show', 'إظهار'), opt('none', 'Hide', 'إخفاء')],
        { shownFor: { variants: { layout: ['menu'] } } }
      ),
      s.select('columns', 'Columns (desktop)', 'الأعمدة (سطح المكتب)', [
        opt(2, '2', '2'),
        opt(3, '3', '3'),
        opt(4, '4', '4'),
        opt(5, '5', '5'),
      ]),
      s.select('mobileColumns', 'Columns (mobile)', 'الأعمدة (الجوال)', [
        opt(1, '1', '1'),
        opt(2, '2', '2'),
      ]),
      s.text('buttonText', 'Button text', 'نص الزر', { localized: true }),
      s.url('buttonLink', 'Button link', 'رابط الزر'),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
    ],
  }),
  def({
    type: 'collection-list',
    labelEn: 'Collection list',
    labelAr: 'قائمة المجموعات',
    legacyKey: null,
    rendererKey: 'section.collectionList',
    group: 'template',
    propsSchema: collectionListSchema,
    blocks: [
      {
        type: 'collection',
        labelEn: 'Collection',
        labelAr: 'مجموعة',
        maxCount: 8,
        propsSchema: collectionBlockSchema,
        settings: [
          {
            id: 'categorySlug',
            type: 'category',
            labelEn: 'Category',
            labelAr: 'الفئة',
            group: 'content',
          },
          s.image('image', 'Image', 'الصورة', { localized: true }),
          s.text('label', 'Label', 'الاسم', { localized: true }),
          s.select('tone', 'Band colour', 'لون الشريط', [
            opt('primary', 'Main colour', 'اللون الأساسي'),
            opt('accent', 'Accent', 'لون مميز'),
            opt('line', 'Hairline colour', 'لون الخطوط'),
          ]),
        ],
      },
    ],
    presets: [
      {
        nameEn: 'Collection list',
        nameAr: 'قائمة المجموعات',
        settings: {
          heading: 'Shop by collection',
          headingAr: 'تسوق حسب المجموعة',
          tileShape: 'rectangle',
          columns: 4,
        },
        blocks: [],
      },
    ],
    settings: [
      s.text('heading', 'Heading', 'العنوان', { localized: true }),
      s.select('tileShape', 'Tile shape', 'شكل البطاقة', [
        opt('rectangle', 'Rectangle', 'مستطيل'),
        opt('circle', 'Circle', 'دائري'),
        opt('band', 'Full-width bands', 'شرائط بعرض الشاشة'),
      ]),
      s.select('columns', 'Columns (desktop)', 'الأعمدة (سطح المكتب)', [
        opt(2, '2', '2'),
        opt(3, '3', '3'),
        opt(4, '4', '4'),
      ]),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
    ],
  }),
  def({
    type: 'product-spotlight',
    labelEn: 'Product spotlight',
    labelAr: 'منتجات مختارة مع صورة',
    legacyKey: null,
    rendererKey: 'section.productSpotlight',
    group: 'template',
    propsSchema: productSpotlightSchema,
    presets: [
      {
        nameEn: 'Gift ideas',
        nameAr: 'أفكار للهدايا',
        settings: {
          heading: 'Gift ideas',
          headingAr: 'أفكار للهدايا',
          productSource: 'featured',
          limit: 3,
          imagePosition: 'start',
        },
      },
    ],
    settings: [
      s.image('image', 'Image', 'الصورة', { localized: true }),
      s.text('alt', 'Image description', 'وصف الصورة', { localized: true }),
      s.text('heading', 'Heading', 'العنوان', { localized: true }),
      s.textarea('body', 'Text', 'النص', { localized: true }),
      s.select(
        'productSource',
        'Products',
        'المنتجات',
        [
          opt('newest', 'Newest', 'الأحدث'),
          opt('best_seller', 'Best sellers', 'الأكثر مبيعاً'),
          opt('featured', 'Featured', 'المميزة'),
          opt('category', 'From a category', 'من فئة'),
          opt('on_sale', 'On sale', 'المنتجات المخفّضة'),
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
      {
        id: 'manualProductIds',
        type: 'product_list',
        labelEn: 'Products',
        labelAr: 'المنتجات',
        group: 'content',
        max: 4,
      },
      s.range('limit', 'Products to show', 'عدد المنتجات', 1, 4),
      s.select('layout', 'Layout', 'التخطيط', [
        opt('list', 'Photo and list', 'صورة وقائمة'),
        opt('stage', 'One product', 'عرض منتج واحد'),
      ]),
      s.select('imagePosition', 'Image side', 'جهة الصورة', [
        opt('start', 'Start (right in Arabic)', 'البداية (يمين في العربية)'),
        opt('end', 'End (left in Arabic)', 'النهاية (يسار في العربية)'),
      ]),
      s.text('buttonText', 'Button text', 'نص الزر', { localized: true }),
      s.url('buttonLink', 'Button link', 'رابط الزر'),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
    ],
  }),
  def({
    type: 'shop-the-look',
    labelEn: 'Shop the look',
    // Neutral noun form (the verbal noun, "shopping the look"), never a gendered imperative.
    labelAr: 'شوف اللوك كامل',
    legacyKey: null,
    rendererKey: 'section.shopTheLook',
    group: 'template',
    propsSchema: shopTheLookSchema,
    maxCount: 2,
    blocks: [
      {
        type: 'look',
        labelEn: 'Look',
        labelAr: 'لوك',
        maxCount: 6,
        propsSchema: shopTheLookBlockSchema,
        settings: [
          // LB-04: the photo is the promise; it shows every piece listed below.
          s.image('image', 'Photo (shows every piece)', 'الصورة (تظهر فيها كل القطع)', {
            localized: true,
          }),
          s.text('alt', 'Photo description', 'وصف الصورة', { localized: true }),
          s.text('title', 'Look name', 'اسم اللوك', { localized: true }),
          {
            id: 'productIds',
            type: 'product_list',
            labelEn: 'Pieces',
            labelAr: 'القطع',
            group: 'content',
            max: 4,
          },
        ],
      },
    ],
    presets: [
      {
        nameEn: 'Shop the look',
        nameAr: 'شوف اللوك كامل',
        settings: { heading: 'Shop the look', headingAr: 'شوف اللوك كامل' },
        blocks: [],
      },
    ],
    settings: [
      s.text('heading', 'Heading', 'العنوان', { localized: true }),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
    ],
  }),
  def({
    type: 'steps',
    labelEn: 'Routine steps',
    // Neutral noun phrase, never a gendered imperative.
    labelAr: 'خطوات الروتين',
    legacyKey: null,
    rendererKey: 'section.steps',
    group: 'template',
    propsSchema: stepsSchema,
    maxCount: 2,
    blocks: [
      {
        type: 'step',
        labelEn: 'Step',
        labelAr: 'خطوة',
        maxCount: 5,
        propsSchema: stepsBlockSchema,
        settings: [
          s.text('title', 'Step name', 'اسم الخطوة', { localized: true }),
          s.textarea('body', 'One line on what it does', 'سطر عن فايدتها', { localized: true }),
          {
            id: 'productIds',
            type: 'product_list',
            labelEn: 'Product for this step',
            labelAr: 'منتج الخطوة',
            group: 'content',
            max: 1,
          },
          s.url('link', 'Link (optional)', 'رابط (اختياري)'),
        ],
      },
    ],
    presets: [
      {
        nameEn: 'Three-step routine',
        nameAr: 'روتين من 3 خطوات',
        settings: { heading: 'Your routine in 3 steps', headingAr: 'روتينك في 3 خطوات' },
        blocks: [
          { type: 'step', settings: { title: 'Cleanse', titleAr: 'تنظيف' } },
          { type: 'step', settings: { title: 'Treat', titleAr: 'علاج' } },
          { type: 'step', settings: { title: 'Protect', titleAr: 'حماية' } },
        ],
      },
    ],
    settings: [
      s.text('heading', 'Heading', 'العنوان', { localized: true }),
      s.text('subheading', 'Subheading', 'عنوان فرعي', { localized: true }),
      s.text('buttonText', 'Add-all button text', 'نص زر إضافة الكل', { localized: true }),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
    ],
  }),
  def({
    type: 'maker-profile',
    pages: PAGE_KINDS,
    labelEn: 'Maker profile',
    // Neutral noun phrase, never a gendered imperative.
    labelAr: 'ملف الطباخة',
    legacyKey: null,
    rendererKey: 'section.makerProfile',
    group: 'template',
    propsSchema: makerProfileSchema,
    maxCount: 2,
    presets: [
      {
        nameEn: 'Strip',
        nameAr: 'شريط',
        settings: { variant: 'strip' },
      },
      {
        nameEn: 'Lead with the cook',
        nameAr: 'الطباخة في الأول',
        settings: { variant: 'lead' },
      },
    ],
    settings: [
      s.select('variant', 'Layout', 'التخطيط', [
        opt('strip', 'Strip: avatar, name and a line', 'شريط: صورة واسم وسطر'),
        opt('lead', 'Lead: large photo and story', 'الأول: صورة كبيرة وحكاية'),
      ]),
      s.image('image', 'Photo', 'الصورة', { localized: true }),
      s.text('alt', 'Photo description', 'وصف الصورة', { localized: true }),
      s.text('name', 'Name', 'الاسم', { localized: true }),
      s.text('role', 'One line about you', 'سطر عنك', { localized: true }),
      s.textarea('story', 'Your story', 'حكايتك', { localized: true }),
      s.text('hygiene', 'Kitchen and hygiene line', 'سطر المطبخ والنظافة', { localized: true }),
      s.range('years', 'Years cooking', 'سنين الطبخ', 0, 80),
      s.url('storyLink', 'Story page link', 'رابط صفحة الحكاية'),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
    ],
  }),
  def({
    type: 'gift-finder',
    labelEn: 'Gift finder',
    // Neutral noun phrase, never a gendered imperative.
    labelAr: 'مساعد الهدايا',
    legacyKey: null,
    rendererKey: 'section.giftFinder',
    group: 'template',
    propsSchema: giftFinderSchema,
    maxCount: 1,
    blocks: [
      {
        type: 'occasion',
        labelEn: 'Occasion',
        labelAr: 'مناسبة',
        maxCount: 8,
        propsSchema: giftOccasionBlockSchema,
        settings: [
          {
            id: 'categorySlug',
            type: 'category',
            labelEn: 'Category for this occasion',
            labelAr: 'فئة المناسبة',
            group: 'content',
          },
          s.text('label', 'Label', 'الاسم', { localized: true }),
        ],
      },
      {
        type: 'budget',
        labelEn: 'Budget',
        labelAr: 'ميزانية',
        maxCount: 6,
        propsSchema: giftBudgetBlockSchema,
        settings: [
          s.range('maxPrice', 'Up to (pounds)', 'لحد (بالجنيه)', 50, 100000, 50),
          s.text('label', 'Label', 'الاسم', { localized: true }),
        ],
      },
    ],
    presets: [
      {
        nameEn: 'Gift finder',
        nameAr: 'مساعد الهدايا',
        settings: { heading: 'Find the right gift', headingAr: 'اختار الهدية المناسبة' },
        blocks: [
          { type: 'occasion', settings: { label: 'Engagement', labelAr: 'خطوبة' } },
          { type: 'occasion', settings: { label: 'Birthday', labelAr: 'عيد ميلاد' } },
          { type: 'occasion', settings: { label: "Mother's day", labelAr: 'عيد الأم' } },
          {
            type: 'budget',
            settings: { maxPrice: 2000, label: 'Up to 2,000', labelAr: 'لحد 2,000' },
          },
          {
            type: 'budget',
            settings: { maxPrice: 5000, label: 'Up to 5,000', labelAr: 'لحد 5,000' },
          },
        ],
      },
    ],
    settings: [
      s.text('heading', 'Heading', 'العنوان', { localized: true }),
      s.text('occasionsLabel', 'Occasions line', 'سطر المناسبات', { localized: true }),
      s.text('budgetsLabel', 'Budgets line', 'سطر الميزانية', { localized: true }),
      s.text('buttonText', 'Show-gifts link text', 'نص رابط عرض الهدايا', { localized: true }),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
    ],
  }),
  def({
    type: 'trust-badges',
    pages: PAGE_KINDS,
    labelEn: 'Trust badges',
    labelAr: 'شارات الثقة',
    legacyKey: null,
    rendererKey: 'section.trustBadges',
    group: 'template',
    propsSchema: trustBadgesSchema,
    maxCount: 2,
    blocks: [
      {
        type: 'badge',
        labelEn: 'Badge',
        labelAr: 'شارة',
        maxCount: 6,
        propsSchema: trustBadgeBlockSchema,
        settings: [
          s.select(
            'icon',
            'Icon',
            'الأيقونة',
            TRUST_BADGE_ICONS.map(i => opt(i, BADGE_ICON_LABELS[i][0], BADGE_ICON_LABELS[i][1])),
            { group: 'content' }
          ),
          s.text('title', 'Title', 'العنوان', { localized: true }),
          s.text('text', 'Text', 'النص', { localized: true }),
        ],
      },
    ],
    presets: [
      {
        nameEn: 'Delivery and payment',
        nameAr: 'التوصيل والدفع',
        settings: { layout: 'row' },
        blocks: [
          {
            type: 'badge',
            settings: { icon: 'cod', title: 'Cash on delivery', titleAr: 'الدفع عند الاستلام' },
          },
          { type: 'badge', settings: { icon: 'instapay', title: 'InstaPay', titleAr: 'إنستاباي' } },
          {
            type: 'badge',
            settings: {
              icon: 'shipping',
              title: 'Delivery across Egypt',
              titleAr: 'توصيل لكل مصر',
            },
          },
        ],
      },
    ],
    settings: [
      s.text('heading', 'Heading', 'العنوان', { localized: true }),
      s.select('layout', 'Layout', 'التخطيط', [
        opt('row', 'Row', 'صف'),
        opt('grid', 'Grid', 'شبكة'),
      ]),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
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
  // ---- Page-kind sections (Ruling VE-3): the product, collection and cart pages as documents.
  // Each page's main content is ONE pinned section, rendered by the page's own client (it shares the
  // gallery / variant / quantity state, like Shopify's `main-product`). The rest are movable.
  ...pageKindDefs(def),
];

const BY_TYPE = new Map(SECTION_REGISTRY.map(d => [d.type, d]));
const BY_LEGACY_KEY = new Map(
  SECTION_REGISTRY.filter(d => d.legacyKey !== null).map(d => [d.legacyKey, d])
);

/** Whether `d` may appear on the page document `pageKey` (an unknown key counts as the home page). */
export function sectionAllowedOnPage(d: SectionDefinition, pageKey: string): boolean {
  return d.pages.includes(
    (PAGE_KINDS as readonly string[]).includes(pageKey) ? (pageKey as PageKind) : 'home'
  );
}

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
