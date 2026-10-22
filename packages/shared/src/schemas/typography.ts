/**
 * The shape of a store's typography (`stores.typography`): a font library and per-zone overrides.
 * One definition for the typography PUT route and for the visual editor's draft patch
 * (`PageDefinition.typography`, see `builder/typography-draft.ts`).
 */
import { z } from 'zod';

// Per-zone styling. Every field is optional so the merchant can leave
// most zones inheriting from the template and only override the bits
// they care about.
export const zoneSchema = z.object({
  fontFamily: z.string().max(255).optional(),
  fontSize: z.string().max(64).optional(),
  fontWeight: z.string().max(64).optional(),
  color: z.string().max(64).optional(),
  lineHeight: z.string().max(64).optional(),
  letterSpacing: z.string().max(64).optional(),
  // Label / chip styling — backgroundColor turns the zone into a coloured
  // label. padding + borderRadius shape the chip. The storefront CSS
  // emitter auto-adds `display:inline-block` when any of these are set so
  // padding renders correctly on inline text.
  backgroundColor: z.string().max(64).optional(),
  padding: z.string().max(64).optional(),
  borderRadius: z.string().max(64).optional(),
  // Text decoration — underline / line-through / none.
  textDecoration: z.string().max(64).optional(),
  textDecorationColor: z.string().max(64).optional(),
  textDecorationThickness: z.string().max(32).optional(),
  textUnderlineOffset: z.string().max(32).optional(),
});

// Library of fonts the storefront should load. Two flavors:
//   1. Google Fonts URL the merchant pasted from fonts.google.com
//   2. Custom font file the merchant uploaded to R2 (woff2/woff/ttf/otf)
export const fontSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('google'),
    url: z.string().url().max(2048),
    family: z.string().min(1).max(255),
  }),
  z.object({
    type: z.literal('custom'),
    family: z.string().min(1).max(255),
    url: z.string().url().max(2048),
    format: z.enum(['woff2', 'woff', 'ttf', 'otf']),
    weight: z.string().max(64).optional(),
    style: z.enum(['normal', 'italic']).optional(),
  }),
]);

export const typographySchema = z.object({
  fonts: z.array(fontSourceSchema).max(20),
  zones: z
    .object({
      // Broad zones
      beforeHeader: zoneSchema.optional(),
      header: zoneSchema.optional(),
      // storeName is a sub-zone of the header (store name text in the header
      // bar). Previously missing from this schema which caused Zod to silently
      // strip merchant edits made from the page-builder Header card — 2026-05-28.
      storeName: zoneSchema.optional(),
      categories: zoneSchema.optional(),
      products: zoneSchema.optional(),
      footer: zoneSchema.optional(),
      afterFooter: zoneSchema.optional(),
      // Sub-zones (nested inside broad zones; CSS specificity wins)
      sectionKicker: zoneSchema.optional(),
      sectionTitle: zoneSchema.optional(),
      sectionSubtitle: zoneSchema.optional(),
      sectionSeeAll: zoneSchema.optional(),
      productName: zoneSchema.optional(),
      productPrice: zoneSchema.optional(),
      cta: zoneSchema.optional(),
      filters: zoneSchema.optional(),
    })
    .default({}),
});

export type TypographyConfig = z.infer<typeof typographySchema>;
export type FontSourceConfig = z.infer<typeof fontSourceSchema>;
