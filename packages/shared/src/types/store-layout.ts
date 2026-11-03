/**
 * Store layout settings — controls which sections appear on the storefront
 * home page and how they render. Persisted as JSONB on `stores.layout_settings`.
 *
 * The storefront, the admin "Layout" page, and the API all consume this
 * single contract. Empty `{}` on the column means "use packaged defaults" —
 * `resolveLayoutSettings()` merges with `DEFAULT_LAYOUT_SETTINGS` so existing
 * tenants don't need a backfill.
 *
 * Defaults match the Storefront flow (see
 * docs/superpowers/specs/2026-04-26-demo-store-home-flow-design.md): hero
 * slider, 3-up category grid with caption-below, both product carousels,
 * filter sidebar on PLP, testimonials.
 */

import type { LegacyHomeSectionKey } from '../builder/section-keys';
import type { TemplateId } from './store-theme';
import { getTemplateBaseline } from './template-baselines';
import { getLook } from '../looks/registry';

export type HeroMode = 'single' | 'slider';

/**
 * Per-section layout knobs added 2026-05-20 (item #6 of the page-builder
 * gap fill). Every section settings interface that extends these gets
 * padding-top/bottom, max-width override, and breakpoint visibility.
 *
 * Defaults: all undefined (= storefront baseline behavior unchanged).
 * Merchants opt in per-section.
 */
export type SectionSpacingPreset = 'none' | 'tight' | 'normal' | 'loose' | 'xloose' | 'xxloose';

