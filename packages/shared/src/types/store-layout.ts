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

/**
 * Per-section layout knobs added 2026-05-20 (item #6 of the page-builder
 * gap fill). Every section settings interface that extends these gets
 * padding-top/bottom, max-width override, and breakpoint visibility.
 *
 * Defaults: all undefined (= storefront baseline behavior unchanged).
 * Merchants opt in per-section.
 */
export interface SectionPaddingMaxWidthVisibility {
  /** Vertical padding above the section content. Default: section's baseline. */
  paddingTop?: 'none' | 'tight' | 'normal' | 'loose' | 'xloose';
  /** Vertical padding below the section content. */
  paddingBottom?: 'none' | 'tight' | 'normal' | 'loose' | 'xloose';
  /** Container width — 'contained' = max-w-7xl, 'full' = edge-to-edge. */
  maxWidth?: 'contained' | 'full';
  /** Hide on mobile (< 768px viewport). Default false. */
  hideOnMobile?: boolean;
  /** Hide on desktop (≥ 768px viewport). Default false. */
  hideOnDesktop?: boolean;
}

/**
 * Per-section divider slots — each section can have its own dividers around
 * each part of its heading + content. Replaces the platform-wide
 * `theme.dividers` (now deprecated, still read for back-compat).
 *
 * All 5 slots default `undefined` on new stores ("opt in" — Ahmad 2026-05-20).
 * Existing stores keep their current look via legacy fallback reads on
 * `showKickerLines` / `showSubtitleLines` / `theme.dividers`.
 *
 * Each slot uses the full `DividerSettings` shape so merchants get the same
 * style / thickness / width / color / spacing controls everywhere.
 */
export interface SectionDividers {
  /** Horizontal divider above this section (between this and the previous). */
  above?: import('./store-theme').DividerSettings;
  /** Hairlines flanking the kicker text. Replaces `showKickerLines`. */
  kicker?: import('./store-theme').DividerSettings;
  /** Hairlines flanking the title h2. New slot (no legacy equivalent). */
  title?: import('./store-theme').DividerSettings;
  /** Hairlines flanking the subtitle text. Replaces `showSubtitleLines`. */
  subtitle?: import('./store-theme').DividerSettings;
  /** Horizontal divider between the heading block and the section content. */
  belowHeading?: import('./store-theme').DividerSettings;
}

