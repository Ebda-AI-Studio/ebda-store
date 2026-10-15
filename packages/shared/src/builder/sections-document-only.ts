/**
 * Section types that exist ONLY in the page document (visual builder
 * Phase 2): they have no key in the legacy `stores.layout_settings`, so the
 * adapter never projects them and the storefront renders them straight from
 * the published `PageDefinition`. Their validators live here (strict Zod);
 * their settings descriptors are in the registry.
 */
import { z } from 'zod';
import { colorValue, sectionPaddingMaxWidthVisibility } from './layout-schema';
import { isSafeUrl } from '../utils/safe-url';

const text = (max: number) => z.string().max(max).optional();
const safeLink = z
  .string()
  .max(2048)
  .optional()
  .refine(v => v === undefined || v === '' || isSafeUrl(v), {
    message: 'Link must be a relative path or use http(s)/mailto/tel',
  });

/** Shared by both: visibility (from the adapter projection) + spacing + background. */
const frame = {
  enabled: z.boolean().optional(),
  bgColor: colorValue,
  ...sectionPaddingMaxWidthVisibility,
};

export const imageTextSchema = z
  .object({
    ...frame,
    image: z.string().max(2048).optional(),
    imageAr: z.string().max(2048).optional(),
    alt: text(300),
    altAr: text(300),
    heading: text(200),
    headingAr: text(200),
    body: text(2000),
    bodyAr: text(2000),
    buttonText: text(60),
    buttonTextAr: text(60),
    buttonLink: safeLink,
    layout: z.enum(['split', 'full-bleed']).optional(),
    // Logical, never left/right: `start` mirrors to the right in Arabic.
    imagePosition: z.enum(['start', 'end']).optional(),
    imageAspect: z.enum(['square', 'portrait', 'landscape']).optional(),
  })
  .strict();

export const newsletterSchema = z
  .object({
    ...frame,
    heading: text(200),
    headingAr: text(200),
    body: text(600),
    bodyAr: text(600),
    buttonText: text(40),
    buttonTextAr: text(40),
  })
  .strict();

/**
 * Commerce + merchandising sections added with the Dahab template (builder
 * Phase 3 pilot). Document-only like the two above, available to every
 * template; product data is bound BY REFERENCE (category slug / product ids /
 * a named source) and resolved against the store at render time — price and
 * stock never live in the document.
 */
const productSource = z
  .enum(['newest', 'best_seller', 'featured', 'category', 'manual'])
  .optional();
const productRefs = {
  productSource,
  categorySlug: z.string().max(120).optional(),
  manualProductIds: z.array(z.string().max(80)).max(24).optional(),
};

/** Product grid bound to a collection ("Featured collection"). */
export const featuredCollectionSchema = z
  .object({
    ...frame,
    heading: text(200),
    headingAr: text(200),
    subheading: text(400),
    subheadingAr: text(400),
    ...productRefs,
    limit: z.number().int().min(2).max(12).optional(),
    columns: z.number().int().min(2).max(5).optional(),
    mobileColumns: z.number().int().min(1).max(2).optional(),
    buttonText: text(60),
    buttonTextAr: text(60),
    buttonLink: safeLink,
  })
  .strict();

/** Editorial image + a short hand-picked product list ("Gift ideas"). */
export const productSpotlightSchema = z
  .object({
    ...frame,
    image: z.string().max(2048).optional(),
    imageAr: z.string().max(2048).optional(),
    alt: text(300),
    altAr: text(300),
    heading: text(200),
    headingAr: text(200),
    body: text(1000),
    bodyAr: text(1000),
    ...productRefs,
    limit: z.number().int().min(1).max(4).optional(),
    imagePosition: z.enum(['start', 'end']).optional(),
    buttonText: text(60),
    buttonTextAr: text(60),
    buttonLink: safeLink,
  })
  .strict();

/** Collection tiles; each tile is a `collection` block. */
export const collectionListSchema = z
  .object({
    ...frame,
    heading: text(200),
    headingAr: text(200),
    tileShape: z.enum(['arch', 'rectangle', 'circle']).optional(),
    columns: z.number().int().min(2).max(4).optional(),
  })
  .strict();

export const collectionBlockSchema = z
  .object({
    categorySlug: z.string().max(120).optional(),
    image: z.string().max(2048).optional(),
    imageAr: z.string().max(2048).optional(),
    label: text(80),
    labelAr: text(80),
  })
  .strict();

/** Reassurance row; each item is a `badge` block. */
export const trustBadgesSchema = z
  .object({
    ...frame,
    heading: text(200),
    headingAr: text(200),
    layout: z.enum(['row', 'grid']).optional(),
  })
  .strict();

export const TRUST_BADGE_ICONS = [
  'cod',
  'instapay',
  'shipping',
  'certified',
  'returns',
  'gift',
  'engraving',
  'support',
] as const;
export type TrustBadgeIcon = (typeof TRUST_BADGE_ICONS)[number];

export const trustBadgeBlockSchema = z
  .object({
    icon: z.enum(TRUST_BADGE_ICONS).optional(),
    title: text(80),
    titleAr: text(80),
    text: text(200),
    textAr: text(200),
  })
  .strict();
