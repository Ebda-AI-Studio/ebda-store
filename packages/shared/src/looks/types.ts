import type { StoreTheme, TemplateId, BorderRadius } from '../types/store-theme';

export type LookTemplate = 'qamar' | 'souq' | 'jasmine' | 'lamma' | 'dahab';
export type LookId = `${LookTemplate}.${string}`;
/** The allowed values of the look-only theme keys (also the theme PUT's allow-lists). */
export const LOOK_DENSITIES = ['compact', 'regular', 'airy'] as const;
export const LOOK_IMAGE_RATIOS = ['1/1', '4/5', '3/4', '4/3'] as const;
export const LOOK_MOTIONS = ['none', 'subtle', 'expressive'] as const;
export type Density = (typeof LOOK_DENSITIES)[number];
export type ImageRatio = (typeof LOOK_IMAGE_RATIOS)[number];
export type Motion = (typeof LOOK_MOTIONS)[number];
/**
 * Look UI tokens (W2a token plumbing, fix-waves W2 #1). Optional on a look: a look that does not
 * set one emits nothing, so its stores (and every store with no look) render exactly as before.
 * - `wordmarkSize`: the text wordmark size in the header and the checkout/success header (T-01).
 * - `overPhotoChrome`: material of controls that sit on a product photo (`soft` disc, `bare` glyph).
 * - `receiptStyle`: the order receipt housing (`device` slab today, `framed` paper in the page ink).
 * - `cardCta` (W2b, L-01): the product card's action. `none` = no control, the card is the link;
 *   `quiet` = only an in-stock product with no sizes gets an outline add (never a navigate-only
 *   "View" slab). Absent = the skin's CTA system. A merchant `productCardDefaults.ctaMode` wins.
 * - `cardHover` (W2b, M-03): `none` drops the card's hover scale and shadow lift.
 * - `cardBadge` (W2b, K-01): `accent` paints the sale / new / custom chips in the look's accent pair
 *   with the look radius and no glow, unless the merchant picked a badge colour.
 */
export const LOOK_WORDMARK_SIZES = ['lg', 'xl'] as const;
export const LOOK_OVER_PHOTO_CHROMES = ['soft', 'bare'] as const;
export const LOOK_RECEIPT_STYLES = ['device', 'framed'] as const;
export const LOOK_CARD_CTAS = ['none', 'quiet'] as const;
export const LOOK_CARD_HOVERS = ['none', 'lift'] as const;
export const LOOK_CARD_BADGES = ['accent'] as const;
/**
 * Header chrome the MERCHANT may override on top of the look (Ruling EP-4): where the logo sits
 * and whether the search is a prominent field. They are not look tokens (no look sets them in its
 * `tokens`; the look's own value is `chrome.header`), so a stored value is always a merchant pick:
 * precedence merchant > look > skin. A design reset clears them like a look token.
 */
export const HEADER_LOGO_PLACEMENTS = ['start', 'centre'] as const;
export const HEADER_SEARCH_PLACEMENTS = ['prominent', 'icon'] as const;
export type HeaderLogoPlacement = (typeof HEADER_LOGO_PLACEMENTS)[number];
/**
 * The merchant's pick for a store with NO uploaded logo (TEMPLATES-MOCK-1/-3): `lockup` = the look's
 * designed wordmark (display name + letter-spaced Latin line), `plain` = the skin's own plain name.
 * Unset = `lockup`. A merchant logo always wins whatever this says.
 */
export const HEADER_WORDMARKS = ['lockup', 'plain'] as const;
export type HeaderWordmark = (typeof HEADER_WORDMARKS)[number];
/**
 * The merchant's mobile hero ratio (TEMPLATES-MOCK-4): `tall` 4:5 portrait, `square` 1:1, `wide` the old landscape
 * crop. Unset = the look's own mock ratio (`MOCK_TOKENS.heroAspect`). Phones only; desktop is unchanged.
 */
export const HERO_RATIOS = ['tall', 'square', 'wide'] as const;
export type HeroRatio = (typeof HERO_RATIOS)[number];
/**
 * The merchant's phone tab bar (TEMPLATES-MOCK-5): `always` the old bar on every shopping page, `inner` every
 * page except the home page (the mock: the cart is the header bag), `never` no bar. Unset = `inner` on a look
 * store, `always` on a store with no look (untouched).
 */
