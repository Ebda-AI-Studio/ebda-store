/**
 * Section types that exist ONLY in the page document (visual builder
 * Phase 2): they have no key in the legacy `stores.layout_settings`, so the
 * adapter never projects them and the storefront renders them straight from
 * the published `PageDefinition`. Their validators live here (strict Zod);
 * their settings descriptors are in the registry.
 */
import { z } from 'zod/v3';
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
  .enum(['newest', 'best_seller', 'featured', 'on_sale', 'category', 'manual'])
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
    // `reorder` (Phase B4, Ruling B4-8): the signed-in customer's last products; only the grid
    // sections that render a row for it accept it (not the spotlight).
    productSource: z
      .enum(['newest', 'best_seller', 'featured', 'on_sale', 'category', 'manual', 'reorder'])
      .optional(),
    // 24 = the most the home page fetches for one section (HomePageBody). A `menu` lists up to that many.
    limit: z.number().int().min(2).max(24).optional(),
    columns: z.number().int().min(2).max(5).optional(),
    mobileColumns: z.number().int().min(1).max(2).optional(),
    // Phase B4 (Ruling B4-1): `grid` (absent) = the product grid; `menu` = dish rows grouped by the
    // store's categories, with sticky category tabs when `tabs` is `categories` (absent = tabs on).
    layout: z.enum(['grid', 'menu']).optional(),
    tabs: z.enum(['categories', 'none']).optional(),
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
    // `list` (default, absent) = the photograph beside a product list; `stage` = ONE product on a
    // large object-contain tile (Souq Showroom, Phase B2).
    layout: z.enum(['list', 'stage']).optional(),
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
    // 'arch' stays ACCEPTED so saved documents keep validating (Ruling B5-3); it is never offered
    // by the editor and renders as the look's rectangle.
    tileShape: z.enum(['arch', 'rectangle', 'circle', 'band']).optional(),
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
    /** Band colour when the list uses `tileShape: 'band'` (Ruling B1-2/B1-5). */
    tone: z.enum(['primary', 'accent', 'line']).optional(),
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

/**
 * "Shop the look" (Phase B1, Qamar Lookbook; Ruling B1-2): a snap-scroll row of looks.
 * Each look is a `look` block: one photo plus up to 4 products BY REFERENCE. The items
 * are links to the PDP (thumbnail, name, price); there is no quick add and no "add the
 * whole look" (Ruling B1-6). Unknown or cross-store ids are a REF_NOT_FOUND warning on
 * save (C11) and never render (the storefront resolves them against the store's own pool).
 */
export const shopTheLookSchema = z
  .object({ ...frame, heading: text(200), headingAr: text(200) })
  .strict();

export const shopTheLookBlockSchema = z
  .object({
    image: z.string().max(2048).optional(),
    imageAr: z.string().max(2048).optional(),
    alt: text(300),
    altAr: text(300),
    title: text(80),
    titleAr: text(80),
    productIds: z.array(z.string().max(80)).min(1).max(4).optional(),
  })
  .strict();

/**
 * "Routine steps" (Phase B3, Jasmine Clinic; Ruling B3-6): an ordered list of 2-5 real steps
 * (cleanse, treat, protect). Each step is a `step` block with an optional product BY REFERENCE
 * (`productIds[0]`, resolved against the store at render time, price and stock never live in the
 * document). Numbers appear only because the ORDER matters; "add all" exists only when every step
 * has a purchasable product.
 */
export const stepsSchema = z
  .object({
    ...frame,
    heading: text(200),
    headingAr: text(200),
    subheading: text(400),
    subheadingAr: text(400),
    buttonText: text(60),
    buttonTextAr: text(60),
  })
  .strict();

export const stepsBlockSchema = z
  .object({
    title: text(80),
    titleAr: text(80),
    body: text(240),
    bodyAr: text(240),
    link: safeLink,
    productIds: z.array(z.string().max(80)).max(1).optional(),
  })
  .strict();

/**
 * "Maker profile" (Phase B4, Lamma; Ruling B4-1): who cooks. `strip` = avatar, name, one line and
 * the hygiene line; `lead` = a large photo first, a "from the kitchen of ..." heading and a
 * clamped story. Every field is optional and a profile with neither a name nor a photo renders
 * nothing (an unfilled feature renders nothing). Nothing here is a platform claim: the hygiene
 * line is the merchant's own words.
 */
