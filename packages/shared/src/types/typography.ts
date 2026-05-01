// Per-store typography settings.
//
// Stored on Store.typography as JSON (see schema.prisma) and applied
// at storefront runtime by injecting:
//   1. <link>/<style> tags for every entry in `fonts` (Google Fonts URL
//      or @font-face for merchant-uploaded files), and
//   2. CSS rules that target `[data-zone="<name>"]` containers in the
//      template tree, mapping each zone to its chosen
//      family/size/weight/color.
//
// Templates tag their DOM regions with data-zone attributes (header,
// beforeHeader, categories, products, footer, afterFooter) so the
// storefront stylesheet doesn't need to know which template is active.

export type TypographyZone =
  | 'beforeHeader'
  | 'header'
  | 'categories'
  | 'products'
  | 'footer'
  | 'afterFooter';

export const TYPOGRAPHY_ZONES: TypographyZone[] = [
  'beforeHeader',
  'header',
  'categories',
  'products',
  'footer',
  'afterFooter',
];

export interface TypographyZoneSettings {
  /** Font-family value to set. Use one of the loaded font names from
   *  `fonts`, a system font, or a CSS-quoted family. Empty string =
   *  inherit from the template. */
  fontFamily?: string;
  /** Any valid CSS font-size: `16px`, `1.125rem`, `clamp(...)`. */
  fontSize?: string;
  /** Any valid CSS font-weight: `400`, `600`, `bold`. */
  fontWeight?: string;
  /** Any valid CSS color value: hex, rgb, hsl, oklch. */
  color?: string;
  /** Any valid CSS line-height. Optional, falls back to template. */
  lineHeight?: string;
  /** Any valid CSS letter-spacing. Optional. */
  letterSpacing?: string;
}

export interface TypographyFontSourceGoogle {
  type: 'google';
  /** The Google Fonts CSS URL the merchant pasted from
   *  https://fonts.google.com — e.g.
   *  https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap. */
  url: string;
  /** Family name(s) loaded by this URL — used in suggestions / preview. */
  family: string;
}

export interface TypographyFontSourceCustom {
  type: 'custom';
  /** Family name to register via @font-face. The merchant chooses this
   *  themselves — it's how they reference the font in zone settings. */
  family: string;
  /** R2-hosted URL of the font file. Must be in our bucket so the
   *  storefront's @font-face src can load it. */
  url: string;
  /** woff2 / woff / ttf / otf — used for the @font-face format() hint. */
  format: 'woff2' | 'woff' | 'ttf' | 'otf';
  /** Optional weight + style for variable / multi-weight families. */
  weight?: string;
  style?: 'normal' | 'italic';
}

export type TypographyFontSource = TypographyFontSourceGoogle | TypographyFontSourceCustom;

export interface TypographySettings {
  /** Library of fonts loaded into the storefront. Each entry produces
   *  a <link> (google) or <style>@font-face (custom) tag. */
  fonts: TypographyFontSource[];
  /** Per-zone overrides. Missing zones inherit the template's default. */
  zones: Partial<Record<TypographyZone, TypographyZoneSettings>>;
}

export const EMPTY_TYPOGRAPHY: TypographySettings = {
  fonts: [],
  zones: {},
};
