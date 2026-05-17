/**
 * Store layout settings — controls which sections appear on the storefront
 * home page and how they render. Persisted as JSONB on `stores.layout_settings`.
 *
 * The storefront, the admin "Layout" page, and the API all consume this
 * single contract. Empty `{}` on the column means "use packaged defaults" —
 * `resolveLayoutSettings()` merges with `DEFAULT_LAYOUT_SETTINGS` so existing
 * tenants don't need a backfill.
 *
 * Defaults match the Pecannbee flow (see
 * docs/superpowers/specs/2026-04-26-pecannbee-home-flow-design.md): hero
 * slider, 3-up category grid with caption-below, both product carousels,
 * filter sidebar on PLP, testimonials.
 */

export type HeroMode = 'single' | 'slider';

export interface HeroSlide {
  /**
   * Desktop image — R2 URL. Recommended 1920×800 (aspect 2.4:1) so the
   * full-bleed hero looks cinematic on widescreens without croppingthe
   * subject too tightly.
   */
  image: string;
  imageAr?: string;
  /**
   * Mobile image — R2 URL. Optional but strongly recommended; recommended
   * 1080×1440 (aspect 3:4) so the hero stays subject-prominent on
   * phone screens. When unset we fall back to `image` and crop, which
   * usually works for landscape product shots but rarely for ones with
   * tall subjects (people, packaging).
   */
  imageMobile?: string;
  imageMobileAr?: string;
  alt?: string;
  /** Optional headline rendered as overlay — pack styles vary */
  headline?: string;
  headlineAr?: string;
  /** Optional CTA */
  ctaText?: string;
  ctaTextAr?: string;
  ctaHref?: string;
}

export interface HeroSettings {
  enabled: boolean;
  mode: HeroMode;
  /** Autoplay interval in ms; ignored when mode === 'single' */
  autoplayMs: number;
  slides: HeroSlide[];
  /**
   * Presentation mode:
   *   - `'full-bleed'` (default) — hero spans 100vw, image fills via
   *     object-cover (may crop top/bottom if image aspect ≠ container).
   *   - `'framed'` — hero sits inside a max-w-7xl container with padding
   *     + rounded corners + neutral bg; image renders with object-contain
   *     so the WHOLE image shows (may letterbox). Pick this when merchant
   *     uploaded an image they want to display in full without crop.
   * Merchants pick via Admin → Layout → Hero. Optional — undefined
   * preserves the existing full-bleed default for back-compat.
   */
  presentation?: 'full-bleed' | 'framed';
}

export type CategoriesLayout = 'grid' | 'horizontal';
export type CategoriesCaption = 'below' | 'overlay';

/**
 * Per-section heading override. When `title` / `titleAr` are non-empty
 * strings the storefront uses them as the section heading; otherwise the
 * platform's default applies (e.g. "Shop by Category"). The fields are
 * optional so old persisted layout blobs keep working.
 */
export interface SectionTitleOverride {
  title?: string;
  titleAr?: string;
  /**
   * Optional small uppercase kicker badge rendered ABOVE the title in a
   * primary-color chip. Used to add visual eyebrow context (e.g. "NEW",
   * "EXPLORE", "BROWSE"). Empty → no chip rendered. Bilingual.
   */
  kicker?: string;
  kickerAr?: string;
  /** Optional tagline rendered as a small line BELOW the title. Bilingual. */
  subtitle?: string;
  subtitleAr?: string;
  /**
   * Toggle the flanking editorial hairlines around the kicker text.
   * Default (undefined / true) → lines render. Set to `false` to suppress
   * just the surrounding lines while keeping the kicker text itself.
   */
  showKickerLines?: boolean;
  /**
   * Toggle the flanking editorial hairlines around the subtitle text.
   * Default (undefined / true) → lines render. Set to `false` to suppress
   * just the surrounding lines while keeping the subtitle text itself.
   */
  showSubtitleLines?: boolean;
}

/**
 * Generic per-store CARD SIZE — used across categories, products,
 * carousels. Drives the `max-w-*` cap each card applies.
 *   xs:  120 / 140    (compact icon-tile)
 *   sm:  150 / 180    (Ahmad 2026-05-16 default — "smaller")
 *   md:  200 / 240    (medium balanced)
 *   lg:  240 / 300    (hero feature tile)
 *   xl:  280 / 360    (oversized, marketing-page only)
 */
export type CardSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Generic per-store CARD ASPECT RATIO. Overrides the per-theme default
 * when set to anything other than 'theme'.
 *   theme: keep the theme's built-in default
 *   square: 1:1 — clean, photo grid feel
 *   portrait: 3:4 — taller, fashion / lookbook
 *   landscape: 4:3 — wider, lifestyle / banner-y
 */
export type CardAspect = 'theme' | 'square' | 'portrait' | 'landscape';

