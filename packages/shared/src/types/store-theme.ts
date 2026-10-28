// Store Template & Theme Types

// Brand engine — contrast-safe foreground derivation for the 4 brand pairs.
// Value import is safe: brand-roles.ts → color.ts both import StoreTheme
// type-only, so there is no runtime circular dependency back to this file.
import { deriveBrandRoles } from '../utils/brand-roles';
import { statusInkVars } from '../utils/status-ink';
import { colorToHslTriplet, hexToHsl } from '../utils/color';
import { accentPriceReads } from '../looks/traits';
import type {
  Density,
  ImageRatio,
  Motion,
  OverPhotoChrome,
  ReceiptStyle,
  WordmarkSize,
  HeaderLogoPlacement,
  HeaderSearchPlacement,
  HeaderWordmark,
  HeroRatio,
  TabBarMode,
  HeadingWeight,
  PriceColour,
  CardChrome,
  GridGutter,
  CardCta,
  CardHover,
  CardBadge,
} from '../looks/types';
import { getLook } from '../looks/registry';
import { resolveLookFonts } from '../looks/fonts';
import { mockCssVars } from '../looks/mock-tokens';
import { mapRetiredTemplate } from '../templates/legacy-skin-map';

/**
 * Available store templates
 */
export type TemplateId = 'dahab' | 'qamar' | 'souq' | 'jasmine' | 'lamma';

/**
 * Font family options for store themes
 */
export type FontFamily = 'default' | 'serif' | 'modern' | 'rounded';

/**
 * Border radius options for store themes
 */