export interface SectionPaddingMaxWidthVisibility {
  /** Vertical padding above the section content. Default: section's baseline. */
  paddingTop?: SectionSpacingPreset;
  /** Vertical padding below the section content. */
  paddingBottom?: SectionSpacingPreset;
  /**
   * Per-device spacing (editor Ruling SP-1). Unset = the base value above applies on that device.
   * The builder adapter maps these to `responsive.<tablet|mobile>.settings.paddingTop|Bottom`.
   */
  paddingTopTablet?: SectionSpacingPreset;
  paddingTopMobile?: SectionSpacingPreset;
  paddingBottomTablet?: SectionSpacingPreset;
  paddingBottomMobile?: SectionSpacingPreset;
  /** Container width — 'contained' = max-w-7xl, 'full' = edge-to-edge. */
  maxWidth?: 'contained' | 'full';
  /** Hide on mobile (< 768px viewport). Default false. */
  hideOnMobile?: boolean;
  /** Hide on desktop (≥ 768px viewport). Default false. */
  hideOnDesktop?: boolean;
  /**
   * Visual builder (BUILDER-PREVIEW-1): hide on tablet (768–1023px) only.
   * Unset = legacy behaviour, where `hideOnDesktop` covers every width
   * from 768px up. Set (true OR false) = three-way mode: `hideOnDesktop`
   * then means >= 1024px only. Written by the builder adapter when a
   * document's tablet and desktop visibility differ.
   */
  hideOnTablet?: boolean;
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

/** Where a cropped hero image keeps its subject (Ruling B1-32). */
export type HeroFocus = 'top' | 'center' | 'bottom';
/** CSS object-position for a hero focus; `center` (or unset) is the browser default. */
export const HERO_FOCUS_POSITION: Record<HeroFocus, string> = {
  top: '50% 0%',
  center: '50% 50%',
  bottom: '50% 100%',
};
export function heroObjectPosition(focus: HeroFocus | undefined | null): string | undefined {
  return focus && focus !== 'center' ? HERO_FOCUS_POSITION[focus] : undefined;
}

export interface HeroSlide {
  /**
   * Desktop image — R2 URL. Recommended 1920×800 (aspect 2.4:1) so the
   * full-bleed hero looks cinematic on widescreens without croppingthe
   * subject too tightly.
   */
  // Optional to match `heroSlideSchema` (a draft may hold a just-added slide
  // with no image chosen yet — bug: "hero slide with no image blocks ALL
  // autosave"). A PUBLISHED document always has one: `validatePublishReadiness`
  // refuses to publish any visible slide without it.
  image?: string;
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
  /** Optional muted looping background video (R2 URL). The slide image is its poster. */
  video?: string;
  /** Mobile video; falls back to `video`. */
  videoMobile?: string;
  /** Image focus for the cropped hero (object-position): `top` keeps a head in frame (B1-32). */
  focus?: HeroFocus;
  alt?: string;
  /** Optional headline rendered as overlay — pack styles vary */
  headline?: string;
  headlineAr?: string;
  /** Optional CTA */
  ctaText?: string;
  ctaTextAr?: string;
  ctaHref?: string;
  /**
   * Optional "banner link" — when set, the WHOLE slide becomes a clickable
   * marketing space (stretched-link pattern) in addition to the CTA button
   * above, which keeps its own destination and wins the click (it sits on
   * top). Single, non-bilingual (mirrors `ctaHref`) — a URL doesn't need
   * translation. Empty/unset = today's behavior, zero change (slide is not
   * clickable outside the CTA button).
   */
  link?: string;
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
   *   - `'collage'` (Phase B1, Ruling B1-2) — three slide photos overlap in a
   *     collage with one headline + CTA below them on the page colour
   *     (`HeroCollage`, every skin). Needs >= 3 slides with images; with fewer
   *     the hero renders as the full-bleed banner/slider.
   * Merchants pick via Admin → Layout → Hero. Optional — undefined
   * preserves the existing full-bleed default for back-compat.
   */
  presentation?: 'full-bleed' | 'framed' | 'collage';
  /**
   * Ruling B1-41: `'line'` draws a hairline in the line colour inside a FRAMED hero, drawn in once,
   * and the photo fills the frame (cover + focus). Absent / `'none'` = framed as before
   * (whole image, letterboxed). Ignored unless `presentation === 'framed'`.
   */
  frame?: 'none' | 'line';
  /**
   * W2a (L-04): where the copy sits on a cropped hero. `'bottom-start'` puts the headline, line
   * and button at the bottom inline-start corner on a gradient scrim that covers only the text
   * block (>= 60% of the photo stays clear); absent / `'center'` = the centred overlay as before.
   * Atelier's and Vitrine's mixes set `'bottom-start'`; a merchant can pick either.
   */
  textAnchor?: 'center' | 'bottom-start';
  /** Per-section typography overrides — wins over global typography zones. */
  typography?: SectionTypographyOverride;
  /** Per-section divider overrides — see SectionDividers. Default undefined (off). */
  dividers?: SectionDividers;
}

/**
 * `rail` = a snap row of image tiles, `tiles` = square tiles (Souq, Phase B2); every skin renders
 * them (look data, never forked commerce code).
 */
export type CategoriesLayout = 'grid' | 'horizontal' | 'chips' | 'rail' | 'tiles';
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
export type CardAspect = 'theme' | 'square' | 'portrait' | 'landscape' | 'wide' | 'ultrawide';

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
  // mobile (demo-store pattern), or caption-below on desktop + caption-
  // over on mobile (compact card style). Legacy single-field `layout`
  // and `captionPosition` retained for back-compat — when both new
  // breakpoint fields are unset, the legacy field applies to both.
  layout: CategoriesLayout;
  layoutMobile?: CategoriesLayout;
  /**
   * What the row lists (Phase B3, Ruling B3-5): the store's categories (default, absent) or its
   * TAGS (`tags`, the skin-type / concern chips). `tags` is rendered as chips whatever the layout,
   * each linking to the PLP filtered by that tag; a tag with no published product is never shown.
   */
  source?: 'categories' | 'tags';
  /** `aisles` (Phase B4, Ruling B4-2): square tiles take the look's aisle tints; names always show. */
  tint?: 'none' | 'aisles';
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
  /**
   * Merchant-controlled background color for the desktop sidebar panel.
   * Accepts a brand token ('token:primary' | 'token:card' | …) or a hex
   * value. When unset, the sidebar falls back to the CSS-variable driven
   * default (hsl(var(--primary))) — keeping the existing look for all
   * stores that haven't opted in.
   */
  bgColor?: string;
  /**
   * Merchant-controlled text/icon color for the desktop sidebar panel.
   * Accepts a brand token or hex. When unset, inherits
   * hsl(var(--primary-foreground)) — the existing default.
   */
  textColor?: string;
}

/** Aspect-ratio choices for the PDP main image. */
export type PdpImageAspect = 'square' | 'portrait' | 'landscape' | 'wide' | 'ultrawide' | 'auto';

/**
 * Per-page light/dark surface override for the smart auto-contrast system.
 *   'auto'  → decide from the background colour's lightness (default)
 *   'light' → keep the default light palette (dark text) regardless of bg
 *   'dark'  → force the derived dark palette (light text) regardless of bg
 * Lets a merchant correct a mid-tone background the auto-detection misjudges.
 */