export interface HeroSlide {
  /**
   * Desktop image — R2 URL. Recommended 1920×800 (aspect 2.4:1) so the
   * full-bleed hero looks cinematic on widescreens without croppingthe
   * subject too tightly.
   */
  image: string;
  imageAr?: string;
  /**
   * Mobile image — R2 URL. Optional. Recommended 1080×394 landscape
   * (~2.74:1, same aspect as desktop) per Ahmad 2026-05-18 directive
   * "mobile hero horizontal not portrait". When unset, the storefront
   * falls back to `image` (the desktop hero) downsampled. Both render
   * in the same landscape container so portrait crops would letterbox.
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

/**
 * Per-section background color override. Hex string ('#RRGGBB' or
 * '#RGB') — when set, the storefront applies it as inline
 * `style={{ backgroundColor }}` on the section wrapper, overriding
 * both the theme `backgroundPreset` alternation AND the global
 * `--bg-section-alt` token. Unset / empty string = inherit the
 * existing alternation logic. Bilingual not needed (color is
 * locale-free).
 */
export interface SectionBgOverride {
  bgColor?: string;
}

/**
 * Per-zone typography override for a single storefront section. Each field
 * is optional — only the fields a merchant explicitly sets are non-undefined.
 * Merged at render time with the global zone from the Typography admin by
 * `resolveSectionZone()` in `apps/web/src/templates/shared/section-typography.ts`.
 */
export interface ZoneOverride {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  /** Hex color OR 'token:<name>' — same shape as section bgColor. */
  color?: string;
  letterSpacing?: string;
  lineHeight?: string;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  /**
   * Underline / strikethrough / overline. Maps to CSS text-decoration-line.
   * Default unset = no decoration (matches browser baseline).
   */
  textDecoration?: 'none' | 'underline' | 'overline' | 'line-through';
  /**
   * Per-zone text alignment. Uses logical values so RTL Arabic flips correctly:
   *   - `start` → left in LTR, right in RTL
   *   - `center` → always centered
   *   - `end` → right in LTR, left in RTL
   * Default when unset: the consumer's baseline (most section headings default
   * to center; body text defaults to start).
   */
  textAlign?: 'start' | 'center' | 'end';
}

/**
 * Per-section typography overrides — heading / kicker / subtitle / body sub-zones
 * each accept an independent `ZoneOverride`. Wins over the global typography zone
 * for its section; global fills any unset fields.
 *
 * Extended 2026-05-19 (Wave 3A) to include product-card and category-card roles so
 * per-section blocks can host all section-specific zones. The global "Default
 * typography" card now shows only truly platform-wide zones (header / footer etc).
 */
export interface SectionTypographyOverride {
  heading?: ZoneOverride;
  kicker?: ZoneOverride;
  subtitle?: ZoneOverride;
  /** Body / paragraph override — non-title text inside this section. */
  body?: ZoneOverride;
  /** "View All" / "See All" link rendered at the bottom of a section. */
  seeAll?: ZoneOverride;
  /** Product name text on a product card within this section. */
  productName?: ZoneOverride;
  /** Product price text on a product card within this section. */
  productPrice?: ZoneOverride;
  /** Product CTA / "Add to cart" button text within this section. */
  productCta?: ZoneOverride;
  /** Category card label text within this section. */
  categoryLabel?: ZoneOverride;
}

export interface HeroSettings extends SectionBgOverride, SectionPaddingMaxWidthVisibility {
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
  /** Per-section typography overrides — wins over global typography zones. */
  typography?: SectionTypographyOverride;
  /** Per-section divider overrides — see SectionDividers. Default undefined (off). */
  dividers?: SectionDividers;
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
 *   xxs: 90 / 110     (true icon-tile, 2026-05-18 — denser than xs)
 *   xs:  120 / 140    (compact icon-tile)
 *   sm:  150 / 180    (Ahmad 2026-05-16 default — "smaller")
 *   md:  200 / 240    (medium balanced)
 *   lg:  240 / 300    (hero feature tile)
 *   xl:  280 / 360    (oversized, marketing-page only)
 */
export type CardSize = 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Per-store CARD FRAME BORDER WIDTH — independent of cardFrameStyle. Controls
 * the actual CSS border thickness used when showCardFrame is on.
 *   thin:   border (1px) — default, subtle
 *   normal: border-2 (2px) — visible but clean
 *   thick:  border-4 (4px) — bold, prominent
 *   xthick: border-8 (8px) — extra expressive
 */
export type CardFrameWidth = 'thin' | 'normal' | 'thick' | 'xthick';

/**
 * Per-store CARD FRAME SIZE — controls the padding (breathing room) between
 * the card content and the frame border. Independent of CardFrameWidth (border
 * line thickness). As Ahmad put it: "the frame may be large and the border thin".
 *   compact:     p-2  (8px)  — tight, dense grid
 *   normal:      p-3  (12px) — default, balanced
 *   comfortable: p-4  (16px) — generous breathing room
 *   spacious:    p-6  (24px) — editorial, premium
 */
export type CardFrameSize = 'compact' | 'normal' | 'comfortable' | 'spacious';

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

export interface CategoriesSettings
  extends SectionTitleOverride, SectionBgOverride, SectionPaddingMaxWidthVisibility {
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
  /** Border width when showCardFrame is on. Default 'thin' (1px). */
  cardFrameWidth?: CardFrameWidth;
  /** Frame padding (breathing room between content and border). Default 'normal' (12px). */
  cardFrameSize?: CardFrameSize;
  /** Hex color — applied as inline `style.borderColor` on the frame element. */
  cardFrameColor?: string;
  /** Per-section typography overrides — wins over global typography zones. */
  typography?: SectionTypographyOverride;
  /** Per-section divider overrides — see SectionDividers. Default undefined (off). */
  dividers?: SectionDividers;
}

export interface ProductCarouselSettings
  extends SectionTitleOverride, SectionBgOverride, SectionPaddingMaxWidthVisibility {
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
  /** Border width when showCardFrame is on. Default 'thin' (1px). */
  cardFrameWidth?: CardFrameWidth;
  /** Frame padding (breathing room between content and border). Default 'normal' (12px). */
  cardFrameSize?: CardFrameSize;
  /** Hex color — applied as inline `style.borderColor` on the frame element. */
  cardFrameColor?: string;
  /** Per-section typography overrides — wins over global typography zones. */
  typography?: SectionTypographyOverride;
  /** Per-section divider overrides — see SectionDividers. Default undefined (off). */
  dividers?: SectionDividers;
}

export interface FilterSidebarSettings {
  enabled: boolean;
  /** When false on desktop, opens collapsed; users click to expand */
  defaultOpen: boolean;
}

export interface ProductsPageSettings {
  /** Background colour for the products listing page (token:primary / hex / etc).
   *  Resolved via resolveColor on the storefront. Undefined = theme default. */
  bgColor?: string;
  /**
   * Aspect ratio for the main product image on the detail page (PDP).
   *   'square'    → aspect-square (1:1) — default
   *   'portrait'  → aspect-[3/4] — taller, fashion / lookbook
   *   'landscape' → aspect-[4/3] — wider, lifestyle
   *   'auto'      → keep current default (same as undefined)
   * Admin-controlled via page-builder → Products page section.
   */
  pdpImageAspect?: 'square' | 'portrait' | 'landscape' | 'auto';
}

export interface TestimonialsSettings
  extends SectionTitleOverride, SectionBgOverride, SectionPaddingMaxWidthVisibility {
  enabled: boolean;
  minRating: number;
  verifiedOnly: boolean;
  /** Per-section typography overrides — wins over global typography zones. */
  typography?: SectionTypographyOverride;
  /** Per-section divider overrides — see SectionDividers. Default undefined (off). */
  dividers?: SectionDividers;
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

/**
 * Brand Story block. Folded into page-builder 2026-05-20 (was only a theme
 * toggle in Branding before). Storefront content sourced from `store.heroImage`
 * + `store.description` / `store.descriptionAr`.
 */
export interface BrandStorySettings extends SectionBgOverride, SectionPaddingMaxWidthVisibility {
  /** When false, hide the block on storefront. Legacy fallback: `theme.showBrandStory`. */
  enabled?: boolean;
  /** Per-section typography overrides. */
  typography?: SectionTypographyOverride;
  /** Per-section divider slots. */
  dividers?: SectionDividers;
}

/**
 * Trust Strip — 3 trust-signal badges (free delivery / returns / support).
 * Folded into page-builder 2026-05-20.
 */
export interface TrustStripSettings extends SectionBgOverride, SectionPaddingMaxWidthVisibility {
  /** When false, hide on storefront. Legacy fallback: `theme.showTrustStrip`. */
  enabled?: boolean;
  /** Horizontal (3-up tight) or vertical (stacked). Default 'horizontal'.
   *  Legacy fallback: `theme.trustStripLayout`. */
  layout?: 'horizontal' | 'vertical';
  /** Scales icons + labels together. Default 'md'.
   *  Legacy fallback: `theme.trustStripSize`. */
  size?: 'sm' | 'md' | 'lg';
  typography?: SectionTypographyOverride;
  dividers?: SectionDividers;
}

/**
 * Home blog carousel. Folded into page-builder 2026-05-20.
 * Note: per-store `Store.blogEnabled` column ALSO gates the /blog routes —
 * this section's `enabled` controls homepage placement only.
 */
export interface BlogCarouselSettings extends SectionBgOverride, SectionPaddingMaxWidthVisibility {
  /** When false, hide carousel on home. Legacy fallback: `store.blogEnabled`. */
  enabled?: boolean;
  /** Max posts to render. Default 6. */
  limit?: number;
  typography?: SectionTypographyOverride;
  dividers?: SectionDividers;
}

/**
 * Section duplication (page-builder 2026-05-20) — merchants can add extra
 * product carousels to the homepage beyond newArrivals + bestSellers
 * (e.g. "Featured", "Editor's Picks", "Back in Stock"). Each extra has a
 * unique id and a productSource that determines which products it shows.
 *
 * v1 productSource options:
 *   - `'newest'` — most recent products (mirrors newArrivals's source)
 *   - `'best_seller'` — top-selling products (mirrors bestSellers)
 *   - `'featured'` — products tagged isFeatured=true
 *
 * v2 will add `'category:<id>'` (carousel filtered to a single category)
 * and `'manual:<id[]>'` (curated list of product ids).
 */
export type ExtraCarouselSource = 'newest' | 'best_seller' | 'featured' | 'category' | 'manual';

export interface ExtraCarouselSettings extends ProductCarouselSettings {
  /** Unique id (uuid). Required for stable ordering + admin keying. */
  id: string;
  /** Product source — determines which products appear in the carousel. */
  productSource: ExtraCarouselSource;
  /** When productSource === 'category', filter products by this category slug.
   *  Falls back to 'newest' if the slug doesn't match any fetched products. */
  categorySlug?: string;
  /** When productSource === 'category', how many products to fetch from the
   *  category before applying carousel.limit. Default 50. Bump higher (up to
   *  200) for large categories where the carousel needs visibility into more
   *  than the first 50 products (e.g. a sort filter applied at the carousel
   *  layer). Each extra slot costs +1 server fetch + bigger JSON payload. */
  categoryFetchLimit?: number;
  /** When productSource === 'manual', the list of product ids to render in
   *  the carousel. Falls back to 'newest' when the list is empty. */
  manualProductIds?: string[];
}

/**
 * Header chrome — folded into page-builder 2026-05-20. v1 ships
 * bg/typography/dividers/sticky. Per-theme chrome (logo size, nav layout)
 * deferred to v2 — needs all 5 theme Header components to accept per-section
 * props.
 */
export interface HeaderSettings extends SectionBgOverride, SectionPaddingMaxWidthVisibility {
  enabled?: boolean;
  sticky?: boolean;
  typography?: SectionTypographyOverride;
  dividers?: SectionDividers;
}

/** Footer chrome — folded into page-builder 2026-05-20. */
export interface FooterSettings extends SectionBgOverride, SectionPaddingMaxWidthVisibility {
  enabled?: boolean;
  typography?: SectionTypographyOverride;
  dividers?: SectionDividers;
}

/**
 * Announcement bar — folded into page-builder 2026-05-20. Content (text +
 * link) still lives at `theme.announcement`. This layout entry controls
 * visibility + visual chrome only.
 */
export interface AnnouncementSectionSettings
  extends SectionBgOverride, SectionPaddingMaxWidthVisibility {
  enabled?: boolean;
  typography?: SectionTypographyOverride;
  dividers?: SectionDividers;
}

/**
 * Global product-card defaults — drives the PLP, category, search, and
 * any non-homepage product-card surface. Homepage carousels
 * (newArrivals / bestSellers) read their own fields first and fall back
 * to these defaults when a per-section override is unset.
 *
 * Added 2026-05-18 because card-size / frame controls used to stop at
 * the homepage edge; merchants couldn't change PLP card density or
 * frame color without a code change.
 */
export interface ProductCardDefaults {
  cardSize?: CardSize;
  cardAspect?: CardAspect;
  cardShape?: CardShape;
  cardGap?: CardGap;
  showLabel?: boolean;
  showHover?: boolean;
  showCardFrame?: boolean;
  cardFrameStyle?: 'soft' | 'outline' | 'shadow' | 'paper';
  /** Border width when showCardFrame is on. Default 'thin' (1px). */
  cardFrameWidth?: CardFrameWidth;
  /** Frame padding (breathing room between content and border). Default 'normal' (12px). */
  cardFrameSize?: CardFrameSize;
  /** Hex color — applied as inline `style.borderColor` on the frame element. */
  cardFrameColor?: string;
  /**
   * Per-section typography overrides for catalog-wide product card defaults.
   * Covers productName / productPrice / productCta — the same roles that
   * appear on per-section product-grid cards. Added 2026-05-19 (Wave 3A).
   */
  typography?: SectionTypographyOverride;
}

export interface StoreLayoutSettings {
  hero: HeroSettings;
  categories: CategoriesSettings;
  newArrivals: ProductCarouselSettings;
  bestSellers: ProductCarouselSettings;
  filterSidebar: FilterSidebarSettings;
  testimonials: TestimonialsSettings;
  reviewSection: ReviewSectionSettings;
  /** Brand story block on homepage. Page-builder 2026-05-20. */
  brandStory?: BrandStorySettings;
  /** Trust strip badges on homepage. Page-builder 2026-05-20. */
  trustStrip?: TrustStripSettings;
  /** Homepage blog carousel. Page-builder 2026-05-20. */
  blogCarousel?: BlogCarouselSettings;
  /** Announcement bar chrome. Page-builder 2026-05-20. */
  announcement?: AnnouncementSectionSettings;
  /** Header chrome. Page-builder 2026-05-20. */
  header?: HeaderSettings;
  /** Footer chrome. Page-builder 2026-05-20. */
  footer?: FooterSettings;
  /** Extra duplicated product carousels (section duplication). v1 renders
   *  in array order after testimonials; v2 will integrate with sectionOrder. */
  extraCarousels?: ExtraCarouselSettings[];
  sizing: SizingContract;
  /** Defaults applied to all non-homepage product-card surfaces. */
  productCardDefaults?: ProductCardDefaults;
  /** Products listing page (PLP) settings. Page-builder configurable. */
  productsPage?: ProductsPageSettings;
  /**
   * Drag-to-reorder data model (page-builder 2026-05-20, scaffolded for v2 ui).
   * When set, HomePageContent renders sections in this order instead of the
   * hardcoded sequence. Unknown keys are skipped; missing known keys append
   * at the end so new sections appear automatically on existing stores.
   */
  sectionOrder?: Array<
    | 'hero'
    | 'categories'
    | 'newArrivals'
    | 'bestSellers'
    | 'brandStory'
    | 'blogCarousel'
    | 'trustStrip'
    | 'testimonials'
  >;
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
  productsPage: {},
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
    productsPage: { ...DEFAULT_LAYOUT_SETTINGS.productsPage, ...(raw.productsPage ?? {}) },
    testimonials: { ...DEFAULT_LAYOUT_SETTINGS.testimonials, ...(raw.testimonials ?? {}) },
    reviewSection: { ...DEFAULT_LAYOUT_SETTINGS.reviewSection, ...(raw.reviewSection ?? {}) },
    brandStory: raw.brandStory,
    trustStrip: raw.trustStrip,
    blogCarousel: raw.blogCarousel,
    announcement: raw.announcement,
    header: raw.header,
    footer: raw.footer,
    extraCarousels: raw.extraCarousels,
    sizing: { ...DEFAULT_LAYOUT_SETTINGS.sizing, ...(raw.sizing ?? {}) },
    productCardDefaults: { ...(raw.productCardDefaults ?? {}) },
    sectionOrder: raw.sectionOrder,
  };
}