export type BorderRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Per-store homepage background preset. Selected from the admin Branding
 * page; storefront renders alternating section backgrounds when set to
 * anything other than `none`. Section dividers (no horizontal rules) ship
 * platform-wide regardless of this setting — the preset only controls the
 * COLOR depth of the alternation. Defaults to `none` (flat surface,
 * sections separated by padding + section title anchors only).
 *
 * - `none`         → flat surface (`--bg-page` = `--bg-section-alt` = white). Sections rely on padding + anchors.
 * - `warmSand`     → warm off-white (#FAF7F2) ↔ warm sand (#F0EAE0). Premium grocery / heritage brands.
 * - `coolGrey`     → off-white (#F8F8F8) ↔ subtle grey (#EEEEEE). Tech / modern brands.
 * - `pureWhite`    → near-white (#FFFFFF) ↔ subtle tint (#FAFAFA). Minimalists who want the rhythm without color depth.
 * - `brandColor`   → derived from `primaryColor` via HSL lighten — page = brand at 96% L, alt = brand at 92% L. Reflects the merchant's brand color throughout the page.
 */
export type BackgroundPreset = 'none' | 'warmSand' | 'coolGrey' | 'pureWhite' | 'brandColor';

/**
 * Section-divider settings (2026-05-17 evening). Independent of
 * `backgroundPreset` — a horizontal line drawn between homepage
 * sections. Default ON per Ahmad's directive ("by default visible for
 * all stores"). Merchants tune in Admin → Dividers, not Theme, because
 * dividers are a separator concept and don't belong with font / color.
 */
export type DividerStyle = 'solid' | 'dashed' | 'dotted' | 'double';
export type DividerThickness = 1 | 2 | 3;
export type DividerWidth = 'full' | 'contained' | 'short';
export type DividerColorMode = 'auto' | 'foreground' | 'accent' | 'custom';
export type DividerSpacing = 'tight' | 'normal' | 'loose';

export interface DividerSettings {
  /** Master on/off. Default true. */
  enabled: boolean;
  /** CSS border-style. Default 'solid'. */
  style: DividerStyle;
  /** Line thickness in px (border-top width). Default 1. */
  thickness: DividerThickness;
  /** Line span: edge-to-edge ('full'), within max-w-7xl container ('contained'), or short centered accent ('short'). Default 'contained'. */
  width: DividerWidth;
  /**
   * Color mode:
   *  - 'auto'        → theme's --border token (subtle, blends in)
   *  - 'foreground'  → high-contrast --foreground at 25% opacity
   *  - 'accent'      → store's primary brand color
   *  - 'custom'      → user-picked hex via `customColor`
   * Default 'auto'.
   */
  color: DividerColorMode;
  /** Hex string when `color === 'custom'`. Ignored otherwise. */
  customColor?: string;
  /** Vertical padding around the divider. Default 'normal'. */
  spacing: DividerSpacing;
}

export const DEFAULT_DIVIDER_SETTINGS: DividerSettings = {
  enabled: true,
  style: 'solid',
  thickness: 1,
  // Ahmad 2026-05-17 evening: match the SectionKicker hairline style
  // (short centered hairline at foreground/30 — see SectionHeading.tsx
  // lines 67-84). The contained-width auto-color default looked too
  // heavy / chrome-y; the short foreground-30 pair reads as editorial
  // and matches the existing per-section kicker divider lines exactly.
  width: 'short',
  color: 'foreground',
  spacing: 'normal',
};

/**
 * Store theme configuration - colors stored as HSL values
 */
export interface StoreTheme {
  // Core colors (HSL format: "36 36% 52%")
  primaryColor: string;
  primaryForeground: string;
  secondaryColor: string;
  secondaryForeground: string;
  accentColor: string;
  accentForeground: string;
  backgroundColor: string;
  foregroundColor: string;
  mutedColor: string;
  mutedForeground: string;
  borderColor: string;

  // Card colors
  cardColor: string;
  cardForeground: string;

  // Popover colors
  popoverColor: string;
  popoverForeground: string;

  // Input colors
  inputColor: string;
  ringColor: string;

  // Status colors
  destructiveColor: string;
  destructiveForeground: string;
  successColor: string;
  successForeground: string;
  warningColor: string;
  warningForeground: string;

  // Typography
  fontFamily: FontFamily;
  headingFont?: string;
  bodyFont?: string;

  // Styling
  borderRadius: BorderRadius;

  // Look-owned layout tokens (set by a look via composeStoreTheme; absent on legacy stores).
  density?: Density;
  imageRatio?: ImageRatio;
  motion?: Motion;
  // Optional look UI tokens (W2a): absent on legacy stores and on looks that do not set them, so
  // every consumer keeps its current rendering unless the composed theme carries a value.
  wordmarkSize?: WordmarkSize;
  overPhotoChrome?: OverPhotoChrome;
  receiptStyle?: ReceiptStyle;
  cardCta?: CardCta;
  cardHover?: CardHover;
  cardBadge?: CardBadge;
  // Merchant header chrome overrides (Ruling EP-4), edited in the visual editor's theme pane.
  // Never set by a look: merchant > look chrome > skin default. Absent = the look's own value.
  headerLogoPlacement?: HeaderLogoPlacement;
  headerSearch?: HeaderSearchPlacement;
  // TEMPLATES-MOCK-3: the designed wordmark lockup for a store without a logo; unset = lockup, `plain` opts out.
  headerWordmark?: HeaderWordmark;
  // TEMPLATES-MOCK-4: mobile hero ratio; unset = the look's mock ratio.
  heroRatio?: HeroRatio;
  // TEMPLATES-MOCK-5: phone tab bar; unset = `inner` on a look store, `always` otherwise.
  tabBar?: TabBarMode;
  // TEMPLATES-MOCK-6: section heading weight and card price colour; unset = the look's own.
  headingWeight?: HeadingWeight;
  priceColour?: PriceColour;
  // TEMPLATES-MOCK-7: card chrome on home grids; unset = off on a look store (the mock's bare cards).
  cardHeart?: CardChrome;
  cardSwatches?: CardChrome;
  cardTags?: CardChrome;
  // TEMPLATES-MOCK-8: home product grid gutter; unset = the look's own (tight on qamar.atelier, else the old gaps).
  gridGutter?: GridGutter;

  // Per-store homepage section background preset — see BackgroundPreset
  // for behavior. Optional; missing or 'none' means flat-surface (no
  // alternating section tones).
  backgroundPreset?: BackgroundPreset;

  // Opt-in brand pill overlay on product card images (Bucket C5, shipped
  // 2026-05-17). When true, the store name renders as a small pill in
  // the top-START corner of every product image. Hidden automatically
  // when an OOS ribbon or NEW badge is already in that corner, so the
  // three signals never collide. Default false — opt-in because the
  // pill adds visual noise that's only useful for brand-recall on
  // share/screenshot contexts.
  showBrandBadge?: boolean;

  // Opt-in "New / جديد" badge on product cards (Ahmad 2026-10-16, Ruling
  // D1016-NEW-1: the merchant's choice). When true, a product the merchant
  // flagged `isNew` or created in the last 14 days shows the badge on every
  // card path (`isProductNew`). Default false (new visual features default OFF).
  showNewBadge?: boolean;

  // Opt-in quick-add (+) circle overlay on ProductCarousel cards (Bucket
  // E3, shipped 2026-05-17). When true, in-stock non-variant products
  // get a primary-color circle button bottom-end of the image — single
  // tap adds to cart without leaving the page. Default false because
  // some stores prefer routing every add through the PDP (clearer
  // conversion funnel + lets the customer see ingredients/spec first).
  showQuickAdd?: boolean;

  /** RETIRED (Ruling DIGITS-1, 2026-10-26): Western digits everywhere; this flag is ignored. Kept so stored themes still parse. */
  arabicNumerals?: boolean;

  // Section dividers (2026-05-17 evening) — see DividerSettings + admin
  // /stores/<id>/dividers page. Optional; missing defaults to
  // DEFAULT_DIVIDER_SETTINGS (enabled, solid, 1px, contained, auto color).
  dividers?: DividerSettings;

  // Homepage section toggles (2026-05-17 evening) — added after Ahmad
  // asked "where to toggle this off" about the brand story block.
  // Both default true so existing behavior is preserved; merchant opts
  // OUT in admin if they don't want the section.
  /** Show the inline "Our Story / قصتنا" block on the homepage (uses store.heroImage + store.description). */
  showBrandStory?: boolean;
  /** Show the 3-up trust strip (Fast Delivery / Quality / Support) above the footer. */
  showTrustStrip?: boolean;
  /**
   * Trust-strip layout direction. `'horizontal'` (default) = 3 items in
   * a row on every viewport (mobile gets compact gap); `'vertical'` =
   * stacked single column on every viewport. Ahmad 2026-05-17 evening.
   */
  trustStripLayout?: 'horizontal' | 'vertical';
  /**
   * Trust-strip visual size — scales icon + label + sub-label together
   * via a single token. Default 'md'. Ahmad 2026-05-18: "add sizing so
   * we can make the icons and font bigger and smaller together".
   *   - 'sm' icon h-8 w-8 / title text-xs / sub text-[11px]
   *   - 'md' (default) icon h-12 w-12 / title text-sm / sub text-xs
   *   - 'lg' icon h-16 w-16 / title text-base / sub text-sm
   */
  trustStripSize?: 'sm' | 'md' | 'lg';

  /**
   * Header logo sizing (per-store, so changing one store's logo never affects
   * another — the previous shared Tailwind class meant shrinking demo-store
   * shrank demo-shop too). Edited via Branding → Theme.
   * - `auto` (default): the StoreLogo component fits each logo by its measured
   *   aspect ratio within safe min/max thresholds — wide wordmarks get more
   *   width so they don't render tiny; square/tall logos use the base box.
   * - `sm` / `md` / `lg`: a per-store multiplier on the base bounding box for a
   *   merchant who wants their logo a notch smaller/larger. Always clamped so
   *   the header row can't break.
   */
  logoSize?: 'auto' | 'sm' | 'md' | 'lg';

  /**
   * Show the virtual "Best Sellers" tile in the homepage category strip.
   * Default `true`. The tile is synthesized by the API (`slug: 'best-sellers'`)
   * whenever ≥1 product is flagged as a best seller — it has no Category row,
   * so the per-category `showOnHomeStrip` flag can't hide it. This flag is the
   * equivalent control for that virtual tile. When `false`, the homepage strip
   * omits it; the Best Sellers product carousel ("scroll") and the
   * `/products?category=best-sellers` listing are unaffected. Edited on the
   * Categories admin page, beside the Best Sellers cover.
   */
  showBestSellersTile?: boolean;

  /**
   * Footer logo override (R2 URL). When set, the storefront footer uses this
   * image instead of `branding.logo`. Useful when the footer has a dark bg
   * and the main logo doesn't read well — merchant uploads a white/inverted
   * version here. Edited via Branding → Theme. Ahmad 2026-05-20.
   */
  footerLogo?: string;
  /**
   * When true, the storefront footer applies CSS `filter: brightness(0)
   * invert(1)` to the logo image to render it as solid white. Quick toggle
   * for dark footer backgrounds where uploading a separate white-on-
   * transparent logo (footerLogo above) would be overkill. The custom upload
   * wins when both are set.
   */
  footerLogoInvert?: boolean;
  /**
   * When true, the mobile-only footer logo (the one that appears beside
   * the social icons on phones) doesn't render. Useful for stores where
   * the header logo is already big and the merchant wants the mobile
   * footer to be text-only. Desktop footer logo is unaffected.
   * Ahmad 2026-05-21. Default false (logo visible on mobile).
   */
  hideFooterLogoMobile?: boolean;

  /**
   * Item 6 — master price-on-cards visibility toggle. When false, no product card
   * anywhere on the storefront shows a price (name + CTA still render). Default
   * true — hiding all prices is a bigger surprise than showing them, so new stores
   * default to showing prices. Merchants who run "inquiry-only" or B2B flows can
   * opt out here. Wired in Page Builder → Product cards. 2026-06-22.
   */
  showPriceOnCards?: boolean;

  /**
   * Item 10 — image normalization template. When true, every product image on the
   * storefront renders with object-fit: cover inside the per-surface fixed aspect
   * ratio (from productCardDefaults.cardImageAspect / productDetailPage.imageAspect).
   * A neutral bg-muted fill shows behind transparent PNGs so a grid looks like
   * "one photographer shot it all". PURE CSS render-layer only — the original
   * image is NEVER mutated or re-uploaded. Revert = set this flag false to restore
   * native rendering. Default false — opt-in because it changes existing grid
   * appearance for stores whose images have mixed natural ratios. 2026-06-22.
   */
  normalizeProductImages?: boolean;

  /**
   * AI-first autopilot. When ON (the default), the platform auto-fills a
   * product's empty AI-writable fields (Arabic name/description, SEO meta)
   * on create/update and on the daily sweep, and generates recommendations
   * for new products. Manual edits always win — a field a merchant types
   * becomes human-owned and the engine never overwrites it (see the
   * per-field provenance map on Product). Set false to pause all automatic
   * AI fill for this store; manual "Generate" buttons still work.
   * Default true (AI-first). Ahmad 2026-06-07.
   */
  aiAutopilot?: boolean;

  /**
   * Explicit page background HSL triplet (e.g. '26 5% 98%'). When both
   * `bgPage` and `bgSectionAlt` are set, `resolveBackgroundPreset` returns
   * them directly instead of falling back to the named-preset logic. This
   * lets the admin set two fully custom alternating background tones via
   * Branding → Brand colors (Branding v2, 2026-06-17). Stores that still
   * use a `backgroundPreset` are unaffected — the fallback path is intact.
   */
  bgPage?: string;
  /**
   * Explicit alternate-section background HSL triplet. Paired with `bgPage`
   * — both must be non-empty for the explicit path to activate.
   */
  bgSectionAlt?: string;

  /**
   * When true, footer social icons render in each platform's official brand
   * color (Instagram #E4405F, WhatsApp #25D366, etc.) instead of inheriting
   * the footer's `currentColor`. Default false — monochrome icons integrate
   * cleanly with any footer bg; opt-in so existing stores are unaffected.
   * Toggled via Branding → Theme. 2026-06-24.
   */
  footerSocialOriginalColor?: boolean;

  /**
   * When true, the storefront web-push subscription prompt
   * (`PushNotificationPrompt`) and the OneSignal SDK initializer
   * (`OneSignalStorefrontInit`) are active for this store. Default false —
   * no push UI appears even when the `push_notifications` plan feature is
   * enabled, so existing Professional stores are unaffected until the
   * merchant explicitly opts in. Toggled via Branding → Theme. 2026-06-27.
   */
  storefrontWebPushEnabled?: boolean;

  /**
   * When true, enables the 2026-07-12 "persona completion" chrome pass on
   * elegant (hairline-flanked title + whisper top-border see-all link),
   * classic (circular category tiles via the existing `cardShapeClasses`
   * shape vocabulary), and bold (bordered header + inverted footer). Chrome
   * only — never touches card size, product name/price typography, fonts,
   * or colors (uses existing theme tokens). Default false/undefined so
   * every EXISTING store (incl. demo-shop + Demo Store) renders exactly as
   * today. Seeded `true` at store-creation time for NEW stores only
   * (`StoreService.create`) and for demo clones;
   * existing stores can still opt in manually via Branding → Theme.
   */
  personaChromeV2?: boolean;

  /**
   * When true, suppresses the inner pack-style card chrome
   * (`styles.card` / `styles.categoryFrame`) on `ProductCarousel` +
   * `CategoryStrip` whenever the section's `showCardFrame` outer frame is
   * also active — removes the doubled-frame look. Default false/undefined
   * keeps today's rendering (both frames) on every EXISTING store. Seeded
   * `true` at store-creation time for NEW stores only (same seeding path
   * as `personaChromeV2`); existing stores can opt in via Branding → Theme.
   */
  frameChromeDedup?: boolean;

  /**
   * Out-of-stock ribbon/badge background color — the diagonal corner ribbon
   * rendered by `OutOfStockRibbon` in `templates/shared/ProductCardCta.tsx`
   * when the merchant hasn't opted into the full `oosLabel*` badge
   * customization system (`productCardDefaults`). Accepts a `token:<name>`
   * reference (see `COLOR_TOKENS`) or a raw hex/hsl string, resolved via
   * `resolveColor`. Default (undefined): the store's own ink and paper tokens
   * (`hsl(var(--foreground))` on `hsl(var(--background))`); the old hardcoded
   * terracotta default was retired on 2026-10-16 (Ebda has no orange, Ruling B1-88).
   * On a store with a look the label is a flat chip on the look radius, not a sash. Seeded to a
   * neutral slate (`#6b7280`, matching `DEFAULT_THEME.mutedForeground`'s hue)
   * at store-creation time for NEW stores only (`StoreService.create`) and
   * for demo clones — same seeding path as
   * `personaChromeV2`/`frameChromeDedup`; existing stores can opt in
   * manually. 2026-07-12 design-sweep batch.
   */
  oosRibbonColor?: string;

  /**
   * When true, elegant's empty-state CTA arrow flips direction for RTL
   * (`←` in Arabic, `→` in English) instead of always rendering `→`
   * regardless of reading direction. Chrome only — no layout, color, or
   * copy change. Default false/undefined so every EXISTING store (incl.
   * demo-shop, which uses the elegant template) keeps today's
   * always-`→` rendering. Seeded `true` at store-creation time for NEW
   * stores only (`StoreService.create`) and for demo clones
   * (demo clones) — same seeding path as `personaChromeV2`;
   * existing stores can opt in manually via Branding → Theme. 2026-07-12
   * design-sweep batch.
   *
   * @deprecated Ruling EP-8 (2026-10-22): no renderer reads it any more (the elegant empty-state arrow
   * mirrors on every store), so the Theme tab has no control and new stores are not seeded with it. A
   * stored value stays accepted and is ignored.
   */
  rtlPolish?: boolean;

  /**
   * Merchant-controlled display order for footer social icons.
   * An array of platform keys (e.g. ['tiktok','instagram','whatsapp']) that
   * defines the left-to-right (or start-to-end in RTL) sequence in the footer.
   * After filtering to entries with a URL, icons whose key appears in this
   * array are sorted to the front in that sequence; icons not listed retain
   * their existing default order (stable sort, Infinity fallback).
   * When empty or undefined, the built-in candidate order is preserved so
   * existing stores are unaffected. Toggled via Branding → Social Links.
   * 2026-06-27.
   */
  socialOrder?: string[];

  /**
   * When true, the Floating Widget ignores per-button `bgColor`/`iconColor`
   * overrides and uses each button kind's registered brand color from
   * KIND_DEFAULTS (whatsapp #25D366, instagram #E4405F, etc.). Merchant
   * color customizations are preserved in the data and take effect again
   * when this flag is set back to false. Default false. Toggled via
   * Branding → Theme alongside the footer flag. 2026-06-24.
   */
  floatingWidgetOriginalColor?: boolean;

  /**
   * Restore the uppercase chrome styling — nav/footer/headings/labels.
   * Default false = natural case everywhere.
   * When true, all site-chrome elements (nav links, footer column headings,
   * "SEE ALL" / section links, category captions, section headings, hero
   * CTA/headline, testimonial author, section kicker) render in uppercase
   * via a single CSS rule on [data-ui-uppercase='true'] .ui-caps-toggle.
   * Product names are NOT affected (they have their own productNameCase control).
   */
  uppercaseStyle?: boolean;

  /**
   * Per-store category product-count unit label (EN + AR).
   * Displayed after the count on category cards, e.g. "4 pieces" / "4 قطعة".
   * When unset, the storefront defaults to EN "pieces" / AR "قطعة".
   * Merchant edits via Admin → Categories.
   */
  categoryCountUnit?: {
    en: string;
    ar: string;
  };

  // ── Order-summary label colors (cart / checkout / address pages) ──────────
  /**
   * Color for summary row labels (Order Summary heading, Subtotal, Shipping).
   * Accepts a `token:<name>` brand-token reference or a hex color.
   * Default (when undefined): inherits `token:foreground` — no visual change
   * for existing stores.
   */
  summaryLabelColor?: string;
  /**
   * Color for the grand-total row (Total label + amount). When undefined,
   * falls back to `token:foreground` so existing stores look unchanged.
   * Lets merchants make the total pop with the brand primary or any color.
   */
  summaryTotalColor?: string;
  /**
   * When true, summary row labels (Subtotal, Shipping, Total) render bold.
   * Default true to match the current bold rendering — opting out sets
   * `font-normal` so labels appear in regular weight.
   */
  summaryLabelBold?: boolean;

  // ── Products listing page (PLP) text colors ─────────────────────────────
  /**
   * Color for the PLP breadcrumb links (Home / Products) and the subtitle
   * "Browse our collection". Accepts a token ref or hex. Default: inherits
   * `token:muted` — no visual change for existing stores.
   */
  plpBreadcrumbColor?: string;
  /**
   * Color for the PLP main heading ("All Products"). Accepts a token ref or
   * hex. Default (when undefined): inherits `token:foreground`.
   */
  plpHeadingColor?: string;
  /**
   * Color for the PLP subtitle / sub-heading ("Browse our collection of
   * premium products"). Accepts a token ref or hex. Default: `token:muted`.
   */
  plpSubheadingColor?: string;

  // Custom CSS (for advanced users)
  customCss?: string;

  /**
   * When true, the storefront footer renders a "Branches"/"فروعنا" column
   * listing the store's published Locations (name + address, linked to
   * `mapsUrl` when present, phone as a `tel:` link when present). Default
   * false/undefined — a store that has locations enabled for the /locations
   * page is UNAFFECTED until it explicitly opts in here (e.g. demo-store's 8
   * locations render nowhere in the footer until this flag is set). Also
   * requires `Store.locationsEnabled === true` and at least one published
   * location — either gate missing means no column. Toggled via
   * Branding → Locations. 2026-09-25 (B3).
   */
  showBranchesInFooter?: boolean;
  /**
   * Free-tier WhatsApp (`wa.me` click-to-chat, SP8) toggles. Each is ON unless
   * explicitly `false`, and every one needs a valid `Store.whatsapp` number —
   * without one no button renders. Edited in Branding → Contact.
   */
  waMeProductShare?: boolean;
  waMeOrderQuestion?: boolean;
  waMeCodConfirm?: boolean;
  /**
   * Issue #1998 (owner, 2026-09-30) — keep the LEGACY sale-badge corner.
   * Unset/false (every store by default): a product card's sale badge whose
   * corner the merchant has NOT chosen is pinned to the image's top corner on
   * the reading-start side (top-left LTR, top-right RTL), moved off the NEW
   * pill / heart / out-of-stock ribbon, so the add-to-cart band can never cover
   * it or lift it mid-image. true: the unset badge stays bottom-left (lifted
   * over the mobile add-to-cart band), exactly as before #1998. Per-store DATA —
   * set for a store by an operator script or the Page
   * Builder toggle (Product cards → Discount / sale badge; ThemeTab is at its
   * 7-toggle ceiling). A merchant-chosen corner is unaffected either way.
   */
  saleBadgeLegacyCorner?: boolean;
  /**
   * Issue #2349 (owner option A, 2026-09-30) — keep the LEGACY status-message
   * colours on the storefront. Unset/false (every store by default): warning /
   * info / success / error banners, pills and message text use the readable
   * `-ink` shade of their role (>= 4.5:1 on the card, the page and every tint
   * up to 30%), derived per store by `statusInkVars`. true: every
   * `--<role>-ink` is `var(--<role>)`, so the message text renders in the bare
   * role colour exactly as before. Per-store DATA — set for demo-store by a
   * jsonb merge before the code deploys, or by the Page Builder toggle (Cart
   * page → Message colours). The storefront never branches on a slug.
   */
  legacyBannerContrast?: boolean;
}

/**
 * Social media links for a store
 */
export interface StoreSocialLinks {
  instagram?: string;
  twitter?: string;
  facebook?: string;
  tiktok?: string;
  youtube?: string;
  snapchat?: string;
  linkedin?: string;
  whatsapp?: string;
  telegram?: string;
  pinterest?: string;
  /** Wikidata entity URL — strong knowledge-graph identity signal for AI agents */
  wikidata?: string;
  /** Wikipedia article URL — used as sameAs in Store JSON-LD */
  wikipedia?: string;
}

/**
 * Announcement bar configuration
 */
export interface AnnouncementBar {
  enabled: boolean;
  text: string;
  textAr?: string;
  link?: string;
  linkText?: string;
  linkTextAr?: string;
  bgColor?: string;
  textColor?: string;
  dismissible?: boolean;
}

/**
 * Template metadata for display in admin
 */
export interface TemplateInfo {
  id: TemplateId;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  thumbnail: string;
  tags: string[];
  bestFor: string;
}

/**
 * Default theme values
 */
export const DEFAULT_THEME: StoreTheme = {
  // Core colors
  // Ebda's palette (Ruling D1016-ORANGE-1, BRAND.colors): primary = night #0A0B0C with white
  // ink (19.7:1, K-02), accent = a gold #B08D57 tint with dark-gold ink (8.3:1), ring = gold
  // (3.08:1 on white, the ≥3:1 non-text bar). Never the inherited Force orange.
  primaryColor: '210 9% 4%',
  primaryForeground: '0 0% 100%',
  secondaryColor: '220 14% 96%',
  secondaryForeground: '220 9% 46%',
  accentColor: '36 36% 95%',
  accentForeground: '36 40% 25%',
  backgroundColor: '0 0% 100%',
  foregroundColor: '224 71% 4%',
  mutedColor: '220 14% 96%',
  mutedForeground: '220 9% 46%',
  borderColor: '220 13% 91%',

  // Card colors
  cardColor: '0 0% 100%',
  cardForeground: '224 71% 4%',

  // Popover colors
  popoverColor: '0 0% 100%',
  popoverForeground: '224 71% 4%',

  // Input colors
  inputColor: '220 13% 91%',
  ringColor: '36 36% 52%',

  // Status colors
  destructiveColor: '0 84% 60%',
  destructiveForeground: '0 0% 100%',
  successColor: '142 76% 36%',
  successForeground: '0 0% 100%',
  warningColor: '45 93% 47%',
  warningForeground: '0 0% 0%',

  // Typography & Styling
  fontFamily: 'default',
  borderRadius: 'md',
  backgroundPreset: 'none',
  showBrandBadge: false,
  showNewBadge: false,
  showQuickAdd: false,
  dividers: DEFAULT_DIVIDER_SETTINGS,
  showBrandStory: true,
  showTrustStrip: true,
  trustStripLayout: 'horizontal',
  aiAutopilot: true,
};

/**
 * Template presets with default themes
 */
export const TEMPLATE_THEMES: Record<TemplateId, Partial<StoreTheme>> = {
  // Qamar (fashion & boutiques, Phase B1): a neutral base. Every Qamar store has a
  // look, and the look's tokens (packages/shared/src/looks/registry.ts) own colour,
  // type, radius, density, image ratio and motion. Dividers off: the looks separate
  // sections by space and bands, never hairline-flanked labels on every section.
  qamar: {
    primaryColor: '0 0% 8%',
    primaryForeground: '0 0% 100%',
    backgroundColor: '0 0% 100%',
    foregroundColor: '0 0% 8%',
    fontFamily: 'default',
    borderRadius: 'none',
    backgroundPreset: 'none',
    showBrandStory: false,
    showTrustStrip: false,
    dividers: { ...DEFAULT_DIVIDER_SETTINGS, enabled: false },
  },
  // Souq (general retail and electronics, Phase B2): a neutral cool base. Every Souq store has a
  // look, and the look's tokens own colour, type, radius, density, image ratio and motion. No
  // orange anywhere in the family (Ruling B2-2); dividers off like Qamar.
  souq: {
    primaryColor: '218 74% 48%',
    primaryForeground: '0 0% 100%',
    backgroundColor: '0 0% 100%',
    foregroundColor: '216 24% 9%',
    fontFamily: 'default',
    borderRadius: 'md',
    backgroundPreset: 'none',
    showBrandStory: false,
    showTrustStrip: false,
    dividers: { ...DEFAULT_DIVIDER_SETTINGS, enabled: false },
    // The platform default warning is amber (45 deg), inside the forbidden band (Ruling B2-2),
    // and it reaches the cart / checkout notices. Souq's warning is plum: distinct from
    // destructive (red) and success (green), nothing orange.
    warningColor: '320 62% 40%',
    warningForeground: '0 0% 100%',
  },
  // Jasmine (beauty and skincare, Phase B3): a neutral base; every Jasmine store has a look and
  // the look's tokens own colour, type, radius, density, image ratio and motion. No orange
  // anywhere in the family (Ruling B3-2/B3-3); dividers off like Souq. Warning is plum, not the
  // platform amber, for the same reason as Souq (it reaches the cart / checkout notices).
  jasmine: {
    primaryColor: '168 63% 30%',
    primaryForeground: '0 0% 100%',
    backgroundColor: '0 0% 100%',
    foregroundColor: '206 36% 12%',
    fontFamily: 'default',
    borderRadius: 'md',
    backgroundPreset: 'none',
    showBrandStory: false,
    showTrustStrip: false,
    dividers: { ...DEFAULT_DIVIDER_SETTINGS, enabled: false },
    warningColor: '320 62% 40%',
    warningForeground: '0 0% 100%',
  },
  // Lamma (home food and home kitchens, Phase B4): a neutral base; every Lamma store has a look
  // and the look's tokens own colour, type, radius, density, image ratio and motion. No orange
  // anywhere in the family (Ruling B4-2); dividers off like Souq. Warning is plum, not the
  // platform amber, for the same reason as Souq (it reaches the cart / checkout notices).
  lamma: {
    primaryColor: '352 55% 41%',
    primaryForeground: '0 0% 100%',
    backgroundColor: '0 0% 100%',
    foregroundColor: '342 24% 13%',
    fontFamily: 'default',
    borderRadius: 'md',
    backgroundPreset: 'none',
    showBrandStory: false,
    showTrustStrip: false,
    dividers: { ...DEFAULT_DIVIDER_SETTINGS, enabled: false },
    warningColor: '320 62% 40%',
    warningForeground: '0 0% 100%',
  },
  // Dahab (jewellery, Phase B5, Ruling B5-3): a neutral base, the Qamar pattern. The night + gold
  // + ivory skin is retired (TPL-2); every Dahab store has a look and the look's tokens own colour,
  // type, radius, density, image ratio and motion. A legacy `template = 'dahab', look = null` row
  // therefore renders white with an ink primary instead of the old night. No orange anywhere
  // (Ruling B2-2); the platform amber warning is replaced by plum like Souq; dividers off.
  dahab: {
    primaryColor: '0 0% 8%',
    primaryForeground: '0 0% 100%',
    backgroundColor: '0 0% 100%',
    foregroundColor: '0 0% 8%',
    fontFamily: 'default',
    borderRadius: 'none',
    backgroundPreset: 'none',
    showBrandStory: false,
    showTrustStrip: false,
    dividers: { ...DEFAULT_DIVIDER_SETTINGS, enabled: false },
    warningColor: '320 62% 40%',
    warningForeground: '0 0% 100%',
  },
};

/**
 * All available templates with metadata
 */
export const TEMPLATES: TemplateInfo[] = [
  {
    id: 'dahab',
    name: 'Dahab',
    nameAr: 'دهب',
    description: 'Gold on night: a jewellery and handmade-goods storefront',
    descriptionAr: 'دهب على ليل: متجر للمجوهرات والمشغولات اليدوية',
    thumbnail: '/templates/dahab.png',
    tags: ['jewellery', 'handmade', 'gifts'],
    bestFor: 'Jewellery, handmade and premium gifts',
  },
  {
    id: 'qamar',
    name: 'Qamar',
    nameAr: 'قمر',
    description: 'Fashion and boutiques: Atelier, Lookbook and Vitrine looks',
    descriptionAr: 'أزياء وبوتيكات: أتيليه ولوك بوك وفاترينة',
    thumbnail: '/looks/qamar.atelier.webp',
    tags: ['fashion', 'abayas', 'boutique'],
    bestFor: 'Fashion, abayas and boutiques',
  },
  {
    id: 'souq',
    name: 'Souq',
    nameAr: 'سوق',
    description: 'General retail and electronics: Catalogue, Night souq and Showroom looks',
    descriptionAr: 'متجر عام وإلكترونيات: كتالوج وسوق الليل وشو روم',
    thumbnail: '/looks/souq.catalogue.webp',
    tags: ['electronics', 'appliances', 'general'],
    bestFor: 'General retail, electronics and appliances',
  },
  {
    id: 'jasmine',
    name: 'Jasmine',
    nameAr: 'ياسمين',
    description: 'Beauty and skincare: Apothecary, Bloom and Clinic looks',
    descriptionAr: 'جمال وعناية بالبشرة: عطارة وبلوم وعيادة',
    thumbnail: '/looks/jasmine.apothecary.webp',
    tags: ['beauty', 'skincare', 'cosmetics'],
    bestFor: 'Beauty, skincare and cosmetics',
  },
  {
    id: 'lamma',
    name: 'Lamma',
    nameAr: 'لمّة',
    description: 'Home food and groceries: Family table, Kitchen notebook and Fresh market looks',
    descriptionAr: 'أكل بيتي وبقالة: سفرة العيلة وكشكول المطبخ وسوق طازة',
    thumbnail: '/looks/lamma.table.webp',
    tags: ['food', 'homemade', 'grocery'],
    bestFor: 'Home kitchens, bakeries and grocery',
  },
];

/**
 * Get template info by ID
 */
export function getTemplateInfo(templateId: TemplateId): TemplateInfo | undefined {
  return TEMPLATES.find(t => t.id === mapRetiredTemplate(templateId));
}

/**
 * Get theme for a template, merged with defaults
 */
export function getTemplateTheme(templateId: TemplateId): StoreTheme {
  return {
    ...DEFAULT_THEME,
    ...TEMPLATE_THEMES[mapRetiredTemplate(templateId) as TemplateId],
  };
}

/**
 * Border radius mapping
 */
export const BORDER_RADIUS_MAP: Record<BorderRadius, string> = {
  none: '0',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
};

/**
 * Font family mapping
 */
export const FONT_FAMILY_MAP: Record<FontFamily, string> = {
  default: 'var(--font-sans)',
  serif: 'var(--font-serif)',
  modern: 'var(--font-modern)',
  rounded: 'var(--font-rounded)',
};

/**
 * Resolve a BackgroundPreset to its `{ bgPage, bgSectionAlt }` HSL string
 * pair (matching the existing color-token format used elsewhere in this
 * file — `"H S% L%"` without `hsl()` wrapper, so Tailwind utilities like
 * `bg-[hsl(var(--bg-page))]` work as-is).
 *
 * For `brandColor`, the alternation is derived from the merchant's
 * `primaryColor` by lifting lightness to 96% (page) and 92% (alt). For
 * the static presets, values are platform-fixed and reviewed 2026-05-17
 * after Stitch verified the section-rhythm read on screen previews.
 */
export function resolveBackgroundPreset(theme: StoreTheme): {
  bgPage: string;
  bgSectionAlt: string;
} {
  // When the admin has set explicit custom background values (Branding v2,
  // 2026-06-17), use them directly — strip any `hsl(...)` wrapper to keep
  // the bare triplet format expected by `--bg-page` / `--bg-section-alt`.
  if (theme.bgPage && theme.bgPage !== '' && theme.bgSectionAlt && theme.bgSectionAlt !== '') {
    const strip = (v: string) => v.replace(/^hsl\(\s*/, '').replace(/\s*\)$/, '');
    return { bgPage: strip(theme.bgPage), bgSectionAlt: strip(theme.bgSectionAlt) };
  }

  switch (theme.backgroundPreset) {
    case 'warmSand':
      // #FAF7F2 / #F0EAE0
      return { bgPage: '36 33% 96%', bgSectionAlt: '36 33% 91%' };
    case 'coolGrey':
      // #F8F8F8 / #EEEEEE
      return { bgPage: '0 0% 97%', bgSectionAlt: '0 0% 93%' };
    case 'pureWhite':
      // #FFFFFF / #FAFAFA
      return { bgPage: '0 0% 100%', bgSectionAlt: '0 0% 98%' };
    case 'brandColor': {
      // Parse "H S% L%" → keep H+S, override L. Falls back to neutral if parse fails.
      const m = theme.primaryColor.match(/^\s*([\d.]+)\s+([\d.]+)%\s+[\d.]+%\s*$/);
      if (!m) return { bgPage: '0 0% 100%', bgSectionAlt: '0 0% 98%' };
      const [, h, s] = m;
      // Cap saturation at 25% so brand-color backgrounds never feel
      // oversaturated — a tinted whisper, not a full wash.
      // 2026-05-17 (evening): contrast bumped from 96/92 to 97/86 so the
      // alternation is visibly distinct — the 4-point lightness gap was
      // perceptually flat on most screens. 11-point gap reads as a clear
      // band shift without losing the "whisper of brand color" feel.
      const cappedS = Math.min(Number(s), 25);
      return {
        bgPage: `${h} ${cappedS}% 97%`,
        bgSectionAlt: `${h} ${cappedS}% 86%`,
      };
    }
    case 'none':
    default:
      // Flat surface — both tokens identical so `bg-[hsl(var(--bg-page))]`
      // and `bg-[hsl(var(--bg-section-alt))]` render the same color and
      // the section rhythm comes purely from padding + anchors.
      return { bgPage: '0 0% 100%', bgSectionAlt: '0 0% 100%' };
  }
}

/**
 * Product-card text-size table — locked card-width ⇄ font-size ratios per
 * the Sprint 1 plan (see `docs/superpowers/plans/2026-05-17-ui-ux-refresh-from-references.md`).
 *
 * Pack-styles still drives the per-template flavor (weight, tracking,
 * color, font-family); these size classes are concatenated alongside.
 * Pack-styles size tokens were removed from the productCardName /
 * productCardPrice strings as part of this change to avoid conflicts.
 *
 * **16px floor (from design.md "Typography sizes" standing rule):** main
 * reading text — product name + price — never goes below text-base
 * (16px) on any breakpoint, even on small cards. Pre-2026-05-16
 * minimal-pack used 12px and it read as a legibility regression. Smaller
 * cards keep the 16px floor and rely on truncation; only LARGER cards
 * step the font up from the 16px base.
 */
export type ProductCardSize = 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export function getProductCardTextSizes(cardSize: ProductCardSize | undefined): {
  name: string;
  price: string;
  cta: string;
  /** Body padding — scales with the card so a small card has a tight body. */
  pad: string;
  /** Gap between body rows — scales with the card. */
  gap: string;
  /** Add-to-cart button height + horizontal padding — scales with the card so
   *  the CTA shrinks/grows in lock-step instead of staying a fixed size. */
  btn: string;
} {
  // Single source of truth: ONE cardSize drives fonts + button + body spacing
  // together (Ahmad 2026-06-04 "one change drives the whole thing"). cta is the
  // button TEXT size; btn is its box (height + padding). pad/gap are the body.
  switch (cardSize) {
    case 'xxs':
      // Ultra-compact tile (~90-110px) — sub-16px fonts + a tiny CTA.
      return {
        name: 'text-xs',
        price: 'text-xs',
        cta: 'text-xs',
        pad: 'p-1.5',
        gap: 'gap-1',
        btn: 'min-h-7 px-2 py-1',
      };
    case 'xs':
    case 'sm':
      // Compact density — floor at 16px, no desktop step-up.
      return {
        name: 'text-base',
        price: 'text-base',
        cta: 'text-sm',
        pad: 'p-2 sm:p-2.5',
        gap: 'gap-1.5',
        btn: 'min-h-9 px-3 py-1.5',
      };
    case 'lg':
      return {
        name: 'text-lg',
        price: 'text-lg sm:text-xl',
        cta: 'text-sm sm:text-base',
        pad: 'p-4 sm:p-5',
        gap: 'gap-2.5',
        btn: 'min-h-11 px-5 py-2.5',
      };
    case 'xl':
      return {
        name: 'text-lg sm:text-xl',
        price: 'text-xl sm:text-2xl',
        cta: 'text-base',
        pad: 'p-5 sm:p-6',
        gap: 'gap-3',
        btn: 'min-h-12 px-6 py-3',
      };
    case 'md':
    default:
      // Default — 16px mobile, 18px from sm breakpoint; ~200px card.
      return {
        name: 'text-base sm:text-lg',
        price: 'text-base sm:text-lg',
        cta: 'text-sm',
        pad: 'p-3 sm:p-4',
        gap: 'gap-2',
        btn: 'min-h-10 px-4 py-2',
      };
  }
}

export const LOOK_SPACE_UNIT = { compact: '0.875', regular: '1', airy: '1.25' } as const;
export const LOOK_MOTION_DURATION = { none: '0ms', subtle: '180ms', expressive: '280ms' } as const;

/**
 * Look-only CSS variables. Empty unless `lookId` names a registered look
 * (Ruling R1): a stray density/headingFont on a legacy store emits nothing,
 * and a look store whose merchant cleared a key still gets the look's font.
 */
export function lookCssVars(
  theme: Partial<StoreTheme>,
  lookId: string | null | undefined
): Record<string, string> {
  const look = getLook(lookId);
  if (!look) return {};
  const v: Record<string, string> = {};
  // Merchant font wins when it is loadable; `latin` follows a merchant heading (resolveLookFonts).
  const { display, body, latin } = resolveLookFonts(look, theme);
  v['--font-display'] = `"${display}", var(--font-arabic), var(--font-sans)`;
  // Same value under a name no skin rule redefines (dahab sets --font-display on <body>).
  v['--look-font-display'] = v['--font-display'];
  v['--font-body'] = `"${body}", var(--font-arabic), var(--font-sans)`;
  v['--font-latin'] = `"${latin}", var(--font-sans)`;
  if (theme.density) v['--space-unit'] = LOOK_SPACE_UNIT[theme.density];
  if (theme.imageRatio) v['--image-ratio'] = theme.imageRatio.replace('/', ' / ');
  if (theme.motion) v['--motion-duration'] = LOOK_MOTION_DURATION[theme.motion];
  Object.assign(v, mockCssVars(lookId, theme));
  // TEMPLATES-MOCK-6: the card price in the look's accent, only when the accent itself reads (>= 4.5:1) on the
  // page AND the card. A look whose accent does not (a pale accent on a light card over a dark page, measured by
  // axe on qamar.lookbook / souq.night) leaves the var unset and the price keeps the text colour.
  if (theme.accentColor && accentPriceReads(theme)) {
    const a = theme.accentColor;
    v['--look-price-colour'] = a.startsWith('#') ? hexToHsl(a) : a;
  }
  return v;
}

/**
 * Convert theme to CSS custom properties
 */
export function themeToCssVars(theme: StoreTheme, lookId?: string | null): Record<string, string> {
  const bg = resolveBackgroundPreset(theme);
  const vars: Record<string, string> = {
    // Core colors
    '--primary': theme.primaryColor,
    '--primary-foreground': theme.primaryForeground,
    '--secondary': theme.secondaryColor,
    '--secondary-foreground': theme.secondaryForeground,
    '--accent': theme.accentColor,
    '--accent-foreground': theme.accentForeground,
    '--background': theme.backgroundColor,
    '--foreground': theme.foregroundColor,
    '--muted': theme.mutedColor,
    '--muted-foreground': theme.mutedForeground,
    '--border': theme.borderColor,

    // Card colors
    '--card': theme.cardColor,
    '--card-foreground': theme.cardForeground,

    // Popover colors
    '--popover': theme.popoverColor,
    '--popover-foreground': theme.popoverForeground,

    // Input colors
    '--input': theme.inputColor,
    '--ring': theme.ringColor,

    // Status colors
    '--destructive': theme.destructiveColor,
    '--destructive-foreground': theme.destructiveForeground,
    '--success': theme.successColor,
    '--success-foreground': theme.successForeground,
    '--warning': theme.warningColor,
    '--warning-foreground': theme.warningForeground,

    // Typography & Styling
    '--radius': BORDER_RADIUS_MAP[theme.borderRadius],
    '--font-family': FONT_FAMILY_MAP[theme.fontFamily],

    // Sprint 1 (2026-05-17) — section background rhythm tokens. Resolved
    // from `theme.backgroundPreset`; HomePageContent applies alternating
    // `bg-[hsl(var(--bg-page))]` / `bg-[hsl(var(--bg-section-alt))]` to
    // adjacent sections. When preset is `none` both tokens are identical
    // and the alternation visually flattens to a single surface.
    '--bg-page': bg.bgPage,
    '--bg-section-alt': bg.bgSectionAlt,

    // Brand engine (2026-06-05) — overrides the 4 brand color/foreground
    // pairs (primary/secondary/accent/card) with CONTRAST-SAFE foregrounds.
    // A stored foreground that reads fine on its surface is kept verbatim
    // (so configured stores — demo-shop — are pixel-identical); a missing or
    // unreadable foreground is replaced via pickReadableForeground(surface).
    // Spread LAST so it wins over the raw values above. See utils/brand-roles.ts.
    ...deriveBrandRoles(theme),
  };

  // Normalize EVERY colour var to a bare HSL triplet so values stored as hex
  // (e.g. `#906c51` from an older editor) or as `token:*` references still
  // render — Tailwind consumes each as `hsl(var(--token))`, which is invalid
  // for a hex/token value and would otherwise drop the colour (→ black).
  // Non-colour vars (--radius, --font-family) are left untouched.
  const NON_COLOR_VARS = new Set(['--radius', '--font-family']);
  for (const key of Object.keys(vars)) {
    if (NON_COLOR_VARS.has(key)) continue;
    vars[key] = colorToHslTriplet(vars[key], theme);
  }
  // Looks (Phase S): emitted ONLY when the theme carries the key, so legacy
  // stores (no look) produce the exact same variable set as before (Ruling R1).
  Object.assign(vars, lookCssVars(theme, lookId));
  // Issue 2349 — status-message inks, measured on this store's own surfaces
  // (after normalisation, so they read the same triplets the page paints).
  // Legacy stores get `var(--<role>)`: identical to the bare role colour.
  Object.assign(
    vars,
    statusInkVars(
      {
        success: vars['--success'],
        warning: vars['--warning'],
        destructive: vars['--destructive'],
      },
      [vars['--card'], vars['--background']],
      theme.legacyBannerContrast === true
    )
  );
  return vars;
}

/**
 * Generate CSS string from theme
 */
export function themeToCssString(theme: StoreTheme): string {
  const vars = themeToCssVars(theme);
  return Object.entries(vars)
    .map(([key, value]) => `${key}: ${value};`)
    .join('\n    ');
}

/**
 * Apply theme to document root (client-side only)
 * This function should only be called in browser environments.
 * Use the CSS variables object from themeToCssVars() directly if you need
 * more control over how styles are applied.
 */
export function applyThemeToDocument(theme: StoreTheme): void {
  // Check if we're in a browser environment
  if (typeof globalThis === 'undefined') return;

  const g = globalThis as Record<string, unknown>;
  if (!g.document) return;

  const vars = themeToCssVars(theme);
  const doc = g.document as {
    documentElement?: { style?: { setProperty: (k: string, v: string) => void } };
  };
  const root = doc.documentElement;
  const style = root?.style;

  if (!style?.setProperty) return;

  Object.entries(vars).forEach(([key, value]) => {
    style.setProperty(key, value);
  });
}

/**
 * Generate inline style object for React
 */
export function themeToStyleObject(theme: StoreTheme): React.CSSProperties {
  const vars = themeToCssVars(theme);
  const style: Record<string, string> = {};

  Object.entries(vars).forEach(([key, value]) => {
    style[key] = value;
  });

  return style as React.CSSProperties;
}

// ============================================
// Marketing Pixels Types
// ============================================

/**
 * Marketing pixel configuration for a single platform
 */
export interface MarketingPixelConfig {
  enabled: boolean;
  pixelId: string;
  accessToken?: string; // For Conversions API (Meta, TikTok)
  testEventCode?: string; // For testing events
  events?: MarketingEvent[];
}

/**
 * Marketing event types for tracking
 */
export type MarketingEventType =
  | 'PageView'
  | 'ViewContent'
  | 'AddToCart'
  | 'InitiateCheckout'
  | 'AddPaymentInfo'
  | 'Purchase'
  | 'Search'
  | 'AddToWishlist'
  | 'CompleteRegistration'
  | 'Contact'
  | 'Lead'
  | 'Subscribe';

/**
 * Marketing event configuration
 */
export interface MarketingEvent {
  type: MarketingEventType;
  enabled: boolean;
}

/**
 * Comprehensive marketing pixels configuration
 */
export interface MarketingPixels {
  // Meta (Facebook/Instagram)
  meta?: {
    enabled: boolean;
    pixelId: string;
    accessToken?: string; // Conversions API token
    testEventCode?: string;
  };

  // TikTok
  tiktok?: {
    enabled: boolean;
    pixelId: string;
    accessToken?: string;
  };

  // Snapchat
  snapchat?: {
    enabled: boolean;
    pixelId: string;
  };

  // Google Analytics 4
  googleAnalytics?: {
    enabled: boolean;
    measurementId: string; // G-XXXXXXXXXX
  };

  // Google Tag Manager
  googleTagManager?: {
    enabled: boolean;
    containerId: string; // GTM-XXXXXXX
  };

  // Google Ads
  googleAds?: {
    enabled: boolean;
    conversionId: string; // AW-XXXXXXXXX
    conversionLabel?: string;
  };

  // Twitter/X
  twitter?: {
    enabled: boolean;
    pixelId: string;
  };

  // Pinterest
  pinterest?: {
    enabled: boolean;
    tagId: string;
  };
}