/** The merchant's section-heading weight (TEMPLATES-MOCK-6). Unset = the look's own (bold where its display face ships a bold weight). */
export const HEADING_WEIGHTS = ['regular', 'bold'] as const;
export type HeadingWeight = (typeof HEADING_WEIGHTS)[number];
/** Product price colour on cards (TEMPLATES-MOCK-6): the look's accent (made readable) or the plain text colour. */
export const PRICE_COLOURS = ['accent', 'text'] as const;
export type PriceColour = (typeof PRICE_COLOURS)[number];
/** A bit of card chrome on home grids (TEMPLATES-MOCK-7): the wishlist heart, colour dots, tag chips. Unset = off on a look store. */
export const CARD_CHROME = ['on', 'off'] as const;
export type CardChrome = (typeof CARD_CHROME)[number];
/** Gutter of the home product grids (TEMPLATES-MOCK-8): `tight` 3px columns / 22px rows (the Atelier mock), `regular` the pre-mock gaps, `airy` 24px / 32px. */
export const GRID_GUTTERS = ['tight', 'regular', 'airy'] as const;
export type GridGutter = (typeof GRID_GUTTERS)[number];
export const TAB_BARS = ['always', 'inner', 'never'] as const;
export type TabBarMode = (typeof TAB_BARS)[number];
export type HeaderSearchPlacement = (typeof HEADER_SEARCH_PLACEMENTS)[number];
export type WordmarkSize = (typeof LOOK_WORDMARK_SIZES)[number];
export type OverPhotoChrome = (typeof LOOK_OVER_PHOTO_CHROMES)[number];
export type ReceiptStyle = (typeof LOOK_RECEIPT_STYLES)[number];
export type CardCta = (typeof LOOK_CARD_CTAS)[number];
export type CardHover = (typeof LOOK_CARD_HOVERS)[number];
export type CardBadge = (typeof LOOK_CARD_BADGES)[number];

/** Colour roles as hex; converted to HSL triplets by lookTheme(). */
export interface LookTokens {
  page: string;
  surface: string;
  ink: string;
  muted: string;
  primary: string;
  onPrimary: string;
  accent: string;
  /** Text on the accent fill. Absent = `onPrimary` (VT-03: Vitrine's dusty rose carries ink). */
  onAccent?: string;
  line: string;
  /** Arabic display face, body face (Arabic-capable), Latin display face — Google Fonts family names. */
  fonts: { display: string; body: string; latin: string };
  radius: BorderRadius;
  density: Density;
  imageRatio: ImageRatio;
  motion: Motion;
  /** Optional UI tokens (see LOOK_UI_TOKEN_KEYS); absent = the skin's own behaviour. */
  wordmarkSize?: WordmarkSize;
  overPhotoChrome?: OverPhotoChrome;
  receiptStyle?: ReceiptStyle;
  cardCta?: CardCta;
  cardHover?: CardHover;
  cardBadge?: CardBadge;
}

export interface LookDefinition {
  id: LookId;
  template: LookTemplate;
  letter: 'A' | 'B' | 'C';
  name: { ar: string; en: string };
  forWhom: { ar: string; en: string };
  idea: { ar: string; en: string };
  tokens: LookTokens;
  /** Component skin used to render until the template's own skin ships (Ruling LOOKS-5). */
  skin: TemplateId;
  /** 'designed' = tokens + mix only; 'built' = skin + sections shipped and reviewed (demo bar lists only built). */
  status: 'designed' | 'built';
  /** The look's home section mix, in page order (Ruling B1-3). Absent = the template family's mix. */
  sections?: readonly LookSectionSpec[];
  /** Chrome choices the look's skin reads (Ruling B1-4). */
  chrome?: LookChrome;
}

/** One section of a look's home mix (Ruling B1-3). */
export interface LookSectionSpec {
  /** A SECTION_REGISTRY type with group 'template'. */
  type: string;
  /** Design keys (LOOK_DESIGN_KEYS only), applied to an existing section too. */
  design?: Record<string, unknown>;
  /** Starting settings for a section the store does not have yet (never applied to an existing one). */
  preset?: Record<string, unknown>;
  /**
   * Starting blocks for a section the store does not have yet (never applied to an existing one).
   * Absent = the registry preset's blocks. Phase B5 (Ruling B5-8): Workshop's journey strip reuses
   * Jasmine's `steps` section, whose registry preset is a skincare routine; the mix names its own
   * three jewellery steps here instead of forking the section.
   */
  blocks?: ReadonlyArray<{ type: string; settings: Record<string, unknown> }>;
}