/**
 * Generic per-store CARD GAP — the spacing between cards in a grid /
 * carousel. Lets a merchant pack cards tight (tile-grid look) or breathe
 * (gallery look) without us having to bake a single value per theme.
 *   tight:   gap-1.5 / gap-2  — compact tile grid
 *   normal:  gap-3 / gap-4    — default, balanced (Ahmad 2026-05-16 "smaller")
 *   loose:   gap-5 / gap-6    — airy, premium gallery feel
 *   xloose:  gap-8 / gap-10   — magazine, single-tenant flagship
 */
export type CardGap = 'tight' | 'normal' | 'loose' | 'xloose';

/**
 * Named CARD SHAPE for category tiles. Bundles aspect ratio + corner
 * rounding under one pickable identity — easier for merchants than
 * tuning each axis separately. When set to anything but 'theme', it
 * overrides both `cardAspect` and the theme's default rounding.
 *
 *   theme:          inherit the active template's defaults (current behavior)
 *   circle:         rounded-full + aspect-square — Instagram-style icon tiles
 *   rounded-square: rounded-2xl + aspect-square — modern soft tile
 *   square:         rounded-none + aspect-square — brutalist sharp
 *   soft:           rounded-lg + aspect-[4/5] — fashion / lifestyle
 *   portrait:       rounded-md + aspect-[3/4] — taller, lookbook
 *   landscape:      rounded-md + aspect-[4/3] — wider, banner-y
 *   pill:           rounded-full + aspect-[2/1] — horizontal capsule
 */
export type CardShape =
  | 'theme'
  | 'circle'
  | 'rounded-square'
  | 'square'
  | 'soft'
  | 'portrait'
  | 'landscape'
  | 'pill';

// Back-compat aliases — older code imports CategoryCardSize / CategoryCardAspect.
export type CategoryCardSize = CardSize;
export type CategoryCardAspect = CardAspect;

export interface CategoriesSettings extends SectionTitleOverride {
  enabled: boolean;
  // 2026-05-16: split layout + captionPosition into desktop + mobile so
  // merchants can choose e.g. grid on desktop + horizontal-scroll on
  // mobile (pecannbee pattern), or caption-below on desktop + caption-
  // over on mobile (compact card style). Legacy single-field `layout`
  // and `captionPosition` retained for back-compat — when both new
  // breakpoint fields are unset, the legacy field applies to both.
  layout: CategoriesLayout;
  layoutMobile?: CategoriesLayout;
  captionPosition: CategoriesCaption;
  captionPositionMobile?: CategoriesCaption;
  desktopColumns: 2 | 3 | 4;
  mobileColumns: 1 | 2 | 3;
  /** Per-store category card size — admin-controlled. Default 'sm'. */
  cardSize?: CategoryCardSize;
  /** Per-store category card aspect — admin-controlled. Default 'theme'. */
  cardAspect?: CategoryCardAspect;
  /** Show the category label below/over the image. Default true. */
  showLabel?: boolean;
  /** Show subtle hover effects (zoom, shadow). Default true. */
  showHover?: boolean;
  /** Spacing between category cards. Default 'normal'. */
  cardGap?: CardGap;
  /** Named card shape (bundles aspect + rounding). When set to anything
   *  but 'theme', overrides cardAspect + theme's default rounding.
   *  Default 'theme'. */
  cardShape?: CardShape;
  /**
   * Wrap each card in a frame for an opt-in "card-on-paper" look. Default
   * undefined / false = no frame (cards sit directly on section bg).
   * Pair with `cardFrameStyle` for personality control.
   */
  showCardFrame?: boolean;
  /**
   * Frame personality when `showCardFrame` is on. Default 'soft'.
   *   - `'soft'`   rounded-2xl + bg-card + subtle shadow (modern / SaaS)
   *   - `'outline'` rounded-xl + 2px border, no bg, no shadow (classic / minimal)
   *   - `'shadow'` rounded-2xl + bg-card + larger shadow, no border (premium)
   *   - `'paper'`  rounded-lg + bg-card + paper-style shadow + larger padding (editorial)
   */
  cardFrameStyle?: 'soft' | 'outline' | 'shadow' | 'paper';
}

export interface ProductCarouselSettings extends SectionTitleOverride {
  enabled: boolean;
  /** Max products to load */
  limit: number;
  /** Per-store card size override. Default 'sm'. */
  cardSize?: CardSize;
  /** Per-store card aspect override. Default 'theme'. */
  cardAspect?: CardAspect;
  /** Per-store named shape override (circle / rounded-square / square /
   *  soft / portrait / landscape / pill). When set to anything but 'theme',
   *  bundles aspect + rounding so merchant doesn't tune each axis separately. */
  cardShape?: CardShape;
  /** Spacing between product cards in the grid / carousel. Default 'normal'. */
  cardGap?: CardGap;
  /** Show the product name + price below the image. Default true. */
  showLabel?: boolean;
  /** Show subtle hover effects (zoom, shadow). Default true. */
  showHover?: boolean;
  /**
   * Wrap each product card in a frame for an opt-in contained-tile look.
   * Default undefined / false = no extra frame (the theme's own
   * ProductCard chrome applies). Pair with `cardFrameStyle`.
   */
  showCardFrame?: boolean;
  /**
   * Frame personality when `showCardFrame` is on. Default 'soft'. See
   * CategoriesSettings.cardFrameStyle for the 4-value enum.
   */
  cardFrameStyle?: 'soft' | 'outline' | 'shadow' | 'paper';
}