export type PageColorScheme = 'auto' | 'light' | 'dark';

/**
 * Per-page spacing density. Scales the page's vertical padding + rhythm so the
 * merchant gets a tighter or airier page without hand-tuning every gap.
 *   'compact'  → tighter vertical spacing
 *   'normal'   → default (no change)
 *   'spacious' → airier vertical spacing
 */
export type PageDensity = 'compact' | 'normal' | 'spacious';

/**
 * Per-page text-size scale. One dial that scales all of the page's typography
 * controls together (heading / subtitle / name / price / label / cta) instead
 * of editing each zone's font size individually.
 *   'sm' → 0.9×   'normal' → 1×   'lg' → 1.15×   'xl' → 1.3×
 */
export type PageTextScale = 'sm' | 'normal' | 'lg' | 'xl';

export interface ProductsPageSettings {
  /** Background colour for the products listing page (token:primary / hex / etc).
   *  Resolved via resolveColor on the storefront. Undefined = theme default. */
  bgColor?: string;
  /** Light/dark surface override for the auto-contrast system. Default 'auto'. */
  colorScheme?: PageColorScheme;
  /** Spacing density — scales the page's vertical padding. Default 'normal'. */
  density?: PageDensity;
  /** Text-size scale — scales all of this page's typography controls. Default 'normal'. */
  textScale?: PageTextScale;
  /**
   * PLP typography — breadcrumb + secondary text use `subtitle`, the "All
   * Products" H1 uses `heading`. Applied inline so it beats the page's Tailwind
   * size classes. Reuses the shared SectionTypographyBlock admin control.
   */
  typography?: SectionTypographyOverride;
  /**
   * @deprecated Moved to ProductDetailPageSettings.imageAspect. Kept readable
   * for back-compat; the admin now writes the aspect to `productDetailPage`.
   */
  pdpImageAspect?: PdpImageAspect;
}

/**
 * Standalone background + typography for the PRODUCT DETAIL page (PDP). Split
 * out of ProductsPageSettings so "Products list" and "Product detail" are two
 * clearly-separate cards in the page-builder.
 */
export interface ProductDetailPageSettings {
  /** Background colour for the product detail page. Undefined = theme default. */
  bgColor?: string;
  /** Light/dark surface override for the auto-contrast system. Default 'auto'. */
  colorScheme?: PageColorScheme;
  /** Spacing density — scales the page's vertical padding. Default 'normal'. */
  density?: PageDensity;
  /** Text-size scale — scales all of this page's typography controls. Default 'normal'. */
  textScale?: PageTextScale;
  /** Aspect ratio for the main product image. Undefined / 'auto' = square. */
  imageAspect?: PdpImageAspect;
  /**
   * PDP typography — product name uses `productName`, price uses `productPrice`,
   * section headings (e.g. description / related) use `heading`. Applied inline.
   */
  typography?: SectionTypographyOverride;
}

/**
 * Standalone background + typography for the CATEGORIES listing page.
 */
export interface CategoriesPageSettings {
  /** Background colour for the categories page. Undefined = theme default. */
  bgColor?: string;
  /** Light/dark surface override for the auto-contrast system. Default 'auto'. */
  colorScheme?: PageColorScheme;
  /** Spacing density — scales the page's vertical padding. Default 'normal'. */
  density?: PageDensity;
  /** Text-size scale — scales all of this page's typography controls. Default 'normal'. */
  textScale?: PageTextScale;
  /** Page heading uses `heading`, secondary text uses `subtitle`, category card
   *  labels use `categoryLabel`. Applied inline. */
  typography?: SectionTypographyOverride;
}

/**
 * Standalone background + typography for the LOCATIONS page.
 */
export interface LocationsPageSettings {
  /** Background colour for the locations page. Undefined = theme default. */
  bgColor?: string;
  /** Light/dark surface override for the auto-contrast system. Default 'auto'. */
  colorScheme?: PageColorScheme;
  /** Spacing density — scales the page's vertical padding. Default 'normal'. */
  density?: PageDensity;
  /** Text-size scale — scales all of this page's typography controls. Default 'normal'. */
  textScale?: PageTextScale;
  /** Page heading uses `heading`, address / hours text uses `subtitle`,
   *  branch name uses `body`. Applied inline. */
  typography?: SectionTypographyOverride;
}

