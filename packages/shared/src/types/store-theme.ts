// Store Template & Theme Types

/**
 * Available store templates
 */
export type TemplateId = 'modern' | 'classic' | 'minimal' | 'bold' | 'elegant';

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
 * Store theme configuration - colors stored as HSL values
 */
export interface StoreTheme {
  // Core colors (HSL format: "26 100% 50%")
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

  // Custom CSS (for advanced users)
  customCss?: string;
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
  primaryColor: '26 100% 50%', // Orange
  primaryForeground: '0 0% 100%',
  secondaryColor: '220 14% 96%',
  secondaryForeground: '220 9% 46%',
  accentColor: '26 100% 95%',
  accentForeground: '26 100% 25%',
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
  ringColor: '26 100% 50%',

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
};

/**
 * Template presets with default themes
 */
export const TEMPLATE_THEMES: Record<TemplateId, Partial<StoreTheme>> = {
  modern: {
    primaryColor: '26 100% 50%', // Vibrant orange
    fontFamily: 'modern',
    borderRadius: 'lg',
  },
  classic: {
    primaryColor: '35 35% 35%', // Rich brown
    fontFamily: 'serif',
    borderRadius: 'sm',
  },
  minimal: {
    primaryColor: '0 0% 9%', // Near black
    fontFamily: 'default',
    borderRadius: 'none',
  },
  bold: {
    primaryColor: '262 83% 58%', // Vibrant purple
    fontFamily: 'rounded',
    borderRadius: 'xl',
  },
  elegant: {
    primaryColor: '340 82% 52%', // Rose pink
    fontFamily: 'serif',
    borderRadius: 'md',
  },
};

/**
 * All available templates with metadata
 */
export const TEMPLATES: TemplateInfo[] = [
  {
    id: 'modern',
    name: 'Modern',
    nameAr: 'عصري',
    description: 'Clean lines, bold accents, and contemporary feel',
    descriptionAr: 'خطوط نظيفة ولمسات جريئة وشعور معاصر',
    thumbnail: '/templates/modern.png',
    tags: ['tech', 'lifestyle', 'gadgets'],
    bestFor: 'Tech, lifestyle, and modern brands',
  },
  {
    id: 'classic',
    name: 'Classic',
    nameAr: 'كلاسيكي',
    description: 'Elegant serif fonts and timeless sophistication',
    descriptionAr: 'خطوط أنيقة وتطور خالد',
    thumbnail: '/templates/classic.png',
    tags: ['luxury', 'heritage', 'traditional'],
    bestFor: 'Luxury, heritage, and established brands',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    nameAr: 'بسيط',
    description: 'Maximum whitespace, product-focused design',
    descriptionAr: 'مساحة بيضاء واسعة وتصميم يركز على المنتج',
    thumbnail: '/templates/minimal.png',
    tags: ['photography', 'art', 'design'],
    bestFor: 'Photography, art galleries, and design studios',
  },
  {
    id: 'bold',
    name: 'Bold',
    nameAr: 'جريء',
    description: 'Vibrant colors, dynamic layouts, energetic feel',
    descriptionAr: 'ألوان نابضة وتخطيطات ديناميكية وشعور بالطاقة',
    thumbnail: '/templates/bold.png',
    tags: ['youth', 'sports', 'streetwear'],
    bestFor: 'Youth brands, sports, and streetwear',
  },
  {
    id: 'elegant',
    name: 'Elegant',
    nameAr: 'أنيق',
    description: 'Fashion-forward design with refined aesthetics',
    descriptionAr: 'تصميم عصري بجماليات راقية',
    thumbnail: '/templates/elegant.png',
    tags: ['fashion', 'jewelry', 'beauty'],
    bestFor: 'Fashion, jewelry, and beauty brands',
  },
];

/**
 * Get template info by ID
 */
export function getTemplateInfo(templateId: TemplateId): TemplateInfo | undefined {
  return TEMPLATES.find(t => t.id === templateId);
}

/**
 * Get theme for a template, merged with defaults
 */
export function getTemplateTheme(templateId: TemplateId): StoreTheme {
  return {
    ...DEFAULT_THEME,
    ...TEMPLATE_THEMES[templateId],
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
      const cappedS = Math.min(Number(s), 25);
      return {
        bgPage: `${h} ${cappedS}% 96%`,
        bgSectionAlt: `${h} ${cappedS}% 92%`,
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
export type ProductCardSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export function getProductCardTextSizes(cardSize: ProductCardSize | undefined): {
  name: string;
  price: string;
  cta: string;
} {
  switch (cardSize) {
    case 'xs':
    case 'sm':
      // Compact density — floor at 16px, no desktop step-up. Identity
      // carries via pack-style flavor (weight, tracking).
      return { name: 'text-base', price: 'text-base', cta: 'text-sm' };
    case 'lg':
      return { name: 'text-lg', price: 'text-lg sm:text-xl', cta: 'text-sm sm:text-base' };
    case 'xl':
      return { name: 'text-lg sm:text-xl', price: 'text-xl sm:text-2xl', cta: 'text-base' };
    case 'md':
    default:
      // Default — 16px mobile, 18px from sm breakpoint. Matches the
      // ratio the references (Pecannbee, SMEJ) use for their standard
      // ~200px product cards.
      return { name: 'text-base sm:text-lg', price: 'text-base sm:text-lg', cta: 'text-sm' };
  }
}

/**
 * Convert theme to CSS custom properties
 */
export function themeToCssVars(theme: StoreTheme): Record<string, string> {
  const bg = resolveBackgroundPreset(theme);
  return {
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
  };
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
