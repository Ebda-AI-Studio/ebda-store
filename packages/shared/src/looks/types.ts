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

/** Every StoreTheme key a look owns: the always-set tokens plus the optional UI tokens. */
export const LOOK_OWNED_THEME_KEYS = [...LOOK_TOKEN_KEYS, ...LOOK_UI_TOKEN_KEYS] as const;