/**
 * Standalone background + typography for the CHECKOUT / payment page.
 */
export interface CheckoutPageSettings {
  /** Background colour for the checkout page. Undefined = theme default. */
  bgColor?: string;
  /** Light/dark surface override for the auto-contrast system. Default 'auto'. */
  colorScheme?: PageColorScheme;
  /** Spacing density — scales the page's vertical padding. Default 'normal'. */
  density?: PageDensity;
  /** Text-size scale — scales all of this page's typography controls. Default 'normal'. */
  textScale?: PageTextScale;
  /** Headings use `heading`, labels use `subtitle`, amounts use `productPrice`. */
  typography?: SectionTypographyOverride;
}

/**
 * Standalone typography + background control for the CART page. Independent
 * of `productCardDefaults` (which drives product *cards*) and of the global
 * typography zones. The storefront applies these as INLINE styles on the cart
 * line item name / price, so they reliably win over the hardcoded Tailwind
 * size classes on those elements. Admin-controlled via page-builder → Cart page.
 */
export interface CartPageSettings {
  /** Background colour for the cart page. Resolved via resolveColor. Undefined = theme default. */
  bgColor?: string;
  /** Light/dark surface override for the auto-contrast system. Default 'auto'. */
  colorScheme?: PageColorScheme;
  /** Spacing density — scales the page's vertical padding. Default 'normal'. */
  density?: PageDensity;
  /** Text-size scale — scales all of this page's typography controls. Default 'normal'. */
  textScale?: PageTextScale;
  /**
   * Cart typography overrides — applied inline so they win over the theme cart
   * components' own classes. Roles:
   *   heading      → page title, "Order summary", Total
   *   subtitle     → labels (items count, subtotal / shipping rows)
   *   productName  → line-item names
   *   productPrice → every monetary value
   *   productCta   → buttons + links (remove, continue shopping, apply, checkout)
   */
  typography?: SectionTypographyOverride;
}

