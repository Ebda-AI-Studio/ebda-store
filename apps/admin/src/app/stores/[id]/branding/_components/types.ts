export interface StoreTheme {
  primaryColor: string;
  primaryForeground: string;
  secondaryColor: string;
  backgroundColor: string;
  foregroundColor: string;
  fontFamily: string;
  borderRadius: string;
  /**
   * Homepage section background preset — added 2026-05-17 (Sprint 1).
   * When unset or 'none', sections share the page background and rely
   * on padding + section title anchors for rhythm. When set to a named
   * preset, adjacent sections alternate visibly via `--bg-page` ↔
   * `--bg-section-alt` CSS tokens resolved in @force/shared.
   *
   * - `none`         — flat surface, no alternation
   * - `warmSand`     — #FAF7F2 ↔ #F0EAE0 (premium grocery / heritage)
   * - `coolGrey`     — #F8F8F8 ↔ #EEEEEE (tech / modern)
   * - `pureWhite`    — #FFFFFF ↔ #FAFAFA (minimal rhythm without color)
   * - `brandColor`   — derived from `primaryColor` (HSL lifted to 96%/92% L)
   */
  backgroundPreset?: 'none' | 'warmSand' | 'coolGrey' | 'pureWhite' | 'brandColor';
  /**
   * Opt-in brand pill (C5 from 2026-05-17 UI refresh). When true, the
   * store name renders as a small pill in the top-START corner of every
   * product card image. Hidden automatically when an OOS ribbon or NEW
   * badge is in that corner. Default false.
   */
  showBrandBadge?: boolean;
  /**
   * Opt-in quick-add (+) circle overlay on carousel cards (E3).
   * Single-tap add-to-cart without leaving the page. Default false.
   */
  showQuickAdd?: boolean;
  /** Show the "Our Story" homepage block. Default true (uses heroImage + description). */
  showBrandStory?: boolean;
  /** Show the 3-up trust strip above the footer. Default true. */
  showTrustStrip?: boolean;
  /** Trust-strip layout direction. Default 'horizontal' (3-up grid). */
  trustStripLayout?: 'horizontal' | 'vertical';
}

export interface StoreBranding {
  id: string;
  name: string;
  nameAr?: string;
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  theme: StoreTheme;
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;
  /**
   * Optional explicit map URL (e.g. a Google / Apple Maps pin) the merchant
   * wants the storefront footer to link to. When present + `addressLink` is
   * true (or unset), the address text is wrapped in `<a href={addressUrl}>`.
   * Persisted at `store.settings.contact.addressUrl`.
   */
  addressUrl?: string;
  /**
   * Whether the storefront footer renders the address as a clickable link.
   * Defaults to `true` when undefined (matches the long-standing behaviour).
   * `false` keeps the address as plain text. Persisted at
   * `store.settings.contact.addressLink`.
   */
  addressLink?: boolean;
  socialLinks: {
    instagram?: string;
    facebook?: string;
    twitter?: string;
    tiktok?: string;
    youtube?: string;
    snapchat?: string;
    linkedin?: string;
    wikidata?: string;
    wikipedia?: string;
  };
  /**
   * Bucket E1 (2026-05-17) — opt-in blog module. When false the public
   * /blog routes 404 and the homepage BlogCarousel is hidden. Saved via
   * the generic PUT /stores/:id endpoint (updateStoreSchema accepts
   * `blogEnabled` as of the same date).
   */
  blogEnabled?: boolean;
}

export type BrandingTabId = 'branding' | 'theme' | 'contact' | 'social';

export const DEFAULT_THEME: StoreTheme = {
  primaryColor: '26 100% 50%',
  primaryForeground: '0 0% 100%',
  secondaryColor: '220 14% 96%',
  backgroundColor: '0 0% 100%',
  foregroundColor: '224 71% 4%',
  fontFamily: 'default',
  borderRadius: 'md',
  backgroundPreset: 'none',
  showBrandBadge: false,
  showQuickAdd: false,
  showBrandStory: true,
  showTrustStrip: true,
  trustStripLayout: 'horizontal',
};

/**
 * Background-preset picker options — labels are translated via
 * `branding.theme.backgroundPreset.<value>` keys in the i18n bundle so
 * each option shows a localized name + description.
 */
export const BACKGROUND_PRESET_OPTIONS: Array<{
  value: NonNullable<StoreTheme['backgroundPreset']>;
  /** approximate two-tone preview swatches, displayed as small colored chips */
  swatches: [string, string];
}> = [
  { value: 'none', swatches: ['#FFFFFF', '#FFFFFF'] },
  { value: 'warmSand', swatches: ['#FAF7F2', '#F0EAE0'] },
  { value: 'coolGrey', swatches: ['#F8F8F8', '#EEEEEE'] },
  { value: 'pureWhite', swatches: ['#FFFFFF', '#FAFAFA'] },
  { value: 'brandColor', swatches: ['var(--brand-tint-1)', 'var(--brand-tint-2)'] },
];

export const FONT_OPTIONS: Array<{ value: string; key: string }> = [
  { value: 'default', key: 'default' },
  { value: 'serif', key: 'serif' },
  { value: 'modern', key: 'modern' },
  { value: 'rounded', key: 'rounded' },
];

export const BORDER_RADIUS_OPTIONS: Array<{ value: string; key: string }> = [
  { value: 'none', key: 'none' },
  { value: 'sm', key: 'sm' },
  { value: 'md', key: 'md' },
  { value: 'lg', key: 'lg' },
  { value: 'xl', key: 'xl' },
];

export const COLOR_PRESETS: Array<{ key: string; hex: string }> = [
  { key: 'orange', hex: '#FF6600' },
  { key: 'blue', hex: '#3B82F6' },
  { key: 'green', hex: '#16A34A' },
  { key: 'purple', hex: '#7C3AED' },
  { key: 'rose', hex: '#E11D48' },
  { key: 'teal', hex: '#0D9488' },
  { key: 'amber', hex: '#F59E0B' },
  { key: 'black', hex: '#171717' },
];

export const SOCIAL_PLATFORMS: Array<{
  key:
    | 'instagram'
    | 'facebook'
    | 'twitter'
    | 'tiktok'
    | 'youtube'
    | 'snapchat'
    | 'linkedin'
    | 'wikidata'
    | 'wikipedia';
  labelKey: string;
  placeholder: string;
}> = [
  { key: 'instagram', labelKey: 'instagram', placeholder: 'https://instagram.com/yourstore' },
  { key: 'facebook', labelKey: 'facebook', placeholder: 'https://facebook.com/yourstore' },
  { key: 'twitter', labelKey: 'twitter', placeholder: 'https://twitter.com/yourstore' },
  { key: 'tiktok', labelKey: 'tiktok', placeholder: 'https://tiktok.com/@yourstore' },
  { key: 'youtube', labelKey: 'youtube', placeholder: 'https://youtube.com/@yourstore' },
  { key: 'snapchat', labelKey: 'snapchat', placeholder: 'https://snapchat.com/add/yourstore' },
  { key: 'linkedin', labelKey: 'linkedin', placeholder: 'https://linkedin.com/company/yourstore' },
  { key: 'wikidata', labelKey: 'wikidata', placeholder: 'https://www.wikidata.org/wiki/Q12345' },
  {
    key: 'wikipedia',
    labelKey: 'wikipedia',
    placeholder: 'https://en.wikipedia.org/wiki/Your_Store',
  },
];
