/**
 * Store layout settings — admin GET/PUT for the layout-toggle page +
 * a public read used by the storefront when rendering the home composition.
 *
 * The shape is `StoreLayoutSettings` from @force/shared; an empty `{}` blob
 * resolves to packaged Pecannbee-flow defaults via `resolveLayoutSettings`,
 * so existing tenants don't need a backfill before this ships.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { resolveLayoutSettings, isSafeUrl } from '@force/shared';
import type { TemplateId } from '@force/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { cleanupRemovedJsonUrls } from '../services/r2-cleanup.service';
import { redis } from '../services/redis.service';
import { invalidateCached } from '../lib/public-cache';
import logger from '../lib/logger';
import { randomBytes } from 'node:crypto';

const router = Router({ mergeParams: true });

// Permissive Zod schema — `resolveLayoutSettings` is the source of truth for
// merging with defaults. Validating the parts that absolutely must be right
// (numeric ranges, enum values) and letting unknown extras through keeps
// the column forward-compatible.
// Exported (not just used internally) so `tests/unit/hero-slide-schema.test.ts`
// can assert the `link` / `ctaHref` scheme-allowlist behavior directly,
// mirroring how `layoutSchema` is exported below for its parity test.
export const heroSlideSchema = z.object({
  image: z.string().url().or(z.string().min(1)),
  imageAr: z.string().optional(),
  // Mobile-specific images — without these listed in the Zod schema, the
  // parse step silently strips them and saves succeed with the field
  // gone. Bug found 2026-05-16 when merchants reported uploading mobile
  // images that disappeared on refresh.
  imageMobile: z.string().optional(),
  imageMobileAr: z.string().optional(),
  alt: z.string().optional(),
  headline: z.string().optional(),
  headlineAr: z.string().optional(),
  ctaText: z.string().optional(),
  ctaTextAr: z.string().optional(),
  // Rendered into an `<a href>` on the storefront hero — enforce the safe-URL
  // scheme allowlist so a `javascript:`/`data:` slide CTA can't be stored.
  // Empty string is allowed (no CTA); any non-empty value must be safe.
  ctaHref: z
    .string()
    .optional()
    .refine(v => v === undefined || v === '' || isSafeUrl(v), {
      message:
        'CTA link must be a relative path or use http(s)/mailto/tel — javascript: is not allowed',
    }),
  // Optional "banner link" (stretched-link pattern) — makes the whole slide
  // clickable. Same scheme allowlist as ctaHref. MUST be listed here or the
  // parse step silently strips it (the same mobile-image silent-strip trap
  // documented above for imageMobile/imageMobileAr).
  link: z
    .string()
    .optional()
    .refine(v => v === undefined || v === '' || isSafeUrl(v), {
      message:
        'Banner link must be a relative path or use http(s)/mailto/tel — javascript: is not allowed',
    }),
});

// Color value: hex (#RGB, #RRGGBB, #RRGGBBAA) OR brand token (token:<name>) OR empty.
// Empty string = unset, falls back to theme background preset.
const colorValue = z
  .string()
  .regex(
    /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|token:(primary|secondary|accent|card|muted|foreground|border)|)$/,
    'Must be a hex color or token:<brand-color>'
  )
  .optional();

// Per-zone typography override — mirrors ZoneOverride in @force/shared.
// color reuses colorValue (hex or token:<name>).
const zoneOverride = z
  .object({
    fontFamily: z.string().max(120).optional(),
    fontSize: z.string().max(40).optional(),
    fontWeight: z.string().max(10).optional(),
    color: colorValue,
    letterSpacing: z.string().max(20).optional(),
    lineHeight: z.string().max(20).optional(),
    textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional(),
    textDecoration: z.enum(['none', 'underline', 'overline', 'line-through']).optional(),
    textAlign: z.enum(['start', 'center', 'end']).optional(),
  })
  .partial()
  .optional();

// Per-section typography override — heading / kicker / subtitle / body / seeAll /
// productName / productPrice / productCta / categoryLabel.
// Extended 2026-05-19 (Wave 3A) to include product-card and category-card roles so
// per-section blocks can host all section-specific zones. Keep in sync with
// SectionTypographyOverride in packages/shared/src/types/store-layout.ts.
const sectionTypographyOverride = z
  .object({
    heading: zoneOverride,
    kicker: zoneOverride,
    subtitle: zoneOverride,
    body: zoneOverride,
    seeAll: zoneOverride,
    productName: zoneOverride,
    productPrice: zoneOverride,
    productCta: zoneOverride,
    categoryLabel: zoneOverride,
  })
  .partial()
  .optional();

// DividerSettings — mirrors packages/shared/src/types/store-theme.ts.
// Per-section divider overrides. Each slot is independently optional.
// Keep in sync with SectionDividers in store-layout.ts.
const dividerSettings = z
  .object({
    enabled: z.boolean(),
    style: z.enum(['solid', 'dashed', 'dotted', 'double']),
    thickness: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    width: z.enum(['full', 'contained', 'short']),
    color: z.enum(['auto', 'foreground', 'accent', 'custom']),
    customColor: z.string().max(20).optional(),
    spacing: z.enum(['tight', 'normal', 'loose']),
  })
  .partial()
  .optional();

const sectionDividers = z
  .object({
    above: dividerSettings,
    kicker: dividerSettings,
    title: dividerSettings,
    subtitle: dividerSettings,
    belowHeading: dividerSettings,
  })
  .partial()
  .optional();

// Per-section layout knobs (padding / max-width / visibility breakpoint) —
// item #6 of the page-builder gap fill. Mixed into every section schema below.
const sectionPaddingMaxWidthVisibility = {
  paddingTop: z.enum(['none', 'tight', 'normal', 'loose', 'xloose']).optional(),
  paddingBottom: z.enum(['none', 'tight', 'normal', 'loose', 'xloose']).optional(),
  maxWidth: z.enum(['contained', 'full']).optional(),
  hideOnMobile: z.boolean().optional(),
  hideOnDesktop: z.boolean().optional(),
} as const;

const layoutSchemaInternal = z
  .object({
    hero: z.object({
      enabled: z.boolean(),
      mode: z.enum(['single', 'slider']),
      autoplayMs: z.number().int().min(1000).max(30000),
      slides: z.array(heroSlideSchema).max(10),
      // 2026-05-18: framed vs full-bleed presentation. Without this listed
      // Zod silently strips the field on PUT — same trap as
      // feedback-fwb-zod-silent-strip-trap.md. Keep in sync with HeroSettings.
      presentation: z.enum(['full-bleed', 'framed']).optional(),
      // 2026-05-18 Sprint 3: per-section bg color. Must be listed or Zod
      // silently strips it on every PUT — same trap class as imageMobile.
      bgColor: colorValue,
      // Per-section typography overrides. Must be listed or Zod silently strips.
      typography: sectionTypographyOverride,
      // Per-section divider overrides — see sectionDividers + SectionDividers type.
      dividers: sectionDividers,
      // Per-section layout (padding / max-width / visibility) — item #6.
      ...sectionPaddingMaxWidthVisibility,
    }),
    categories: z.object({
      enabled: z.boolean(),
      layout: z.enum(['grid', 'horizontal']),
      // 2026-05-16: split into per-breakpoint settings (see store-layout.ts
      // CategoriesSettings). Mobile overrides are optional — fall back to
      // the legacy single field when unset.
      layoutMobile: z.enum(['grid', 'horizontal']).optional(),
      captionPosition: z.enum(['below', 'overlay']),
      captionPositionMobile: z.enum(['below', 'overlay']).optional(),
      desktopColumns: z.union([z.literal(2), z.literal(3), z.literal(4)]),
      // bumped from 1|2 to 1|2|3 — three-column mobile layout option for
      // compact grids on stores with many categories.
      mobileColumns: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      // SectionTitleOverride fields — title was already passing through
      // because the outer schema uses `.passthrough()`, but listing them
      // here documents the contract + lets Zod validate types. kicker +
      // subtitle added 2026-05-16 (Ahmad: editable label + tagline).
      title: z.string().optional(),
      titleAr: z.string().optional(),
      kicker: z.string().optional(),
      kickerAr: z.string().optional(),
      subtitle: z.string().optional(),
      subtitleAr: z.string().optional(),
      // 2026-05-16: per-store card size / aspect / visual toggles.
      cardSize: z.enum(['xxs', 'xs', 'sm', 'md', 'lg', 'xl']).optional(),
      // 2026-06-09: added wide + ultrawide — UI exposes these but the enum
      // only listed 4 values, causing a ZodError (400) on save whenever a
      // merchant picked either option. Fix: keep in sync with page-builder UI.
      cardAspect: z
        .enum(['theme', 'square', 'portrait', 'landscape', 'wide', 'ultrawide'])
        .optional(),
      // 2026-05-16 batch 2: cardGap (spacing between cards) + cardShape
      // (named preset that bundles aspect + radius). Must be listed here
      // or Zod silently strips on PUT — exact same trap that bit
      // reviewSection earlier this same day. Keep in sync with
      // CategoriesSettings in packages/shared/src/types/store-layout.ts.
      cardGap: z.enum(['tight', 'normal', 'loose', 'xloose']).optional(),
      cardShape: z
        .enum([
          'theme',
          'circle',
          'rounded-square',
          'square',
          'soft',
          'portrait',
          'landscape',
          'pill',
        ])
        .optional(),
      showLabel: z.boolean().optional(),
      showHover: z.boolean().optional(),
      // 2026-05-17 night + 2026-05-18: per-section heading-line toggles +
      // opt-in card frame wrapper. All three silently stripped by Zod
      // before this fix because they weren't listed — bug Ahmad spotted
      // 2026-05-18 ("toggled them on and I don't see anything").
      showKickerLines: z.boolean().optional(),
      showSubtitleLines: z.boolean().optional(),
      showCardFrame: z.boolean().optional(),
      cardFrameStyle: z.enum(['soft', 'outline', 'shadow', 'paper']).optional(),
      cardFrameWidth: z.enum(['thin', 'normal', 'thick', 'xthick']).optional(),
      // 2026-05-19: frame box padding — independent of border thickness.
      cardFrameSize: z.enum(['compact', 'normal', 'comfortable', 'spacious']).optional(),
      // 2026-05-18 Sprint 4: per-section card frame color override.
      cardFrameColor: colorValue,
      // 2026-05-18 Sprint 3: per-section bg color.
      bgColor: colorValue,
      // Per-section typography overrides. Must be listed or Zod silently strips.
      typography: sectionTypographyOverride,
      // Per-section divider overrides — see sectionDividers + SectionDividers type.
      dividers: sectionDividers,
      // Per-section layout (padding / max-width / visibility) — item #6.
      ...sectionPaddingMaxWidthVisibility,
    }),
    // Product carousels — newArrivals + bestSellers. 2026-05-16: extended
    // to mirror the categories block so merchants can tune product card
    // size / aspect / named shape / spacing / labels / hover the same
    // way they tune category cards. Without listing the new fields here
    // Zod silently strips them on save (the trap documented in
    // feedback-fwb-zod-silent-strip-trap.md).
    newArrivals: z.object({
      enabled: z.boolean(),
      limit: z.number().int().min(1).max(48),
      title: z.string().optional(),
      titleAr: z.string().optional(),
      cardSize: z.enum(['xxs', 'xs', 'sm', 'md', 'lg', 'xl']).optional(),
      cardAspect: z
        .enum(['theme', 'square', 'portrait', 'landscape', 'wide', 'ultrawide'])
        .optional(),
      cardShape: z
        .enum([
          'theme',
          'circle',
          'rounded-square',
          'square',
          'soft',
          'portrait',
          'landscape',
          'pill',
        ])
        .optional(),
      cardGap: z.enum(['tight', 'normal', 'loose', 'xloose']).optional(),
      showLabel: z.boolean().optional(),
      showHover: z.boolean().optional(),
      // 2026-05-17 night + 2026-05-18 — see categories above for trap notes.
      kicker: z.string().optional(),
      kickerAr: z.string().optional(),
      subtitle: z.string().optional(),
      subtitleAr: z.string().optional(),
      showKickerLines: z.boolean().optional(),
      showSubtitleLines: z.boolean().optional(),
      showCardFrame: z.boolean().optional(),
      cardFrameStyle: z.enum(['soft', 'outline', 'shadow', 'paper']).optional(),
      cardFrameWidth: z.enum(['thin', 'normal', 'thick', 'xthick']).optional(),
      // 2026-05-19: frame box padding — independent of border thickness.
      cardFrameSize: z.enum(['compact', 'normal', 'comfortable', 'spacious']).optional(),
      // 2026-05-18 Sprint 4: per-section card frame color override.
      cardFrameColor: colorValue,
      // 2026-05-18 Sprint 3: per-section bg color.
      bgColor: colorValue,
      // Per-section typography overrides. Must be listed or Zod silently strips.
      typography: sectionTypographyOverride,
      // Per-section divider overrides — see sectionDividers + SectionDividers type.
      dividers: sectionDividers,
      // Per-section layout (padding / max-width / visibility) — item #6.
      ...sectionPaddingMaxWidthVisibility,
    }),
    bestSellers: z.object({
      enabled: z.boolean(),
      limit: z.number().int().min(1).max(48),
      title: z.string().optional(),
      titleAr: z.string().optional(),
      cardSize: z.enum(['xxs', 'xs', 'sm', 'md', 'lg', 'xl']).optional(),
      cardAspect: z
        .enum(['theme', 'square', 'portrait', 'landscape', 'wide', 'ultrawide'])
        .optional(),
      cardShape: z
        .enum([
          'theme',
          'circle',
          'rounded-square',
          'square',
          'soft',
          'portrait',
          'landscape',
          'pill',
        ])
        .optional(),
      cardGap: z.enum(['tight', 'normal', 'loose', 'xloose']).optional(),
      showLabel: z.boolean().optional(),
      showHover: z.boolean().optional(),
      // 2026-05-17 night + 2026-05-18 — see categories above for trap notes.
      kicker: z.string().optional(),
      kickerAr: z.string().optional(),
      subtitle: z.string().optional(),
      subtitleAr: z.string().optional(),
      showKickerLines: z.boolean().optional(),
      showSubtitleLines: z.boolean().optional(),
      showCardFrame: z.boolean().optional(),
      cardFrameStyle: z.enum(['soft', 'outline', 'shadow', 'paper']).optional(),
      cardFrameWidth: z.enum(['thin', 'normal', 'thick', 'xthick']).optional(),
      // 2026-05-19: frame box padding — independent of border thickness.
      cardFrameSize: z.enum(['compact', 'normal', 'comfortable', 'spacious']).optional(),
      // 2026-05-18 Sprint 4: per-section card frame color override.
      cardFrameColor: colorValue,
      // 2026-05-18 Sprint 3: per-section bg color.
      bgColor: colorValue,
      // Per-section typography overrides. Must be listed or Zod silently strips.
      typography: sectionTypographyOverride,
      // Per-section divider overrides — see sectionDividers + SectionDividers type.
      dividers: sectionDividers,
      // Per-section layout (padding / max-width / visibility) — item #6.
      ...sectionPaddingMaxWidthVisibility,
    }),
    filterSidebar: z.object({
      enabled: z.boolean(),
      defaultOpen: z.boolean(),
    }),
    testimonials: z.object({
      enabled: z.boolean(),
      minRating: z.number().min(1).max(5),
      verifiedOnly: z.boolean(),
      // SectionTitleOverride fields — must be listed or Zod silently strips
      // them on PUT (same trap class as imageMobile 2026-05-16).
      title: z.string().optional(),
      titleAr: z.string().optional(),
      // 2026-05-18 Sprint 3: per-section bg color.
      bgColor: colorValue,
      // Per-section typography overrides. Must be listed or Zod silently strips.
      typography: sectionTypographyOverride,
      // Per-section divider overrides — see sectionDividers + SectionDividers type.
      dividers: sectionDividers,
      // Per-section layout (padding / max-width / visibility) — item #6.
      ...sectionPaddingMaxWidthVisibility,
    }),
    // sibling UGC section, added 2026-05-16. without listing here Zod
    // would silently strip it on every save — same bug class as imageMobile
    // above.
    reviewSection: z
      .object({
        enabled: z.boolean(),
      })
      .optional(),
    // Brand story / trust strip / blog carousel — folded into page-builder
    // 2026-05-20 from scattered ThemeTab toggles. Each shares the same
    // section-shaped schema (enabled, bgColor, typography, dividers).
    brandStory: z
      .object({
        enabled: z.boolean().optional(),
        bgColor: colorValue,
        typography: sectionTypographyOverride,
        dividers: sectionDividers,
        ...sectionPaddingMaxWidthVisibility,
      })
      .partial()
      .optional(),
    trustStrip: z
      .object({
        enabled: z.boolean().optional(),
        layout: z.enum(['horizontal', 'vertical']).optional(),
        // `size`, `iconColor`, `iconBgColor` were missing here. This schema has
        // no .passthrough(), so the parse step silently stripped them on every
        // PUT — the icon-color controls never persisted (saved layout had the
        // fields gone, so storefront + post-save preview showed nothing).
        size: z.enum(['sm', 'md', 'lg']).optional(),
        bgColor: colorValue,
        iconColor: colorValue,
        iconBgColor: colorValue,
        textColor: colorValue,
        typography: sectionTypographyOverride,
        dividers: sectionDividers,
        ...sectionPaddingMaxWidthVisibility,
      })
      .partial()
      .optional(),
    blogCarousel: z
      .object({
        enabled: z.boolean().optional(),
        limit: z.number().int().min(1).max(20).optional(),
        bgColor: colorValue,
        typography: sectionTypographyOverride,
        dividers: sectionDividers,
        ...sectionPaddingMaxWidthVisibility,
      })
      .partial()
      .optional(),
    // Announcement bar / Header / Footer — folded into page-builder 2026-05-20.
    announcement: z
      .object({
        enabled: z.boolean().optional(),
        bgColor: colorValue,
        typography: sectionTypographyOverride,
        dividers: sectionDividers,
        ...sectionPaddingMaxWidthVisibility,
      })
      .partial()
      .optional(),
    header: z
      .object({
        enabled: z.boolean().optional(),
        sticky: z.boolean().optional(),
        bgColor: colorValue,
        typography: sectionTypographyOverride,
        dividers: sectionDividers,
        ...sectionPaddingMaxWidthVisibility,
      })
      .partial()
      .optional(),
    footer: z
      .object({
        enabled: z.boolean().optional(),
        bgColor: colorValue,
        typography: sectionTypographyOverride,
        dividers: sectionDividers,
        ...sectionPaddingMaxWidthVisibility,
      })
      .partial()
      .optional(),
    // Extra duplicated product carousels (section duplication 2026-05-20).
    // Each entry has a unique id + productSource + the full ProductCarousel
    // shape via z.passthrough() (forward-compat with new fields without zod churn).
    extraCarousels: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            productSource: z.enum(['newest', 'best_seller', 'featured', 'category', 'manual']),
            categorySlug: z.string().max(120).optional(),
            categoryFetchLimit: z.number().int().min(1).max(200).optional(),
            manualProductIds: z.array(z.string().max(80)).max(50).optional(),
            enabled: z.boolean().optional(),
            limit: z.number().int().min(1).max(50).optional(),
            title: z.string().optional(),
            titleAr: z.string().optional(),
            kicker: z.string().optional(),
            kickerAr: z.string().optional(),
            subtitle: z.string().optional(),
            subtitleAr: z.string().optional(),
            showKickerLines: z.boolean().optional(),
            showSubtitleLines: z.boolean().optional(),
            bgColor: colorValue,
            cardSize: z.enum(['xxs', 'xs', 'sm', 'md', 'lg', 'xl']).optional(),
            cardAspect: z
              .enum(['theme', 'square', 'portrait', 'landscape', 'wide', 'ultrawide'])
              .optional(),
            cardShape: z
              .enum([
                'theme',
                'circle',
                'rounded-square',
                'square',
                'soft',
                'portrait',
                'landscape',
                'pill',
              ])
              .optional(),
            cardGap: z.enum(['tight', 'normal', 'loose', 'xloose']).optional(),
            showLabel: z.boolean().optional(),
            showHover: z.boolean().optional(),
            showCardFrame: z.boolean().optional(),
            cardFrameStyle: z.enum(['soft', 'outline', 'shadow', 'paper']).optional(),
            cardFrameWidth: z.enum(['thin', 'normal', 'thick', 'xthick']).optional(),
            cardFrameSize: z.enum(['compact', 'normal', 'comfortable', 'spacious']).optional(),
            cardFrameColor: z.string().optional(),
            typography: sectionTypographyOverride,
            dividers: sectionDividers,
            ...sectionPaddingMaxWidthVisibility,
          })
          .passthrough()
      )
      .max(8)
      .optional(),
    // Drag-to-reorder data model (page-builder 2026-05-20, ui in v2).
    sectionOrder: z
      .array(
        z.enum([
          'hero',
          'categories',
          'newArrivals',
          'bestSellers',
          'brandStory',
          'blogCarousel',
          'trustStrip',
          'testimonials',
        ])
      )
      .optional(),
    sizing: z.object({
      heroAspect: z.enum(['2.45:1', '16:9', '4:3']),
      productImageAspect: z.enum(['1:1', '3:4']),
      categoryImageAspect: z.enum(['1:1', '3:4', '2:3']),
    }),
    // 2026-05-18 Sprint 4: global product-card defaults for PLP / category /
    // search surfaces. Merchants set these once; every non-homepage card
    // surface inherits them automatically. Homepage carousels read their own
    // per-section fields first and fall back here.
    productCardDefaults: z
      .object({
        cardSize: z.enum(['xxs', 'xs', 'sm', 'md', 'lg', 'xl']).optional(),
        cardAspect: z
          .enum(['theme', 'square', 'portrait', 'landscape', 'wide', 'ultrawide'])
          .optional(),
        cardShape: z
          .enum([
            'theme',
            'circle',
            'rounded-square',
            'square',
            'soft',
            'portrait',
            'landscape',
            'pill',
          ])
          .optional(),
        cardGap: z.enum(['tight', 'normal', 'loose', 'xloose']).optional(),
        showLabel: z.boolean().optional(),
        showHover: z.boolean().optional(),
        showCardFrame: z.boolean().optional(),
        cardFrameStyle: z.enum(['soft', 'outline', 'shadow', 'paper']).optional(),
        cardFrameWidth: z.enum(['thin', 'normal', 'thick', 'xthick']).optional(),
        // 2026-05-19: frame box padding — independent of border thickness.
        cardFrameSize: z.enum(['compact', 'normal', 'comfortable', 'spacious']).optional(),
        cardFrameColor: colorValue,
        // 2026-05-19 Wave 3A: per-section typography overrides for catalog-wide
        // product card defaults (productName / productPrice / productCta).
        // Must be listed or Zod silently strips — same trap as per-section blocks.
        typography: sectionTypographyOverride,
        // 2026-06-24: image aspect+radius + name/price visibility. Without these,
        // Zod silently strips them on every PUT (the top-level object has no
        // .passthrough()), so the admin reloaded stale defaults even though the
        // storefront read whatever was last persisted. Keep in sync with
        // ProductCardDefaults in packages/shared/src/types/store-layout.ts.
        cardImageAspect: z.enum(['1:1', '4:5', '3:4', '16:9', 'auto']).optional(),
        cardImageRadius: z.enum(['none', 'sm', 'md', 'lg', 'full']).optional(),
        showCardName: z.boolean().optional(),
        showCardPrice: z.boolean().optional(),
        // 2026-06-24: CTA + OOS-label + name-case controls (Task 4).
        // Must be listed or Zod silently strips on every PUT (no .passthrough()).
        // Keep in sync with ProductCardDefaults in packages/shared/src/types/store-layout.ts.
        ctaLabel: z.boolean().optional(),
        ctaLabelTextEn: z.string().optional(),
        ctaLabelTextAr: z.string().optional(),
        ctaSize: z.enum(['sm', 'md', 'lg']).optional(),
        ctaShape: z.enum(['rounded', 'pill', 'square', 'soft']).optional(),
        ctaColor: colorValue,
        ctaTextColor: colorValue,
        oosLabel: z.boolean().optional(),
        oosLabelTextEn: z.string().optional(),
        oosLabelTextAr: z.string().optional(),
        oosLabelShape: z.enum(['rounded', 'pill', 'square', 'soft']).optional(),
        oosLabelPlacement: z
          .enum(['top-start', 'top-end', 'bottom-start', 'bottom-end'])
          .optional(),
        oosLabelColor: colorValue,
        oosLabelTextColor: colorValue,
        oosDimColor: colorValue,
        productNameCase: z.enum(['normal', 'uppercase']).optional(),
        // 2026-06-24: CTA mode — view-only vs auto (view+add-to-cart). Must be
        // listed or Zod silently strips it on every PUT (no .passthrough()).
        // Keep in sync with ProductCardDefaults in packages/shared/src/types/store-layout.ts.
        ctaMode: z.enum(['auto', 'viewOnly']).optional(),
        // 2026-07: discount/sale badge corner + color. Must be listed or Zod
        // silently strips it on every PUT (no .passthrough()). Keep in sync
        // with ProductCardDefaults in packages/shared/src/types/store-layout.ts.
        discountBadge: z
          .object({
            position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
            color: colorValue,
          })
          .partial()
          .optional(),
        // 2026-09: custom (merchant-authored) product badge corner + color —
        // the styling sibling of discountBadge for Product.badgeLabel. Must be
        // listed or Zod silently strips it on every PUT (no .passthrough()).
        // Keep in sync with ProductCardDefaults in
        // packages/shared/src/types/store-layout.ts.
        customBadge: z
          .object({
            position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional(),
            color: colorValue,
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
    // Products listing/detail page settings. Must be listed here or the
    // top-level object (no .passthrough()) silently strips it on every PUT —
    // the "bg colour saved but not showing" bug. Keep in sync with
    // ProductsPageSettings in packages/shared.
    productsPage: z
      .object({
        bgColor: colorValue,
        colorScheme: z.enum(['auto', 'light', 'dark']).optional(),
        density: z.enum(['compact', 'normal', 'spacious']).optional(),
        textScale: z.enum(['sm', 'normal', 'lg', 'xl']).optional(),
        typography: sectionTypographyOverride,
        // deprecated — kept for back-compat reads; admin now writes to productDetailPage.
        pdpImageAspect: z
          .enum(['square', 'portrait', 'landscape', 'wide', 'ultrawide', 'auto'])
          .optional(),
      })
      .partial()
      .optional(),
    // Per-page background + typography. Each must be listed or the top-level
    // object (no .passthrough()) strips it on PUT. Keep in sync with the
    // *PageSettings interfaces in packages/shared.
    productDetailPage: z
      .object({
        bgColor: colorValue,
        colorScheme: z.enum(['auto', 'light', 'dark']).optional(),
        density: z.enum(['compact', 'normal', 'spacious']).optional(),
        textScale: z.enum(['sm', 'normal', 'lg', 'xl']).optional(),
        imageAspect: z
          .enum(['square', 'portrait', 'landscape', 'wide', 'ultrawide', 'auto'])
          .optional(),
        typography: sectionTypographyOverride,
      })
      .partial()
      .optional(),
    categoriesPage: z
      .object({
        bgColor: colorValue,
        colorScheme: z.enum(['auto', 'light', 'dark']).optional(),
        density: z.enum(['compact', 'normal', 'spacious']).optional(),
        textScale: z.enum(['sm', 'normal', 'lg', 'xl']).optional(),
        typography: sectionTypographyOverride,
      })
      .partial()
      .optional(),
    // Standalone locations-page settings (background + typography). Same strip
    // trap as the other per-page keys — the top-level object has no
    // .passthrough(), so without this entry every PUT silently drops the
    // merchant's locations-page edits ("saved but never rendered"). Keep in
    // sync with LocationsPageSettings in packages/shared.
    locationsPage: z
      .object({
        bgColor: colorValue,
        colorScheme: z.enum(['auto', 'light', 'dark']).optional(),
        density: z.enum(['compact', 'normal', 'spacious']).optional(),
        textScale: z.enum(['sm', 'normal', 'lg', 'xl']).optional(),
        typography: sectionTypographyOverride,
      })
      .partial()
      .optional(),
    checkoutPage: z
      .object({
        bgColor: colorValue,
        colorScheme: z.enum(['auto', 'light', 'dark']).optional(),
        density: z.enum(['compact', 'normal', 'spacious']).optional(),
        textScale: z.enum(['sm', 'normal', 'lg', 'xl']).optional(),
        typography: sectionTypographyOverride,
      })
      .partial()
      .optional(),
    // Standalone cart-page settings (background + typography). Same strip trap
    // applies — list it explicitly. Keep in sync with CartPageSettings.
    cartPage: z
      .object({
        bgColor: colorValue,
        colorScheme: z.enum(['auto', 'light', 'dark']).optional(),
        density: z.enum(['compact', 'normal', 'spacious']).optional(),
        textScale: z.enum(['sm', 'normal', 'lg', 'xl']).optional(),
        typography: sectionTypographyOverride,
      })
      .partial()
      .optional(),
    // Mobile bottom tab-bar color overrides (page-builder 2026-06-17). Same
    // Mobile bottom tab-bar color overrides (page-builder 2026-06-17). Same
    // strip trap — the top-level object has no .passthrough(), so without this
    // entry every PUT silently dropped the merchant's bottom-bar colors and the
    // control looked like it "did nothing". Keep in sync with BottomBarSettings.
    bottomBar: z
      .object({
        bgColor: colorValue,
        activeColor: colorValue,
        inactiveColor: colorValue,
      })
      .partial()
      .optional(),
  })
  // Allow partial bodies so the admin UI can patch a single section without
  // re-sending every field. We re-merge with the existing JSON before save.
  .partial();

/**
 * Exported for the layout-schema-parity unit test.
 *
 * The test uses `.shape` to enumerate the schema's top-level accepted keys and
 * asserts they cover every key in `LAYOUT_TOP_LEVEL_KEYS` (the runtime mirror
 * of `StoreLayoutSettings`). This catches the silent-strip bug class at CI time
 * instead of after a merchant reports "my changes don't save".
 *
 * Cast to `z.ZodObject<Record<string, z.ZodTypeAny>>` to avoid TS7056
 * ("inferred type exceeds maximum length") — the inferred Zod type is too deep
 * for tsc to serialize on an export. The test only needs `.shape`.
 */
