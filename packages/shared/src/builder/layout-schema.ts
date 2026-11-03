/**
 * Zod schema for `stores.layout_settings` (the legacy page-builder blob).
 *
 * Moved verbatim from `apps/api/src/routes/store-layout.routes.ts` (visual
 * builder Phase 1) so the section registry and the API PUT validate with ONE
 * schema: the registry's per-section `propsSchema` is `storeLayoutSchema.shape[key]`.
 * The API route re-exports it as `layoutSchema`, so the parity test
 * (`tests/unit/layout-schema-parity.test.ts`) still guards the silent-strip
 * class against `LAYOUT_TOP_LEVEL_KEYS`.
 */
import { z } from 'zod/v3';
import { isSafeUrl } from '../utils/safe-url';
import { LEGACY_HOME_SECTION_KEYS } from './section-keys';

// Permissive Zod schema — `resolveLayoutSettings` is the source of truth for
// merging with defaults. Validating the parts that absolutely must be right
// (numeric ranges, enum values) and letting unknown extras through keeps
// the column forward-compatible.
/**
 * Optional hero background video URL. Reuses the same `isSafeUrl` scheme
 * allowlist as `link`/`ctaHref`, then narrows it: a video is only ever loaded
 * (never navigated to), so it must be https or a relative upload path, never
 * http/mailto/tel. Empty string = cleared.
 */
const safeVideoUrl = z
  .string()
  .optional()
  .refine(
    v =>
      v === undefined || v === '' || (isSafeUrl(v) && !/^\s*(?!https:)[a-z][a-z0-9+.-]*:/i.test(v)),
    { message: 'Video must be an https URL or a relative upload path' }
  );

