/**
 * Canonical image-asset sizes for every merchant-uploadable surface on Ebda.
 * Single source of truth for the admin "Recommended size: X × Y px" hints
 * + the design.md image-standards table + (future) server-side validators.
 *
 * Mirrors the table in design.md → "## Image asset standards (canonical
 * designer brief)" — keep both in sync when standards change.
 *
 * Sourced from the zFloos theme brief Ahmad shared 2026-05-17 +
 * cross-checked against Ebda's actual rendered aspect ratios.
 */

import type { TemplateId } from './store-theme';

export interface ImageStandard {
  /** Recommended SOURCE width in pixels (what the merchant uploads). */
  width: number;
  /** Recommended SOURCE height in pixels. */
  height: number;
  /** Aspect ratio as "W:H" — what the storefront wraps the image in. */
  aspect: string;
  /** Allowed file formats, ordered by preference. */
  formats: ReadonlyArray<'JPEG' | 'WebP' | 'PNG'>;
  /**
   * Optional safe zone for text/CTA inside banner-class images. When set,
   * merchants must keep any baked-in headline/CTA within these center
   * dimensions so mobile crops don't lose the message. Unset = full canvas.
   */
  safeZone?: { width: number; height: number };
  /** One-line description shown to merchants in admin hints. */
  description: string;
  /**
   * Per-template recommended-source override. When a merchant's store
   * template appears as a key here (none do today; the overrides all belonged to the
   * deleted Force skins, Ruling SKIN-DEL-1), that recommendation is shown in admin upload hints
   * instead of the base width/height. Rendered storefront sizing stays
   * UNIFORM per the theme-identity-audit rule — only the *upload hint*
   * varies per theme.
   *
   * Ref: docs/superpowers/audits/2026-05-18-per-theme-image-spec-audit.md
   */
  templateOverrides?: Partial<
    Record<TemplateId, { width: number; height: number; aspect: string; note?: string }>
  >;
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
    width: 1200,
    height: 900,
    aspect: '4:3', // taller hero for mobile prominence (testing)
    formats: ['JPEG', 'WebP'],
    // Safe zone: text/CTA must stay inside the center 960×540 zone so
    // bottom-cropping (at max-h-[45vh] on tall phones) never cuts the message.
    safeZone: { width: 1020, height: 765 },
    description:
      'Hero — mobile 4:3 crop (1200×900). Tall prominent mobile hero. Text/CTA inside center 1020×765 safe zone. Falls back to desktop image if not uploaded.',
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
    width: 900,
    height: 700,
    aspect: '9:7',
    formats: ['JPEG', 'WebP'],
    safeZone: { width: 700, height: 600 },
    description:
      "Full-width promotional banner — mobile. Near-square crop (9:7) per Ahmad 2026-05-18 reference set. Subject/CTA must fit inside the 700×600 center safe zone so iPhone-mini crops don't lose the message.",
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
  productMobile: {
    width: 600,
    height: 600,
    aspect: '1:1',
    formats: ['JPEG', 'WebP'],
    description:
      "Product photo — mobile-tuned 1:1 (600×600). Smaller file than productSquare's 800×800. Pair with cardAspect = square. No baked-in text or sale badges.",
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
  categoryMobile: {
    width: 630,
    height: 630,
    aspect: '1:1',
    formats: ['JPEG', 'WebP', 'PNG'],
    description:
      "Category card image — mobile-tuned 1:1 (630×630). Smaller file than categorySquare's 800×800 desktop ref. Use when merchant only ships one image and storefront is mobile-first.",
  },
  brandLogoCarousel: {
    width: 300,
    height: 150,
    aspect: '2:1',
    formats: ['PNG', 'WebP'],
    description: 'Brand logo for the carousel — transparent background mandatory.',
  },
  brandLogoFooter: {
    width: 200,
    height: 80,
    aspect: '2.5:1',
    formats: ['PNG', 'WebP'],
    description: 'Brand logo for the footer — smaller mark. Upload at 2x for retina.',
  },
  categoryIcon: {
    width: 120,
    height: 120,
    aspect: '1:1',
    formats: ['PNG', 'WebP'],
    description: 'Category icon — simple line art at 2px stroke, transparent PNG.',
  },
  storeLogo: {
    width: 400,
    height: 200,
    aspect: '2:1',
    formats: ['PNG', 'WebP'],
    description:
      'Store header logo — horizontal wordmark. Renders at h-24 mobile / h-36 desktop. Transparent PNG preferred. See storeLogoSquare for the square-brandmark alternative.',
  },
  storeLogoSquare: {
    // Brands with a circular / square mark (think Instagram avatar style)
    // can ship a 1:1 logo instead of the 2:1 wordmark. Header renders the
    // square at the same h-24 / h-36 height — narrower footprint, more
    // brand-friendly for icon-led identities (e.g. Demo Shop's circular
    // olive-jar mark, verified prod 2026-05-17).
    width: 400,
    height: 400,
    aspect: '1:1',
    formats: ['PNG', 'WebP'],
    description:
      'Store header logo — square brandmark alternative. Use when brand identity is icon-led rather than wordmark-led.',
  },
  favicon: {
    width: 512,
    height: 512,
    aspect: '1:1',
    formats: ['PNG'],
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

/**
 * Like `recommendedSizeText`, but resolves a per-template override
 * when one exists. Falls back to the base width/height otherwise.
 *
 * Examples:
 *   recommendedSizeTextForTemplate('heroDesktop', 'qamar')
 *     → "Recommended: 1920 × 700 px (JPEG / WebP)"  (base)
 *   recommendedSizeTextForTemplate('heroDesktop', undefined)
 *     → "Recommended: 1920 × 700 px (JPEG / WebP)"  (base)
 */
export function recommendedSizeTextForTemplate(
  key: ImageStandardKey,
  template: TemplateId | undefined
): string {
  // Cast to the ImageStandard interface so templateOverrides is consistently accessible
  // across all entries (entries without overrides have it typed as undefined in the const).
  const base = IMAGE_STANDARDS[key] as ImageStandard;
  const override = template ? base.templateOverrides?.[template] : undefined;
  if (override) {
    return `Recommended: ${override.width} × ${override.height} px (${base.formats.join(' / ')}) — ${template} theme`;
  }
  return `Recommended: ${base.width} × ${base.height} px (${base.formats.join(' / ')})`;
}

/**
 * Like `recommendedSizeTextI18n`, but resolves a per-template override.
 * Returns { en, ar } bilingual pair. Falls back to base when no override.
 *
 * Example:
 *   recommendedSizeTextForTemplateI18n('productPrimary', 'qamar', 'ar')
 *     → "الحجم الموصى به: 600 × 800 بكسل (JPEG / WebP)"  (base)
 */
export function recommendedSizeTextForTemplateI18n(
  key: ImageStandardKey,
  template: TemplateId | undefined,
  lang: 'en' | 'ar'
): string {
  // Cast to the ImageStandard interface — same reason as in recommendedSizeTextForTemplate.
  const base = IMAGE_STANDARDS[key] as ImageStandard;
  const override = template ? base.templateOverrides?.[template] : undefined;
  if (override) {
    if (lang === 'ar') {
      return `الحجم الموصى به: ${override.width} × ${override.height} بكسل (${base.formats.join(' / ')}) — قالب ${template}`;
    }
    return `Recommended: ${override.width} × ${override.height} px (${base.formats.join(' / ')}) — ${template} theme`;
  }
  if (lang === 'ar') {
    return `الحجم الموصى به: ${base.width} × ${base.height} بكسل (${base.formats.join(' / ')})`;
  }
  return `Recommended: ${base.width} × ${base.height} px (${base.formats.join(' / ')})`;
}