export interface TestimonialsSettings
  extends SectionTitleOverride, SectionBgOverride, SectionPaddingMaxWidthVisibility {
  enabled: boolean;
  minRating: number;
  verifiedOnly: boolean;
  /** `'single'` = one large customer quote (Ruling B1-2, Vitrine); absent = the row. */
  layout?: 'row' | 'single';
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
export interface TrustStripItem {
  /** Optional glyph key (the trust-badge icon set). */
  icon?: string;
  title?: string;
  titleAr?: string;
  /** Optional one-line subtitle. */
  text?: string;
  textAr?: string;
}

export interface TrustStripSettings extends SectionBgOverride, SectionPaddingMaxWidthVisibility {
  /** When false, hide on storefront. Legacy fallback: `theme.showTrustStrip`. */
  enabled?: boolean;
  /**
   * The merchant's own trust items. ABSENT (key not stored) = a store that
   * predates editable items: the storefront keeps rendering the three fixed
   * legacy defaults. PRESENT (even `[]`) = merchant-owned: only these items
   * render, and an empty list hides the strip. New stores are provisioned
   * with `items: []`, so they show nothing until the merchant adds items.
   */
  items?: TrustStripItem[];
  /** Horizontal (3-up tight) or vertical (stacked). Default 'horizontal'.
   *  Legacy fallback: `theme.trustStripLayout`. */
  layout?: 'horizontal' | 'vertical';
  /** Scales icons + labels together. Default 'md'.
   *  Legacy fallback: `theme.trustStripSize`. */
  size?: 'sm' | 'md' | 'lg';
  /** Icon glyph color (the line-art SVG). Accepts a `token:<name>` brand token
   *  or a literal hsl/hex. When unset, falls back to the brand `--primary`
   *  token (or the auto-contrast color when a custom `bgColor` is set). */
  iconColor?: string;
  /** Icon circle background color. Accepts a `token:<name>` brand token or a
   *  literal hsl/hex. When unset, falls back to `--primary` at 10% opacity
   *  (or the auto-contrast tint when a custom `bgColor` is set). */
  iconBgColor?: string;
  /** Title + subtitle text color. Accepts a `token:<name>` brand token or a
   *  literal hsl/hex. When unset, the labels use the auto-contrast foreground
   *  (when a custom `bgColor` is set) or the default `--foreground` token. */
  textColor?: string;
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
/**
 * `on_sale` (Phase B2): products whose compare-at price exceeds their price (a variant product:
 * any variant on sale), biggest drop first. BOUNDED-stale (rides the tagged public product caches).
 * `reorder` (Phase B4, Ruling B4-8): the signed-in customer's own last products, "order again".
 * Resolved in the browser from `GET /public/customers/me/reorder`; anonymous or first-time
 * shoppers see nothing (an unfilled feature renders nothing).
 */
export type ExtraCarouselSource =
  | 'newest'
  | 'best_seller'
  | 'featured'
  | 'on_sale'
  | 'category'
  | 'manual'
  | 'reorder';

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
 * Mobile bottom tab bar color overrides (page-builder 2026-06-17).
 *
 * All three fields are OPTIONAL. When unset, the tab bar falls back to its
 * existing class-based defaults (bg-[hsl(var(--bg-section-alt))], active =
 * foreground, inactive = foreground/60). There is NO visual change for stores
 * that never touch these settings — the existing look is preserved exactly.
 *
 * Values are hex ('#RRGGBB') or 'token:<name>' — resolved on the storefront
 * via `resolveColor(value, store.theme)` so brand tokens compose correctly.
 */
export interface BottomBarSettings {
  /** Bar background. Overrides `bg-[hsl(var(--bg-section-alt))]` when set. */
  bgColor?: string;
  /** Active icon / label color + active-pill tint (pill = activeColor at 10 % opacity). */
  activeColor?: string;
  /** Inactive icon / label color. Overrides `text-foreground/60` when set. */
  inactiveColor?: string;
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
/**
 * Image aspect-ratio choices for product/category card image wrappers.
 * Separate from CardAspect which drives the carousel layout; these apply
 * specifically to the image container inside the card.
 *   '1:1'  → square (default compact-ecommerce baseline)
 *   '4:5'  → fashion portrait
 *   '3:4'  → tall portrait (lookbook / clothing)
 *   '16:9' → wide landscape (lifestyle / banner)
 *   'auto' → natural — no forced ratio, image fills its natural height
 */
export type CardImageAspect = '1:1' | '4:5' | '3:4' | '16:9' | 'auto';

/**
 * Corner-radius scale for card image wrappers. Controls the `border-radius`
 * of the image container (not the card frame — that's cardFrameStyle).
 *   'none' → no rounding (sharp corners)
 *   'sm'   → slight rounding (4px)
 *   'md'   → moderate rounding (8px, compact-ecommerce default)
 *   'lg'   → prominent rounding (16px)
 *   'full' → pill / circle (max border-radius, for circle-style cards)
 */
export type CardImageRadius = 'none' | 'sm' | 'md' | 'lg' | 'full';

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
  /**
   * Item 8 — per-card image aspect ratio for card image wrappers.
   * When set, overrides the template's default aspect on the card image container.
   * Applies to product cards on PLP / carousels / category listings.
   * Default undefined → template decides (existing behavior preserved).
   */
  cardImageAspect?: CardImageAspect;
  /**
   * Item 8 — per-card image corner radius for card image wrappers.
   * When set, overrides the card's default border-radius on the image container.
   * Default undefined → theme/template decides (existing behavior preserved).
   */
  cardImageRadius?: CardImageRadius;
  /**
   * Item 9 — show / hide the product name below the card image.
   * Default undefined / true → name always visible (current behavior).
   * When false, the name is hidden on all card surfaces.
   */
  showCardName?: boolean;
  /**
   * Item 9 — show / hide the product price below the card image.
   * Composes with the store-level `showPriceOnCards` flag (StoreTheme):
   * either flag being false suppresses the price.
   * Default undefined / true → price visible (current behavior).
   */
  showCardPrice?: boolean;
  /** CTA button on cards: visual + behavior. All optional; unset = current behavior. */
  ctaLabel?: boolean; // show a text label on the CTA (default: existing per-theme)
  ctaLabelTextEn?: string; // override label text (EN); empty = theme default ("View"/"Add to cart")
  ctaLabelTextAr?: string; // override label text (AR)
  ctaSize?: 'sm' | 'md' | 'lg'; // CTA button size; unset = derive from cardSize
  ctaShape?: 'rounded' | 'pill' | 'square' | 'soft'; // unset = theme default
  ctaColor?: string; // token:* or hex; unset = token:primary / theme default
  ctaTextColor?: string; // token:* or hex; unset = contrast-guarded default
  /** Out-of-stock label badge: shape/size/placement/color, independent of CTA. */
  oosLabel?: boolean; // show the OOS label badge (default true = current ribbon)
  oosLabelTextEn?: string; // default "Sold Out"
  oosLabelTextAr?: string; // default "نفدت الكمية"
  oosLabelShape?: 'rounded' | 'pill' | 'square' | 'soft';
  oosLabelPlacement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
  oosLabelColor?: string; // bg color, token:* or hex
  oosLabelTextColor?: string; // text color
  /** When OOS, dim the View/Add CTA in this color instead of disabling silently. */
  oosDimColor?: string;
  /** Product-name case override (Task 6 uses this too). */
  productNameCase?: 'normal' | 'uppercase';
  /**
   * CTA mode — controls what the CTA button shows on no-variant products.
   *   'auto'     (default / unset) — current behavior: variant products show
   *              "View" link; no-variant in-stock products show inline
   *              "Add to Cart" button; OOS is disabled.
   *   'viewOnly' — EVERY card shows a "View" link to the PDP, regardless
   *              of whether the product has variants. No inline add-to-cart
   *              button appears even when a no-variant product is in stock.
   *              OOS state still applies (card still shows as disabled/dim).
   */
  ctaMode?: 'auto' | 'viewOnly';
  /**
   * Discount/sale badge ("Save X" / "-X%") corner + color, sibling to
   * ctaShape/oosLabel*. Position uses PHYSICAL corners (not logical
   * start/end) so "bottom-left" renders at the physical bottom-left in
   * BOTH LTR and RTL storefronts — unlike oosLabelPlacement, this badge
   * must NOT mirror with reading direction. Unset position defaults to
   * the image's top corner on the reading-START side at render time (#1998,
   * `pinDefaultDiscountBadge` in apps/web/src/templates/shared/custom-badge.ts),
   * or to the legacy 'bottom-left' when the store keeps
   * `StoreTheme.saleBadgeLegacyCorner`. An explicit position is physical and
   * never mirrors.
   * Unset color defaults to the platform destructive/red token.
   */
  discountBadge?: {
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    color?: string; // token:* or hex; unset = theme destructive/red default
  };
  /**
   * Custom (merchant-authored) product badge corner + color — the sibling of
   * `discountBadge` for the free-text `Product.badgeLabel` / `badgeLabelAr`
   * chip. Deliberately the same shape and the same PHYSICAL-corner semantics:
   * "bottom-right" is the physical bottom-right on LTR and RTL storefronts
   * alike, so a merchant's chosen corner does not jump when a shopper
   * switches language.
   *
   * Unset position defaults to 'bottom-right' at render time
   * (apps/web/src/templates/shared/custom-badge.ts) — deliberately NOT the
   * discount badge's 'bottom-left' default, so a store that configures
   * neither gets the two badges in two different corners instead of a
   * suppression. Unset color defaults to the platform primary token.
   *
   * NOTE: this block only styles the badge. Whether it renders at all is
   * per-product data (`Product.badgeLabel`), not a layout setting — there is
   * no "enable custom badges" toggle by design, because an empty label
   * already means off.
   */
  customBadge?: {
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    color?: string; // token:* or hex; unset = theme primary default
  };
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
  /** Product detail page (PDP) — background, image aspect, typography. */
  productDetailPage?: ProductDetailPageSettings;
  /** Categories listing page — background + typography. */
  categoriesPage?: CategoriesPageSettings;
  /** Locations listing page — background + typography. */
  locationsPage?: LocationsPageSettings;
  /** Checkout / payment page — background + typography. */
  checkoutPage?: CheckoutPageSettings;
  /** Cart page settings (standalone background + typography). Page-builder configurable. */
  cartPage?: CartPageSettings;
  /** Mobile bottom tab bar color overrides. Page-builder 2026-06-17. When unset,
   *  the tab bar uses its existing class-based defaults (no visual change). */
  bottomBar?: BottomBarSettings;
  /**
   * Drag-to-reorder data model (page-builder 2026-05-20, scaffolded for v2 ui).
   * When set, HomePageContent renders sections in this order instead of the
   * hardcoded sequence. Unknown keys are skipped; missing known keys append
   * at the end so new sections appear automatically on existing stores.
   */
  sectionOrder?: Array<LegacyHomeSectionKey>;
}

/**
 * Runtime tuple of every top-level key on `StoreLayoutSettings`.
 *
 * This array is the guard against the recurring silent-strip bug: the API
 * `layoutSchema` is a strict `z.object({...}).partial()` with NO
 * `.passthrough()`. Any top-level key NOT listed in that Zod shape is silently
 * dropped on every PUT, so a merchant's save "succeeds" but the field is
 * quietly gone. (History: productsPage, cartPage, locationsPage, bottomBar
 * each recurred ~4 times because there was no automated check.)
 *
 * The compile-time assertions below keep this array in sync with the interface:
 *   _AssertKeysCover  → every array entry IS a key on StoreLayoutSettings
 *   _AssertKeysComplete → every key on StoreLayoutSettings IS in the array
 * Adding a key to the interface without adding it here is a TypeScript error.
 *
 * The runtime test at `tests/unit/layout-schema-parity.test.ts` consumes this
 * array to assert that EVERY key here is also in the API's Zod schema.
 */
export const LAYOUT_TOP_LEVEL_KEYS = [
  'hero',
  'categories',
  'newArrivals',
  'bestSellers',
  'filterSidebar',
  'testimonials',
  'reviewSection',
  'brandStory',
  'trustStrip',
  'blogCarousel',
  'announcement',
  'header',
  'footer',
  'extraCarousels',
  'sizing',
  'productCardDefaults',
  'productsPage',
  'productDetailPage',
  'categoriesPage',
  'locationsPage',
  'checkoutPage',
  'cartPage',
  'bottomBar',
  'sectionOrder',
] as const;

// Compile-time assertions — both must remain true.
// Adding a key to StoreLayoutSettings without adding it to the array above is
// a TypeScript error ("Type 'false' is not assignable to type 'true'").
type _AssertKeysCover = (typeof LAYOUT_TOP_LEVEL_KEYS)[number] extends keyof StoreLayoutSettings
  ? true
  : false;
type _AssertKeysComplete = keyof StoreLayoutSettings extends (typeof LAYOUT_TOP_LEVEL_KEYS)[number]
  ? true
  : false;
/** @internal compile-time assertion — do not use at runtime */
export const _layoutKeysCoversInterface: _AssertKeysCover = true;
/** @internal compile-time assertion — do not use at runtime */
export const _layoutInterfaceCoversKeys: _AssertKeysComplete = true;

/**
 * `stores.layout_settings` for a store created from now on. Only what must
 * differ from "empty object = packaged defaults": the trust strip is
 * merchant-owned (`items: []` = hidden until they write items). A store whose
 * column is `{}` or lacks `trustStrip.items` keeps the fixed legacy items, so
 * existing stores render exactly as before. Written by `ProvisioningService`
 * and `StoreService.create`.
 */
export const NEW_STORE_LAYOUT_SETTINGS = {
  trustStrip: { items: [] },
} satisfies Pick<StoreLayoutSettings, 'trustStrip'>;

/**
 * Storefront flow defaults. When a tenant's `layout_settings` column is `{}`
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
  productDetailPage: {},
  categoriesPage: {},
  locationsPage: {},
  checkoutPage: {},
  cartPage: {},
  testimonials: {
    // Default OFF for new stores. The fake-reviews-illegal posture
    // (consumer-protection fines and closure in several markets; FTC 2024 rule; EU
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
 * A layout baseline minus the product-card keys that would pick an image ratio
 * (`cardShape` carries an aspect, `cardAspect` is one) on the two product carousels and
 * `productCardDefaults`. Used for look stores only: there the look's `--image-ratio` is the
 * default card ratio, and a skin baseline value would beat it on every card.
 */
function withoutBaselineCardRatio(base: StoreLayoutSettings): StoreLayoutSettings {
  const strip = <T extends object>(section: T): T => {
    const rest = { ...section } as T & { cardShape?: unknown; cardAspect?: unknown };
    delete rest.cardShape;
    delete rest.cardAspect;
    return rest;
  };
  return {
    ...base,
    newArrivals: strip(base.newArrivals),
    bestSellers: strip(base.bestSellers),
    ...(base.productCardDefaults ? { productCardDefaults: strip(base.productCardDefaults) } : {}),
  };
}

/**
 * Merge a partial / unknown blob from JSONB with the packaged defaults (or
 * the per-template baseline when `templateId` is supplied).
 *
 * Precedence: saved raw value > template baseline > DEFAULT_LAYOUT_SETTINGS.
 * Omitting `templateId` reproduces the legacy behavior exactly (base =
 * DEFAULT_LAYOUT_SETTINGS, optional keys undefined when not saved).
 */
export function resolveLayoutSettings(
  input: unknown,
  templateId?: TemplateId,
  /** The store's look id. A registered look owns the DEFAULT product-card image ratio
   *  (`--image-ratio`, Ruling LOOKS-15), so the skin baseline's product-card shape and
   *  aspect are left out; anything the merchant saved still wins. Null/unknown = legacy. */
  look?: string | null
): StoreLayoutSettings {
  const templateBase = templateId ? getTemplateBaseline(templateId) : DEFAULT_LAYOUT_SETTINGS;
  const base = getLook(look) ? withoutBaselineCardRatio(templateBase) : templateBase;
  if (!input || typeof input !== 'object') return base;
  const raw = input as Partial<StoreLayoutSettings>;

  return {
    hero: { ...base.hero, ...(raw.hero ?? {}) },
    categories: { ...base.categories, ...(raw.categories ?? {}) },
    newArrivals: { ...base.newArrivals, ...(raw.newArrivals ?? {}) },
    bestSellers: { ...base.bestSellers, ...(raw.bestSellers ?? {}) },
    filterSidebar: { ...base.filterSidebar, ...(raw.filterSidebar ?? {}) },
    productsPage: { ...base.productsPage, ...(raw.productsPage ?? {}) },
    productDetailPage: {
      ...base.productDetailPage,
      ...(raw.productDetailPage ?? {}),
    },
    categoriesPage: { ...base.categoriesPage, ...(raw.categoriesPage ?? {}) },
    locationsPage: { ...base.locationsPage, ...(raw.locationsPage ?? {}) },
    checkoutPage: { ...base.checkoutPage, ...(raw.checkoutPage ?? {}) },
    cartPage: { ...base.cartPage, ...(raw.cartPage ?? {}) },
    testimonials: { ...base.testimonials, ...(raw.testimonials ?? {}) },
    reviewSection: { ...base.reviewSection, ...(raw.reviewSection ?? {}) },
    // Optional sections: saved wins, else inherit the (template) base.
    // Use conditional spread so undefined values are omitted entirely from the
    // result — this preserves the legacy behavior where DEFAULT_LAYOUT_SETTINGS
    // has no optional keys at all (absent ≠ undefined for toEqual comparisons).
    ...((raw.brandStory ?? base.brandStory)
      ? { brandStory: raw.brandStory ?? base.brandStory }
      : {}),
    ...((raw.trustStrip ?? base.trustStrip)
      ? { trustStrip: raw.trustStrip ?? base.trustStrip }
      : {}),
    ...((raw.blogCarousel ?? base.blogCarousel)
      ? { blogCarousel: raw.blogCarousel ?? base.blogCarousel }
      : {}),
    ...((raw.announcement ?? base.announcement)
      ? { announcement: raw.announcement ?? base.announcement }
      : {}),
    ...((raw.header ?? base.header) ? { header: raw.header ?? base.header } : {}),
    ...((raw.footer ?? base.footer) ? { footer: raw.footer ?? base.footer } : {}),
    ...((raw.extraCarousels ?? base.extraCarousels)
      ? { extraCarousels: raw.extraCarousels ?? base.extraCarousels }
      : {}),
    sizing: { ...base.sizing, ...(raw.sizing ?? {}) },
    ...(Object.keys({ ...(base.productCardDefaults ?? {}), ...(raw.productCardDefaults ?? {}) })
      .length > 0 ||
    base.productCardDefaults ||
    raw.productCardDefaults
      ? {
          productCardDefaults: {
            ...(base.productCardDefaults ?? {}),
            ...(raw.productCardDefaults ?? {}),
          },
        }
      : {}),
    ...((raw.sectionOrder ?? base.sectionOrder)
      ? { sectionOrder: raw.sectionOrder ?? base.sectionOrder }
      : {}),
    // bottomBar: optional, saved wins, else inherit base. When neither is set,
    // the field is omitted entirely (undefined) — storefront falls back to its
    // class-based defaults and existing stores see no visual change.
    ...((raw.bottomBar ?? base.bottomBar) ? { bottomBar: raw.bottomBar ?? base.bottomBar } : {}),
  };
}
