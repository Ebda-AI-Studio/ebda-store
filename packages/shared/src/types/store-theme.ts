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
 * Convert theme to CSS custom properties
 */
export function themeToCssVars(theme: StoreTheme): Record<string, string> {
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

/**
 * Default empty marketing pixels configuration
 */
export const DEFAULT_MARKETING_PIXELS: MarketingPixels = {};

/**
 * Marketing platform metadata for UI
 */
export interface MarketingPlatformInfo {
  id: keyof MarketingPixels;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  icon: string;
  docsUrl: string;
  idLabel: string;
  idPlaceholder: string;
  hasAccessToken?: boolean;
  hasConversionLabel?: boolean;
}

/**
 * All supported marketing platforms
 */
export const MARKETING_PLATFORMS: MarketingPlatformInfo[] = [
  {
    id: 'meta',
    name: 'Meta Pixel',
    nameAr: 'بيكسل ميتا',
    description: 'Track conversions from Facebook and Instagram ads',
    descriptionAr: 'تتبع التحويلات من إعلانات فيسبوك وإنستغرام',
    icon: 'facebook',
    docsUrl: 'https://developers.facebook.com/docs/meta-pixel',
    idLabel: 'Pixel ID',
    idPlaceholder: '123456789012345',
    hasAccessToken: true,
  },
  {
    id: 'tiktok',
    name: 'TikTok Pixel',
    nameAr: 'بيكسل تيك توك',
    description: 'Track conversions from TikTok ads',
    descriptionAr: 'تتبع التحويلات من إعلانات تيك توك',
    icon: 'tiktok',
    docsUrl: 'https://ads.tiktok.com/help/article?aid=10021',
    idLabel: 'Pixel ID',
    idPlaceholder: 'CXXXXXXXXXXXXXXXXXX',
    hasAccessToken: true,
  },
  {
    id: 'snapchat',
    name: 'Snapchat Pixel',
    nameAr: 'بيكسل سناب شات',
    description: 'Track conversions from Snapchat ads',
    descriptionAr: 'تتبع التحويلات من إعلانات سناب شات',
    icon: 'snapchat',
    docsUrl: 'https://businesshelp.snapchat.com/s/article/snap-pixel-about',
    idLabel: 'Pixel ID',
    idPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  },
  {
    id: 'googleAnalytics',
    name: 'Google Analytics 4',
    nameAr: 'جوجل أناليتكس 4',
    description: 'Track website traffic and user behavior',
    descriptionAr: 'تتبع حركة الموقع وسلوك المستخدمين',
    icon: 'google-analytics',
    docsUrl: 'https://developers.google.com/analytics/devguides/collection/ga4',
    idLabel: 'Measurement ID',
    idPlaceholder: 'G-XXXXXXXXXX',
  },
  {
    id: 'googleTagManager',
    name: 'Google Tag Manager',
    nameAr: 'جوجل تاج مانجر',
    description: 'Manage all your marketing tags in one place',
    descriptionAr: 'إدارة جميع علامات التسويق في مكان واحد',
    icon: 'tag-manager',
    docsUrl: 'https://developers.google.com/tag-manager',
    idLabel: 'Container ID',
    idPlaceholder: 'GTM-XXXXXXX',
  },
  {
    id: 'googleAds',
    name: 'Google Ads',
    nameAr: 'إعلانات جوجل',
    description: 'Track conversions from Google Ads campaigns',
    descriptionAr: 'تتبع التحويلات من حملات إعلانات جوجل',
    icon: 'google-ads',
    docsUrl: 'https://support.google.com/google-ads/answer/6095821',
    idLabel: 'Conversion ID',
    idPlaceholder: 'AW-XXXXXXXXX',
    hasConversionLabel: true,
  },
  {
    id: 'twitter',
    name: 'Twitter/X Pixel',
    nameAr: 'بيكسل تويتر/إكس',
    description: 'Track conversions from Twitter/X ads',
    descriptionAr: 'تتبع التحويلات من إعلانات تويتر/إكس',
    icon: 'twitter',
    docsUrl:
      'https://business.twitter.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites.html',
    idLabel: 'Pixel ID',
    idPlaceholder: 'xxxxx',
  },
  {
    id: 'pinterest',
    name: 'Pinterest Tag',
    nameAr: 'علامة بينترست',
    description: 'Track conversions from Pinterest ads',
    descriptionAr: 'تتبع التحويلات من إعلانات بينترست',
    icon: 'pinterest',
    docsUrl: 'https://help.pinterest.com/en/business/article/install-the-pinterest-tag',
    idLabel: 'Tag ID',
    idPlaceholder: '1234567890123',
  },
];

/**
 * Helper to check if any marketing pixels are enabled
 */
export function hasActivePixels(pixels: MarketingPixels): boolean {
  return Object.values(pixels).some(
    config => config && typeof config === 'object' && 'enabled' in config && config.enabled
  );
}

/**
 * Get list of enabled pixel platforms
 */
export function getEnabledPixels(pixels: MarketingPixels): (keyof MarketingPixels)[] {
  return (Object.keys(pixels) as (keyof MarketingPixels)[]).filter(key => {
    const config = pixels[key];
    return config && typeof config === 'object' && 'enabled' in config && config.enabled;
  });
}