/** Chrome choices a skin reads from the look (Ruling B1-4). */
export interface LookChrome {
  header: {
    logoPlacement: 'start' | 'centre';
    /**
     * Search placement (Ruling B2-1): `prominent` = a full-width labelled search field in the
     * header (the Souq skin, search-first); `icon` or absent = the skin's own icon search.
     */
    search?: 'prominent' | 'icon';
  };
  /**
   * Listing grid (Phase B2 STOP-2, taste P1-1): `autoFill` lays the PLP out as
   * `repeat(auto-fill, minmax(11.5rem, 1fr))` from `lg`, so the cards fill the whole column next to
   * the filter rail instead of five narrow cells with a 110px photo. Absent = the skin's own grid.
   * Since Ruling B4-PLP-1 / B4-21 every template (Dahab aside) lists on the auto-fit grid, so this flag
   * no longer changes anything; it stays on the Souq looks as a record of their ask.
   */
  plp?: 'autoFill';
  /**
   * `ground` keeps the listing pages (products, search, categories) on the look's own ground. Absent =
   * a DARK look lists its photos on the inverse light band (B1 I-3). Night souq mattes its photos
   * instead (cream matte + multiply, globals.css), so its green runs through every page (STOP-2).
   */
  listing?: 'ground';
  /**
   * Browse cart bar (Ruling B4-6): `total` shows a phone bar with the item count, the total and the
   * cart link on home, category and search while the cart has items; it replaces the tab bar
   * (C-04). Absent = no bar.
   */
  cartBar?: 'total';
  /**
   * Card stepper (Ruling B4-4): `inline` turns the card's add control into - qty + once a
   * non-variant product is in the cart. Absent = the card's own add control, byte-identical.
   */
  cardStepper?: 'inline';
  /**
   * Aisle tints (Ruling B4-2): the colours a `category-grid` with `tint: 'aisles'` cycles as
   * 12-14% tints behind ink captions. Hex, no orange (gated with the look tokens).
   */
  aisles?: readonly string[];
}

/**
 * Settings a look's `design` may set: layout/variant/background/spacing, never content.
 * Hero `mode` (slideshow vs single) is CONTENT (registry group `content`): no look sets it, so a
 * merchant's slideshow never collapses on a switch.
 */
export const LOOK_DESIGN_KEYS = [
  'presentation',
  'frame',
  'textAnchor',
  'layout',
  'layoutMobile',
  'source',
  'tint',
  'tabs',
  'variant',
  'captionPosition',
  'desktopColumns',
  'mobileColumns',
  'columns',
  'tileShape',
  'imagePosition',
  'imageAspect',
  'cardShape',
  'cardAspect',
  'cardGap',
  'showCardFrame',
  'bgColor',
  'paddingTop',
  'paddingBottom',
] as const;

/** StoreTheme keys a look owns. A stored value for one of these is a merchant override. */
export const LOOK_TOKEN_KEYS = [
  'backgroundColor',
  'foregroundColor',
  'cardColor',
  'cardForeground',
  'popoverColor',
  'popoverForeground',
  'mutedColor',
  'mutedForeground',
  'primaryColor',
  'primaryForeground',
  'accentColor',
  'accentForeground',
  'secondaryColor',
  'secondaryForeground',
  'borderColor',
  'inputColor',
  'ringColor',
  'headingFont',
  'bodyFont',
  'borderRadius',
  'bgPage',
  'bgSectionAlt',
  'density',
  'imageRatio',
  'motion',
] as const satisfies readonly (keyof StoreTheme)[];

/**
 * Optional look-owned StoreTheme keys (W2a). A look emits one only when it sets it, so a stored
 * value is still a merchant override (precedence merchant > look > skin, composeStoreTheme) and
 * a design reset clears it like any LOOK_TOKEN_KEYS key.
 */
export const LOOK_UI_TOKEN_KEYS = [
  'wordmarkSize',
  'overPhotoChrome',
  'receiptStyle',
  'cardCta',
  'cardHover',
  'cardBadge',
] as const satisfies readonly (keyof StoreTheme)[];

/** The merchant's header chrome overrides (see `HEADER_LOGO_PLACEMENTS`). A design reset clears them. */
export const HEADER_CHROME_OVERRIDE_KEYS = [
  'headerLogoPlacement',
  'headerSearch',
  'headerWordmark',
] as const satisfies readonly (keyof StoreTheme)[];

/** The merchant's mock-trait overrides (TEMPLATES-MOCK-2/-3): absent until picked, cleared by a design reset. */
export const MOCK_TRAIT_KEYS = [
  'heroRatio',
  'tabBar',
  'headingWeight',
  'priceColour',
  'cardHeart',
  'cardSwatches',
  'cardTags',
  'gridGutter',
] as const satisfies readonly (keyof StoreTheme)[];

/** Every StoreTheme key a design reset clears: the look's tokens, its optional UI tokens, and the merchant's header overrides. */
export const LOOK_OWNED_THEME_KEYS = [
  ...LOOK_TOKEN_KEYS,
  ...LOOK_UI_TOKEN_KEYS,
  ...HEADER_CHROME_OVERRIDE_KEYS,
  ...MOCK_TRAIT_KEYS,
] as const;