export const layoutSchema: z.ZodObject<Record<string, z.ZodTypeAny>> = layoutSchemaInternal;

/**
 * GET /admin/stores/:storeId/layout
 * Returns the resolved (= defaults-merged) layout settings.
 */
router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { layoutSettings: true, template: true },
      });
      const layout = resolveLayoutSettings(
        store?.layoutSettings ?? {},
        store?.template as TemplateId | undefined
      );
      res.json({ success: true, data: { layout } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /admin/stores/:storeId/layout
 * Patches the layout settings. The request body can contain any subset of
 * the section keys; missing sections keep their current values. The whole
 * shape is re-merged through `resolveLayoutSettings` before persisting so
 * the on-disk JSON is always a complete, valid `StoreLayoutSettings`.
 */
router.put(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const patch = layoutSchema.parse(req.body);

      const current = await prisma.store.findUnique({
        where: { id: storeId },
        select: { layoutSettings: true, template: true },
      });
      const previousLayout = current?.layoutSettings ?? {};
      const currentTemplate = current?.template as TemplateId | undefined;
      const merged = resolveLayoutSettings(
        {
          ...resolveLayoutSettings(previousLayout, currentTemplate),
          ...patch,
        },
        currentTemplate
      );

      await prisma.store.update({
        where: { id: storeId },
        data: { layoutSettings: merged as unknown as object },
      });

      // Diff every image URL nested inside the layout JSON (hero slides,
      // banner blocks, etc.) and queue cleanup for any that dropped out.
      // Replacing a hero slide image without this leaks the previous R2
      // object — verified 2026-05-17 with 4 stale hero/* keys.
      void cleanupRemovedJsonUrls(previousLayout, merged).catch(err =>
        logger.warn({ err, storeId }, '[store-layout.put] r2 cleanup failed')
      );

      await auditLog({
        action: 'store.layout.updated',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        details: { keys: Object.keys(patch).join(',') },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Bust the public store cache so the storefront picks up the new
      // layout on the next request rather than waiting out the
      // `Cache-Control: public, max-age=60, s-maxage=120` TTL.
      // Mirrors the same pattern used by StoreService.updateTheme and
      // updateBranding (2026-05-28 save-audit fix).
      void invalidateCached(`public:store:${storeId}`).catch(err =>
        logger.warn({ err, storeId }, '[store-layout.put] cache invalidation failed')
      );

      res.json({ success: true, data: { layout: merged } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /admin/stores/:storeId/layout/preview
 *
 * Real-time-preview endpoint added 2026-05-20 (Ahmad). Stores the merchant's
 * UNSAVED layout in Redis under a short-lived token (1h TTL) and returns the
 * token. The admin page-builder posts the in-memory layout here, then reloads
 * the storefront iframe with `?_layoutDraft=<token>` — storefront reads the
 * draft from Redis instead of DB. Merchant can iterate visually without
 * committing; the actual save still goes through PUT /layout above.
 *
 * Auth: same as PUT (store owner OR super_admin). Tokens are scoped to the
 * caller's store; storeId is verified before the Redis write.
 */
router.post(
  '/preview',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      // Body shape evolved 2026-05-20: accept either the bare layout (legacy
      // single-key shape) OR a `{ layout, typography?, theme? }` bundle. The
      // bundle form lets the page-builder preview global typography zone
      // changes (per-section colors / fonts / text-decoration) + theme
      // updates (primary/accent palette, showBrandBadge, etc.) — without it,
      // those merchant tweaks didn't show until Save committed them. The
      // storefront applies the draft through resolveLayoutSettings which
      // tolerates malformed input gracefully; stricter validation would slow
      // the iteration loop.
      const body = req.body;
      if (!body || typeof body !== 'object') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_BODY', message: 'Preview payload required' },
        });
        return;
      }
      // Heuristic: a bundle has at least one of layout/typography/theme keys.
      // A bare layout has the section keys directly (hero, categories, ...).
      // Detect bundle by presence of any of the 3 known top-level keys.
      const isBundle = 'layout' in body || 'typography' in body || 'theme' in body;
      const bundle = isBundle ? body : { layout: body, typography: undefined, theme: undefined };
      if (!bundle.layout || typeof bundle.layout !== 'object') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_BODY', message: 'Layout payload required' },
        });
        return;
      }
      // crypto.randomBytes, not Math.random: the read path
      // (public-store-layout.routes.ts) is unauthenticated, and the previous
      // Date.now()+Math.random() token carried roughly 41 bits — brute-forceable
      // within the 1h TTL. The Redis key is storeId-scoped so a guessed token
      // never crosses tenants, but it did expose that store's unsaved draft.
      const token = randomBytes(24).toString('base64url');
      // Redis key includes storeId so a cross-tenant token paste can't leak.
      await redis.set(`layout-preview:${storeId}:${token}`, bundle, 3600);
      res.json({ success: true, data: { token } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