// Exported (not just used internally) so `tests/unit/hero-slide-schema.test.ts`
// can assert the `link` / `ctaHref` scheme-allowlist behavior directly,
// mirroring how `layoutSchema` is exported below for its parity test.
export const heroSlideSchema = z.object({
  // Optional (and empty string allowed) so a DRAFT may hold a just-added
  // slide with no image chosen yet, or an explicitly cleared one (autosave
  // must not reject the whole page over one in-progress slide — bug: "hero
  // slide with no image blocks ALL autosave"). Publishing is still gated:
  // `validatePublishReadiness` rejects any visible slide with no image
  // before it can go live.
  image: z.string().optional(),
  imageAr: z.string().optional(),
  // Mobile-specific images — without these listed in the Zod schema, the
  // parse step silently strips them and saves succeed with the field
  // gone. Bug found 2026-05-16 when merchants reported uploading mobile
  // images that disappeared on refresh.
  imageMobile: z.string().optional(),
  imageMobileAr: z.string().optional(),
  // Optional looping background video (Task 8). The slide image stays the
  // poster. MUST be listed here or the parse step silently strips it (the
  // imageMobile trap above). Lives inside the slide object so the R2 orphan
  // sweep (scans layoutSettings + revision documents) sees the URL.
  video: safeVideoUrl,
  videoMobile: safeVideoUrl,
  // Where a cropped (object-cover) hero keeps its subject: top keeps a model's head in frame on
  // the wide desktop crop (Ruling B1-32). MUST be listed or the parse step silently strips it.
  focus: z.enum(['top', 'center', 'bottom']).optional(),
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
export const colorValue = z
  .string()
  .regex(
    // `token:inverse` (W2a, LB-01): a section band in the page ink with the page colour as its
    // text; set by a look's mix, never offered in a colour picker (sectionBgStyle re-scopes ink).
    /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|token:(primary|secondary|accent|card|muted|foreground|border|inverse)|)$/,
    'Must be a hex color or token:<brand-color>'
  )
  .optional();

// Per-zone typography override — mirrors ZoneOverride in @ebda/shared.
// color reuses colorValue (hex or token:<name>).
export const zoneOverride = z
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
export const sectionTypographyOverride = z
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
export const dividerSettings = z
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

export const sectionDividers = z
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
const sectionSpacingPreset = z.enum(['none', 'tight', 'normal', 'loose', 'xloose', 'xxloose']);
export const sectionPaddingMaxWidthVisibility = {
  paddingTop: sectionSpacingPreset.optional(),
  paddingBottom: sectionSpacingPreset.optional(),
  // Per-device spacing (Ruling SP-1): projected to `responsive.<tablet|mobile>.settings` by the adapter.
  paddingTopTablet: sectionSpacingPreset.optional(),
  paddingTopMobile: sectionSpacingPreset.optional(),
  paddingBottomTablet: sectionSpacingPreset.optional(),
  paddingBottomMobile: sectionSpacingPreset.optional(),
  maxWidth: z.enum(['contained', 'full']).optional(),
  hideOnMobile: z.boolean().optional(),
  hideOnDesktop: z.boolean().optional(),
  // Visual builder: tablet-only visibility (see SectionPaddingMaxWidthVisibility).
  hideOnTablet: z.boolean().optional(),
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
      // the zod silent-strip trap (layout-schema-parity.test.ts). Keep in sync with HeroSettings.
      // 'collage' (Phase B1, Ruling B1-2): three overlapping photos + one headline, any skin.
      presentation: z.enum(['full-bleed', 'framed', 'collage']).optional(),
      // Ruling B1-41: an opt-in hairline drawn inside a FRAMED hero (Vitrine's mix sets 'line');
      // with it the photo fills the frame. Absent / 'none' = the framed hero as before.
      frame: z.enum(['none', 'line']).optional(),
      // W2a (L-04): copy at the bottom-start corner on a text-block scrim. Absent = centred.
      textAnchor: z.enum(['center', 'bottom-start']).optional(),
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
      layout: z.enum(['grid', 'horizontal', 'chips', 'rail', 'tiles']),
      // 2026-05-16: split into per-breakpoint settings (see store-layout.ts
      // CategoriesSettings). Mobile overrides are optional — fall back to
      // the legacy single field when unset.
      layoutMobile: z.enum(['grid', 'horizontal', 'chips', 'rail', 'tiles']).optional(),
      // Phase B3 (Ruling B3-5): list the store's tags (skin-type / concern chips) instead of categories.
      source: z.enum(['categories', 'tags']).optional(),
      // Phase B4 (Ruling B4-2): `aisles` paints square tiles in the look's aisle tints (names always show).
      tint: z.enum(['none', 'aisles']).optional(),
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
    // the zod silent-strip trap (layout-schema-parity.test.ts)).
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
      // Read by the storefront filter panel (ProductsClient). They were missing here, so the layout
      // PUT stripped them and a picked colour was saved but never rendered. Keep in sync with
      // FilterSidebarSettings in packages/shared/src/types/store-layout.ts.
      bgColor: colorValue,
      textColor: colorValue,
    }),
    testimonials: z.object({
      enabled: z.boolean(),
      minRating: z.number().min(1).max(5),
      verifiedOnly: z.boolean(),
      // Ruling B1-2: 'single' = one large customer quote (Vitrine); absent = the row.
      layout: z.enum(['row', 'single']).optional(),
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
        // Merchant-owned items. Absent = legacy store (fixed defaults render);
        // must be listed or Zod strips it on every PUT (same trap as above).
        items: z
          .array(
            z
              .object({
                icon: z.string().max(32).optional(),
                title: z.string().max(80).optional(),
                titleAr: z.string().max(80).optional(),
                text: z.string().max(200).optional(),
                textAr: z.string().max(200).optional(),
              })
              .strict()
          )
          .max(6)
          .optional(),
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
            productSource: z.enum([
              'newest',
              'best_seller',
              'featured',
              'on_sale',
              'category',
              'manual',
              'reorder',
            ]),
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
        // Owned by the section registry's key list (builder/section-keys.ts).
        z.enum(LEGACY_HOME_SECTION_KEYS)
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
 * Cast to `z.ZodObject<Record<string, z.ZodTypeAny>>` to avoid TS7056
 * ("inferred type exceeds maximum length") — the inferred Zod type is too deep
 * for tsc to serialize on an export. Consumers need `.shape` / `.parse`.
 */
export const storeLayoutSchema: z.ZodObject<Record<string, z.ZodTypeAny>> = layoutSchemaInternal;
