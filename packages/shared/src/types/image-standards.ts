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

import type { TemplateId } from './store-theme';

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
  /**
   * Per-template recommended-source override. When a merchant's store
   * template (modern / elegant / classic / minimal / bold) appears as
   * a key here, that recommendation is shown in admin upload hints
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
    // Per-theme overrides (sign-off 2026-05-18):
    //   - elegant: Ahmad directive — heroDesktop stays at 1920×700 (2.74:1 landscape lock
    //     is a platform invariant). Audit suggested 1920×800 but that was overridden.
    //   - modern: +7% width bump for glass-blur retina. Shopify heavier spec — see
    //     feedback-polaris-vs-storefront-image-sizes.md lines 26-27.
    //   - bold: full-bleed 100vw hero warrants widest source. Shopify upper bound 2400.
    //     Ref: docs/superpowers/audits/2026-05-18-per-theme-image-spec-audit.md §Surface 1.
    templateOverrides: {
      modern: {
        width: 2048,
        height: 750,
        aspect: '~2.73:1',
        note: 'Tech-startup glass-blur identity: 2048px gives clean 2× retina at the ~960px rendered half-column. Shopify heavier spec ref: feedback-polaris-vs-storefront-image-sizes.md lines 26-27.',
      },
      // elegant inherits base (1920×700) — Ahmad 2026-05-18 sign-off:
      // the 2.74:1 landscape lock is a platform invariant; do NOT add an elegant override.
      bold: {
        width: 2400,
        height: 900,
        aspect: '~2.67:1',
        note: 'Full-bleed 100vw hero — actual rendered width can exceed 1920 on 4K monitors. Shopify upper bound 2400×1000; kept at 900 height for landscape lock (design.md line 19). Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 1.',
      },
    },
  },
  heroMobile: {
    // 2026-06-03 (Ahmad directive): mobile hero is standardized to 16:9
    // (1200×675). Supersedes the 2026-05-18 "always match desktop aspect"
    // directive for mobile — mobile aspect is now DECOUPLED from the
    // per-theme desktop ratio (elegant 2.74:1, modern ~2.73:1, bold ~2.67:1).
    // The storefront renders the mobile hero at aspect-ratio: 1200/675 with a
    // max-h-[45vh] ceiling via inline style derived from this entry so the
    // admin hint and the render can NEVER drift again.
    // Upload hint: 1200×675 (16:9). If merchant uploads only a desktop image,
    // the storefront serves it down-scaled and center-crops via object-cover —
    // the 1920×700 desktop source crops cleanly to 16:9 (loses top/bottom).
    width: 1200,
    height: 675,
    aspect: '16:9',
    formats: ['JPEG', 'WebP'],
    // Safe zone: text/CTA must stay inside the center 960×540 zone so
    // bottom-cropping (at max-h-[45vh] on tall phones) never cuts the message.
    safeZone: { width: 960, height: 540 },
    description:
      'Hero — mobile-optimized 16:9 crop (1200×675). Text/CTA must fit inside center 960×540 safe zone. Falls back to desktop image if not uploaded.',
    // Per-theme mobile overrides: all themes now share 16:9 at mobile — the
    // desktop per-theme aspect lock (elegant 2.74:1, modern 2.73:1, bold 2.67:1)
    // is a DESKTOP-only decision. Removing stale 2026-05-18 overrides that
    // mirrored the desktop ratio at mobile scale (modern 1080×400, bold 1000×375)
    // since both are now superseded. elegant/classic/minimal still inherit
    // the 16:9 base. No overrides needed — all five templates use 16:9 mobile.
    // Ahmad 2026-06-03: explicitly no templateOverrides for heroMobile.
  },
  bannerDesktop: {
    width: 1920,
    height: 400,
    aspect: '4.8:1',
    formats: ['JPEG', 'WebP'],
    safeZone: { width: 900, height: 400 },
    description: 'Full-width promotional banner — desktop.',
    // No per-theme overrides. Banner is a uniform promotional strip;
    // no theme identity amplifies it enough to warrant a separate merchant brief.
    // Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 3 (all themes inherit).
  },
  bannerMobile: {
    width: 900,
    height: 700,
    aspect: '9:7',
    formats: ['JPEG', 'WebP'],
    safeZone: { width: 700, height: 600 },
    description:
      "Full-width promotional banner — mobile. Near-square crop (9:7) per Ahmad 2026-05-18 reference set. Subject/CTA must fit inside the 700×600 center safe zone so iPhone-mini crops don't lose the message.",
    // No per-theme overrides — same rationale as bannerDesktop.
    // Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 4.
  },
  productPrimary: {
    width: 600,
    height: 800,
    aspect: '3:4',
    formats: ['JPEG', 'WebP'],
    description: 'Product photo — canonical 3:4 portrait. No baked-in text or sale badges.',
    // Per-theme overrides: modern/classic get moderate +33% bump; bold gets
    // 1:1 to match its aspect-square ProductCard (eliminates 25% crop waste).
    // elegant: Ahmad 2026-05-18 sign-off — admin hint stays at 800×1067 so
    //   self-shooters aren't blocked. Luxury-tier merchants with studio
    //   photography MAY upload up to 1200×1600 for pinch-zoom, but the hint
    //   stays at 800×1067 (Modern/Classic tier). Note encoded in the 'note' field.
    // Ref: docs/superpowers/audits/2026-05-18-per-theme-image-spec-audit.md §Surface 5.
    templateOverrides: {
      modern: {
        width: 800,
        height: 1067,
        aspect: '3:4',
        note: 'Tech-startup identity: scale-[1.03] zoom + shadow on hover amplifies detail. 800px = 2× the ~400px rendered card width. Identity-audit modern line (rounded-2xl, glass-shadow). Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 5.',
      },
      elegant: {
        width: 800,
        height: 1067,
        aspect: '3:4',
        note: 'Luxury-boutique hint kept at 800×1067 (Ahmad 2026-05-18 sign-off) so self-shooters are not blocked. Studio/luxury-tier merchants with professional photography MAY upload up to 1200×1600 for pinch-zoom — the hint does not enforce a ceiling. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 5.',
      },
      classic: {
        width: 800,
        height: 1067,
        aspect: '3:4',
        note: 'Heritage retail (jewellery/oud/watches): moderate bump to 800 base matches modern step. Not at luxury pinch-zoom tier. Identity-audit classic (font-serif, sharp borders). Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 5.',
      },
      bold: {
        width: 800,
        height: 800,
        aspect: '1:1',
        note: 'Bold ProductCard uses aspect-square (code: <div className="relative aspect-square">). A 3:4 source wastes ~25% of pixels in the square crop. 800×800 matches actual rendered aspect. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 5.',
      },
      // minimal inherits base (600×800) — ascetic identity, LCP-first, compact throughout.
    },
  },
  productSquare: {
    width: 800,
    height: 800,
    aspect: '1:1',
    formats: ['JPEG', 'WebP'],
    description: 'Product photo — square alt aspect (when admin cardAspect = square).',
    // Per-theme overrides for square mode:
    // elegant gets 1200×1200 for consistency with luxury-tier retina policy.
    // bold gets 1000×1000 (its natural default aspect) — fits ≤1000 mobile cap.
    // Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 6.
    templateOverrides: {
      elegant: {
        width: 1200,
        height: 1200,
        aspect: '1:1',
        note: 'Consistent with luxury productPrimary tier: if an elegant merchant opts into square mode, same retina step applies. 1200×1200 matches productPrimary base width. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 6.',
      },
      bold: {
        width: 1000,
        height: 1000,
        aspect: '1:1',
        note: 'Bold default ProductCard IS square (aspect-square). 1000×1000 provides crispness for brutalist high-contrast imagery. Stays within ≤1000 wide mobile cap. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 6.',
      },
    },
  },
  productMobile: {
    width: 600,
    height: 600,
    aspect: '1:1',
    formats: ['JPEG', 'WebP'],
    description:
      "Product photo — mobile-tuned 1:1 (600×600). Smaller file than productSquare's 800×800. Pair with cardAspect = square. No baked-in text or sale badges.",
    // Per-theme overrides for mobile product crops:
    // modern/classic: explicit 3:4 mobile crop at 400×533 (2× the 200px rendered card width).
    // elegant: compact mobile stays at 600×800 (zFloos spec) — desktop luxury-tier
    //   but mobile must stay compact per LCP + Kuwait mobile traffic.
    // bold: square mobile crop 600×600 matches bold's square ProductCard aspect.
    // minimal: inherits base (compact throughout, ascetic identity).
    // Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 7.
    templateOverrides: {
      modern: {
        width: 400,
        height: 533,
        aspect: '3:4',
        note: '2× the ~200px rendered card width on mobile. Saves bandwidth vs serving 800×1067 desktop source to mobile. ≤1000 wide. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 7.',
      },
      elegant: {
        width: 600,
        height: 800,
        aspect: '3:4',
        note: 'Desktop is luxury-spec (800×1067) but mobile stays at compact baseline per LCP constraint + Kuwait mobile traffic. 04-25 audit §P0 #1. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 7.',
      },
      classic: {
        width: 400,
        height: 533,
        aspect: '3:4',
        note: 'Same compact mobile logic as modern. Desktop gets moderate bump; mobile stays tight. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 7.',
      },
      bold: {
        width: 600,
        height: 600,
        aspect: '1:1',
        note: 'Bold square aspect on mobile: 600×600 = 2× the ~300px rendered card width (2-col grid). ≤1000 wide. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 7.',
      },
      // minimal inherits base (600×600) — compact throughout.
    },
  },
  categorySquare: {
    width: 800,
    height: 800,
    aspect: '1:1',
    formats: ['JPEG', 'WebP', 'PNG'],
    description: 'Category card image — default 1:1 square.',
    // Per-theme overrides for square category cards:
    // modern: 1000×1000 — glass-blur rounded-2xl frame rewards retina crispness.
    // elegant: 600×800 (3:4 portrait) — CategoryCard defaults to aspect-square sm:aspect-[2/3]
    //   so a portrait source serves both mobile square and desktop tall-portrait without waste.
    //   Lookbook proportions per identity-audit.
    // minimal: 600×600 — compact + chrome-free (bg-transparent). No shadow to amplify source.
    // bold: 1200×1200 — full-bleed primary page with brutalist border-2 + offset shadow amplifies
    //   source crispness. Shopify 1500×800 heavier than needed for card surface; 1200 is cap.
    // classic: inherits base (800×800) — adequate for heritage retail at rendered card size.
    // Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 8.
    templateOverrides: {
      modern: {
        width: 1000,
        height: 1000,
        aspect: '1:1',
        note: 'Glass-blur aesthetic + rounded-2xl frame + duration-700 shadow transition rewards crisp source at 1000px. pack-styles.ts line 63: categoryFrame: rounded-2xl. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 8.',
      },
      elegant: {
        width: 600,
        height: 800,
        aspect: '3:4',
        note: 'Elegant CategoryCard: aspect-square sm:aspect-[2/3] (tall portrait on desktop). 600×800 serves both mobile square (crop from top) and desktop portrait without crop waste. Lookbook proportions. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 8.',
      },
      minimal: {
        width: 600,
        height: 600,
        aspect: '1:1',
        note: 'Compact spec + chrome-free identity (bg-transparent, no shadow). pack-styles.ts line 128: categoryFrame: bg-transparent. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 8.',
      },
      bold: {
        width: 1200,
        height: 1200,
        aspect: '1:1',
        note: 'Bold CategoryCard: rounded-3xl border-2 border-foreground + offset shadow-[0_18px_44px...]. Brutalist chrome amplifies source crispness. 1200 is right cap (Shopify 1500×800 is heavier than needed). Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 8.',
      },
      // classic inherits base (800×800).
    },
  },
  categoryPortrait: {
    width: 600,
    height: 800,
    aspect: '3:4',
    formats: ['JPEG', 'WebP'],
    description: 'Category card image — portrait alt (when admin cardShape = portrait).',
    // Per-theme overrides for portrait category mode:
    // modern/classic: moderate +33% bump consistent with productPrimary policy.
    // bold: 1000×1333 — stays ≤1000 wide for mobile safety while matching bold's
    //   brutalist crispness need. rounded-3xl border-2 + offset shadow amplifies source.
    // elegant: inherits base — elegant's natural category is already portrait (600×800);
    //   no separate portrait mode bump needed since categorySquare override already recs 600×800.
    // minimal: inherits base (compact throughout).
    // Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 9.
    templateOverrides: {
      modern: {
        width: 800,
        height: 1067,
        aspect: '3:4',
        note: 'Consistent with productPrimary bump: if a modern merchant opts for portrait categories, same retina step applies. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 9.',
      },
      classic: {
        width: 800,
        height: 1067,
        aspect: '3:4',
        note: 'Same moderate step as modern, consistent within classic moderate-bump policy. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 9.',
      },
      bold: {
        width: 1000,
        height: 1333,
        aspect: '3:4',
        note: 'Portrait category tiles with rounded-3xl border-2 + offset shadow benefit from crispness step. Stays ≤1000 wide for mobile safety. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 9.',
      },
      // elegant inherits base (600×800) — portrait IS elegant's natural aspect.
      // minimal inherits base (compact throughout).
    },
  },
  categoryMobile: {
    width: 630,
    height: 630,
    aspect: '1:1',
    formats: ['JPEG', 'WebP', 'PNG'],
    description:
      "Category card image — mobile-tuned 1:1 (630×630). Smaller file than categorySquare's 800×800 desktop ref. Use when merchant only ships one image and storefront is mobile-first.",
    // Per-theme overrides for mobile category crops (Sprint 6, 2026-05-18):
    // modern: 500×500 — ~2.5× the ~200px rendered card on phones.
    // elegant: 400×533 (3:4) — serves mobile square (center-crop) and portrait desktop.
    // classic: 500×667 (3:4) — compact step matching classic's moderate policy.
    // minimal: 400×400 — compact + ascetic, no more than needed.
    // bold: 600×600 — matches bold's productMobile for a consistent merchant brief.
    // Ahmad sign-off (2026-05-18): categoryMobile is a real key (added Sprint 1 commit cd0e6f4);
    //   modern/bold bump per audit; classic/elegant/minimal inherit or get explicit conservative recs.
    // Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 10.
    templateOverrides: {
      modern: {
        width: 500,
        height: 500,
        aspect: '1:1',
        note: 'Mobile category renders square (aspect-square on phones). 500px = ~2.5× the ~200px rendered card width on mobile. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 10.',
      },
      elegant: {
        width: 400,
        height: 533,
        aspect: '3:4',
        note: 'Elegant mobile uses square aspect (aspect-square on phones). 400×533 serves: center-crop to 400×400 for mobile square + full frame for portrait. Conservative mobile cap. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 10.',
      },
      classic: {
        width: 500,
        height: 667,
        aspect: '3:4',
        note: 'Compact step matching classic moderate policy. ≤1000 wide. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 10.',
      },
      minimal: {
        width: 400,
        height: 400,
        aspect: '1:1',
        note: 'Compact + ascetic. No more than needed. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 10.',
      },
      bold: {
        width: 600,
        height: 600,
        aspect: '1:1',
        note: 'Bold mobile categories render square. 600×600 matches bold productMobile crop for a consistent merchant brief. ≤1000 wide. Ref: 2026-05-18-per-theme-image-spec-audit.md §Surface 10.',
      },
    },
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

/**
 * Like `recommendedSizeText`, but resolves a per-template override
 * when one exists. Falls back to the base width/height otherwise.
 *
 * Examples:
 *   recommendedSizeTextForTemplate('heroDesktop', 'modern')
 *     → "Recommended: 2048 × 750 px (JPEG / WebP) — modern theme"
 *   recommendedSizeTextForTemplate('heroDesktop', 'elegant')
 *     → "Recommended: 1920 × 700 px (JPEG / WebP)"  (base — elegant hero locked)
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
 *   recommendedSizeTextForTemplateI18n('productPrimary', 'bold', 'ar')
 *     → "الحجم الموصى به: 800 × 800 بكسل (JPEG / WebP) — قالب bold"
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
