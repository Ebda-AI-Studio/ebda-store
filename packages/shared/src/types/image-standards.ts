/**
 * Canonical image-asset sizes for every merchant-uploadable surface on FWB.
 * Single source of truth for the admin "Recommended size: X × Y px" hints
 * + the design.md image-standards table + (future) server-side validators.
 *
 * Mirrors the table in design.md → "## Image asset standards (canonical
 * designer brief)" — keep both in sync when standards change.
 *
 * Sourced from the zFloos theme brief Ahmad shared 2026-05-17 +
 * cross-checked against FWB's actual rendered aspect ratios.
 */

export interface ImageStandard {
  /** Recommended SOURCE width in pixels (what the merchant uploads). */
  width: number;
  /** Recommended SOURCE height in pixels. */
  height: number;
  /** Aspect ratio as "W:H" — what the storefront wraps the image in. */
  aspect: string;
  /** Allowed file formats, ordered by preference. */
  formats: ReadonlyArray<'JPEG' | 'WebP' | 'PNG' | 'SVG' | 'ICO'>;
  /**
   * Optional safe zone for text/CTA inside banner-class images. When set,
   * merchants must keep any baked-in headline/CTA within these center
   * dimensions so mobile crops don't lose the message. Unset = full canvas.
   */
  safeZone?: { width: number; height: number };
  /** One-line description shown to merchants in admin hints. */
  description: string;
}

export const IMAGE_STANDARDS = {
  heroDesktop: {
    width: 1920,
    height: 700,
    aspect: '1920:700',
    formats: ['JPEG', 'WebP'],
    safeZone: { width: 900, height: 700 },
    description: 'Hero slider — desktop. Text/CTA must fit inside center 900px safe zone.',
  },
  heroMobile: {
    width: 800,
    height: 1067,
    aspect: '3:4',
    formats: ['JPEG', 'WebP'],
    description: 'Hero slider — mobile portrait crop. Separate upload from desktop.',
  },
  bannerDesktop: {
    width: 1920,
    height: 400,
    aspect: '4.8:1',
    formats: ['JPEG', 'WebP'],
    safeZone: { width: 900, height: 400 },
    description: 'Full-width promotional banner — desktop.',
  },
  bannerMobile: {
    width: 800,
    height: 600,
    aspect: '4:3',
    formats: ['JPEG', 'WebP'],
    description: 'Full-width promotional banner — mobile.',
  },
  productPrimary: {
    width: 600,
    height: 800,
    aspect: '3:4',
    formats: ['JPEG', 'WebP'],
    description: 'Product photo — canonical 3:4 portrait. No baked-in text or sale badges.',
  },
  productSquare: {
    width: 800,
    height: 800,
    aspect: '1:1',
    formats: ['JPEG', 'WebP'],
    description: 'Product photo — square alt aspect (when admin cardAspect = square).',
  },
  categorySquare: {
    width: 800,
    height: 800,
    aspect: '1:1',
    formats: ['JPEG', 'WebP', 'PNG'],
    description: 'Category card image — default 1:1 square.',
  },
  categoryPortrait: {
    width: 600,
    height: 800,
    aspect: '3:4',
    formats: ['JPEG', 'WebP'],
    description: 'Category card image — portrait alt (when admin cardShape = portrait).',
  },
  brandLogoCarousel: {
    width: 300,
    height: 150,
    aspect: '2:1',
    formats: ['PNG', 'SVG'],
    description: 'Brand logo for the carousel — transparent background mandatory.',
  },
  brandLogoFooter: {
    width: 200,
    height: 80,
    aspect: '2.5:1',
    formats: ['SVG', 'PNG'],
    description: 'Brand logo for the footer — smaller mark. SVG preferred for retina.',
  },
  categoryIcon: {
    width: 120,
    height: 120,
    aspect: '1:1',
    formats: ['SVG', 'PNG'],
    description: 'Category icon — simple line art at 2px stroke. SVG preferred.',
  },
  storeLogo: {
    width: 400,
    height: 200,
    aspect: '2:1',
    formats: ['SVG', 'PNG'],
    description:
      'Store header logo — horizontal wordmark. Renders at h-24 mobile / h-36 desktop. SVG preferred. See storeLogoSquare for the square-brandmark alternative.',
  },
  storeLogoSquare: {
    // Brands with a circular / square mark (think Instagram avatar style)
    // can ship a 1:1 logo instead of the 2:1 wordmark. Header renders the
    // square at the same h-24 / h-36 height — narrower footprint, more
    // brand-friendly for icon-led identities (e.g. Wady Aljuz's circular
    // olive-jar mark, verified prod 2026-05-17).
    width: 400,
    height: 400,
    aspect: '1:1',
    formats: ['SVG', 'PNG'],
    description:
      'Store header logo — square brandmark alternative. Use when brand identity is icon-led rather than wordmark-led.',
  },
  favicon: {
    width: 512,
    height: 512,
    aspect: '1:1',
    formats: ['PNG', 'ICO'],
    description: 'Favicon + PWA + Apple touch icon — generated from this single source.',
  },
  ogImage: {
    width: 1200,
    height: 630,
    aspect: '~1.91:1',
    formats: ['JPEG', 'PNG'],
    safeZone: { width: 900, height: 470 },
    description: 'Social share card (Facebook / Twitter / LinkedIn). Headline in safe zone.',
  },
  pwaSplash: {
    width: 1080,
    height: 1920,
    aspect: '9:16',
    formats: ['PNG'],
    safeZone: { width: 540, height: 960 },
    description: 'PWA install splash screen — centered logo on brand color background.',
  },
  blogCover: {
    width: 1200,
    height: 800,
    aspect: '3:2',
    formats: ['JPEG', 'WebP'],
    description: 'Blog post cover image — 3:2 landscape editorial crop.',
  },
  pageCover: {
    width: 1920,
    height: 700,
    aspect: '1920:700',
    formats: ['JPEG', 'WebP'],
    description: 'CMS page cover (about / contact / etc.) — same as hero spec.',
  },
} as const satisfies Record<string, ImageStandard>;

export type ImageStandardKey = keyof typeof IMAGE_STANDARDS;

/**
 * Helper — format a recommended-size hint string for admin UI.
 * Example: `recommendedSizeText('heroDesktop')`
 *   → "Recommended: 1920 × 700 px (JPEG / WebP)"
 */
export function recommendedSizeText(key: ImageStandardKey): string {
  const s = IMAGE_STANDARDS[key];
  return `Recommended: ${s.width} × ${s.height} px (${s.formats.join(' / ')})`;
}

/**
 * Helper — format a bilingual recommended-size hint pair.
 * Returns { en, ar } so admin pages can pick by useLanguage().
 */
export function recommendedSizeTextI18n(key: ImageStandardKey): { en: string; ar: string } {
  const s = IMAGE_STANDARDS[key];
  return {
    en: `Recommended: ${s.width} × ${s.height} px (${s.formats.join(' / ')})`,
    ar: `الحجم الموصى به: ${s.width} × ${s.height} بكسل (${s.formats.join(' / ')})`,
  };
}