export const makerProfileSchema = z
  .object({
    ...frame,
    variant: z.enum(['strip', 'lead']).optional(),
    image: z.string().max(2048).optional(),
    imageAr: z.string().max(2048).optional(),
    alt: text(300),
    altAr: text(300),
    name: text(80),
    nameAr: text(80),
    role: text(120),
    roleAr: text(120),
    story: text(600),
    storyAr: text(600),
    hygiene: text(160),
    hygieneAr: text(160),
    years: z.number().int().min(0).max(80).optional(),
    storyLink: safeLink,
  })
  .strict();

/**
 * "Gift finder" (Phase B5, Dahab Gift box; Ruling B5-7): who is it for, and how much. Occasions are
 * `occasion` blocks that name a CATEGORY by slug (a reference, checked against the store like a
 * collection tile), budgets are `budget` blocks holding a cap in whole pounds (`maxPrice`, converted
 * to minor units only when the link is built). The section is links over the product list's URL
 * filters (`?category=`, `?maxPrice=`): no facet, no new API. With no occasion and no budget it
 * renders nothing (an unfilled feature renders nothing).
 */
export const giftFinderSchema = z
  .object({
    ...frame,
    heading: text(200),
    headingAr: text(200),
    occasionsLabel: text(80),
    occasionsLabelAr: text(80),
    budgetsLabel: text(80),
    budgetsLabelAr: text(80),
    buttonText: text(60),
    buttonTextAr: text(60),
  })
  .strict();

export const giftOccasionBlockSchema = z
  .object({
    categorySlug: z.string().max(120).optional(),
    label: text(60),
    labelAr: text(60),
  })
  .strict();

export const giftBudgetBlockSchema = z
  .object({
    /** Whole pounds; the link carries it in minor units. */
    maxPrice: z.number().int().min(1).max(1_000_000).optional(),
    label: text(60),
    labelAr: text(60),
  })
  .strict();

/**
 * Signature sections (T7, plan `2026-10-25-templates-match-mockups.md` P7): one distinctive
 * section per template, the "signature moment" of its looks. Five types, one shape: an optional
 * kicker, title and subtitle (the AI fills the kicker and subtitle), an optional call to action,
 * and, per type, a main photo and/or a short list of blocks. Every one renders with no photo at
 * all (a typographic fallback); a list-driven one with fewer than two filled blocks renders
 * nothing publicly (an unfilled feature renders nothing). Photos are one per section or block,
 * the same in both languages; every text is bilingual.
 */
const signatureText = {
  kicker: text(60),
  kickerAr: text(60),
  title: text(200),
  titleAr: text(200),
  subtitle: text(400),
  subtitleAr: text(400),
  ctaText: text(60),
  ctaTextAr: text(60),
  ctaHref: safeLink,
};
const signaturePhoto = {
  image: z.string().max(2048).optional(),
  alt: text(300),
  altAr: text(300),
};

/** Qamar: three overlapping photos under one line (the Lookbook collage, as a page section). */
export const editorialCollageSchema = z.object({ ...frame, ...signatureText }).strict();
export const collagePhotoBlockSchema = z.object({ ...signaturePhoto }).strict();

/** Dahab: one piece in a double hairline frame, like a jeweller's window. */
export const pieceWindowSchema = z
  .object({ ...frame, ...signatureText, ...signaturePhoto })
  .strict();

/** Souq: a product photo beside its key figures (screen, battery, storage). */
export const specSheetSchema = z.object({ ...frame, ...signatureText, ...signaturePhoto }).strict();
export const specBlockSchema = z
  .object({ value: text(16), label: text(60), labelAr: text(60) })
  .strict();

/** Jasmine: what is inside, one ingredient per line with what it does. */
export const keyIngredientsSchema = z
  .object({ ...frame, ...signatureText, ...signaturePhoto })
  .strict();
export const ingredientBlockSchema = z
  .object({ name: text(60), nameAr: text(60), benefit: text(160), benefitAr: text(160) })
  .strict();

/** Lamma: what is cooking on which day of the week. */
export const kitchenDaysSchema = z.object({ ...frame, ...signatureText }).strict();
export const kitchenDayBlockSchema = z
  .object({
    day: text(30),
    dayAr: text(30),
    dish: text(80),
    dishAr: text(80),
    note: text(120),
    noteAr: text(120),
    image: z.string().max(2048).optional(),
  })
  .strict();
