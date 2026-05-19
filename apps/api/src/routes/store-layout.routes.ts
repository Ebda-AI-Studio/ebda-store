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
import { resolveLayoutSettings } from '@force/shared';
import { authenticate } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { cleanupRemovedJsonUrls } from '../services/r2-cleanup.service';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

// Permissive Zod schema — `resolveLayoutSettings` is the source of truth for
// merging with defaults. Validating the parts that absolutely must be right
// (numeric ranges, enum values) and letting unknown extras through keeps
// the column forward-compatible.
const heroSlideSchema = z.object({
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
  ctaHref: z.string().optional(),
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

const layoutSchema = z
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
      cardAspect: z.enum(['theme', 'square', 'portrait', 'landscape']).optional(),
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
      cardAspect: z.enum(['theme', 'square', 'portrait', 'landscape']).optional(),
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
    }),
    bestSellers: z.object({
      enabled: z.boolean(),
      limit: z.number().int().min(1).max(48),
      title: z.string().optional(),
      titleAr: z.string().optional(),
      cardSize: z.enum(['xxs', 'xs', 'sm', 'md', 'lg', 'xl']).optional(),
      cardAspect: z.enum(['theme', 'square', 'portrait', 'landscape']).optional(),
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
    }),
    filterSidebar: z.object({
      enabled: z.boolean(),
      defaultOpen: z.boolean(),
    }),
    testimonials: z.object({
      enabled: z.boolean(),
      minRating: z.number().min(1).max(5),
      verifiedOnly: z.boolean(),
      // 2026-05-18 Sprint 3: per-section bg color.
      bgColor: colorValue,
      // Per-section typography overrides. Must be listed or Zod silently strips.
      typography: sectionTypographyOverride,
    }),
    // sibling UGC section, added 2026-05-16. without listing here Zod
    // would silently strip it on every save — same bug class as imageMobile
    // above.
    reviewSection: z
      .object({
        enabled: z.boolean(),
      })
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
        cardAspect: z.enum(['theme', 'square', 'portrait', 'landscape']).optional(),
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
      })
      .partial()
      .optional(),
  })
  // Allow partial bodies so the admin UI can patch a single section without
  // re-sending every field. We re-merge with the existing JSON before save.
  .partial();

/**
 * GET /admin/stores/:storeId/layout
 * Returns the resolved (= defaults-merged) layout settings.
 */
router.get(
  '/',
  authenticate,
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { layoutSettings: true },
      });
      const layout = resolveLayoutSettings(store?.layoutSettings ?? {});
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
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const patch = layoutSchema.parse(req.body);

      const current = await prisma.store.findUnique({
        where: { id: storeId },
        select: { layoutSettings: true },
      });
      const previousLayout = current?.layoutSettings ?? {};
      const merged = resolveLayoutSettings({
        ...resolveLayoutSettings(previousLayout),
        ...patch,
      });

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

      res.json({ success: true, data: { layout: merged } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