export interface FilterSidebarSettings {
  enabled: boolean;
  /** When false on desktop, opens collapsed; users click to expand */
  defaultOpen: boolean;
}

export interface TestimonialsSettings extends SectionTitleOverride {
  enabled: boolean;
  minRating: number;
  verifiedOnly: boolean;
}

/**
 * Aspect-ratio + sizing contract shared across all 5 templates so pages look
 * consistent regardless of which template a store has selected.
 */
export interface SizingContract {
  heroAspect: '2.45:1' | '16:9' | '4:3';
  productImageAspect: '1:1' | '3:4';
  categoryImageAspect: '1:1' | '3:4' | '2:3';
}

/**
 * User-generated-content sections (testimonials on home + reviews on product
 * detail) share an admin section and a fake-reviews-illegal posture (KW Law
 * 39/2014, FTC 2024, EU UCPD). Both default off so a brand-new store doesn't
 * silently show "be the first to review" empty states that read like staged
 * placeholders. Merchants explicitly opt-in once they have real UGC.
 */
export interface ReviewSectionSettings {
  enabled: boolean;
}

export interface StoreLayoutSettings {
  hero: HeroSettings;
  categories: CategoriesSettings;
  newArrivals: ProductCarouselSettings;
  bestSellers: ProductCarouselSettings;
  filterSidebar: FilterSidebarSettings;
  testimonials: TestimonialsSettings;
  reviewSection: ReviewSectionSettings;
  sizing: SizingContract;
}

/**
 * Pecannbee flow defaults. When a tenant's `layout_settings` column is `{}`
 * (the column default), `resolveLayoutSettings` returns this verbatim.
 */
export const DEFAULT_LAYOUT_SETTINGS: StoreLayoutSettings = {
  hero: {
    enabled: true,
    mode: 'slider',
    autoplayMs: 5000,
    slides: [],
  },
  categories: {
    enabled: true,
    layout: 'grid',
    captionPosition: 'below',
    desktopColumns: 3,
    mobileColumns: 2,
  },
  newArrivals: {
    enabled: true,
    limit: 16,
  },
  bestSellers: {
    enabled: true,
    limit: 12,
  },
  filterSidebar: {
    enabled: true,
    defaultOpen: true,
  },
  testimonials: {
    // Default OFF for new stores. The fake-reviews-illegal posture
    // (KW Law 39/2014: 50K KWD/offense + closure; FTC 2024 rule; EU
    // UCPD Art 6) makes auto-displaying a testimonials section risky
    // when the merchant hasn't explicitly populated real ones. Merchant
    // enables in admin → Layout → Testimonials once they have real
    // customer feedback. Existing stores keep their saved setting via
    // resolveLayoutSettings() merge — only NEW stores get this default.
    enabled: false,
    minRating: 4,
    verifiedOnly: true,
  },
  reviewSection: {
    // Sibling of testimonials above — controls the product-detail-page
    // ReviewSection. Default off so new stores don't ship with a
    // "no reviews yet, be the first" placeholder reading as staged
    // content. Combined with the platform-level `isEnabled('reviews')`
    // feature flag via AND: both must be on for the section to render.
    enabled: false,
  },
  sizing: {
    heroAspect: '2.45:1',
    productImageAspect: '1:1',
    categoryImageAspect: '1:1',
  },
};

/**
 * Merge a partial / unknown blob from JSONB with the packaged defaults.
 * Tolerant of missing keys, malformed values, and unknown extras (forward
 * compatible).
 */
export function resolveLayoutSettings(input: unknown): StoreLayoutSettings {
  if (!input || typeof input !== 'object') return DEFAULT_LAYOUT_SETTINGS;
  const raw = input as Partial<StoreLayoutSettings>;

  return {
    hero: { ...DEFAULT_LAYOUT_SETTINGS.hero, ...(raw.hero ?? {}) },
    categories: { ...DEFAULT_LAYOUT_SETTINGS.categories, ...(raw.categories ?? {}) },
    newArrivals: { ...DEFAULT_LAYOUT_SETTINGS.newArrivals, ...(raw.newArrivals ?? {}) },
    bestSellers: { ...DEFAULT_LAYOUT_SETTINGS.bestSellers, ...(raw.bestSellers ?? {}) },
    filterSidebar: { ...DEFAULT_LAYOUT_SETTINGS.filterSidebar, ...(raw.filterSidebar ?? {}) },
    testimonials: { ...DEFAULT_LAYOUT_SETTINGS.testimonials, ...(raw.testimonials ?? {}) },
    reviewSection: { ...DEFAULT_LAYOUT_SETTINGS.reviewSection, ...(raw.reviewSection ?? {}) },
    sizing: { ...DEFAULT_LAYOUT_SETTINGS.sizing, ...(raw.sizing ?? {}) },
  };
}
