/**
 * The PUT /stores/:id/theme edge (`theme` JSON column, shallow-merge PATCH in
 * `StoreService.updateTheme`). Moved out of `store.routes.ts` so the edge can be
 * tested without the router (Ruling D1016-NEW-2).
 */
import { z } from 'zod/v3';
import {
  LOOK_DENSITIES,
  LOOK_IMAGE_RATIOS,
  LOOK_MOTIONS,
  LOOK_OVER_PHOTO_CHROMES,
  LOOK_RECEIPT_STYLES,
  LOOK_WORDMARK_SIZES,
  LOOK_CARD_CTAS,
  LOOK_CARD_HOVERS,
  LOOK_CARD_BADGES,
  HEADER_LOGO_PLACEMENTS,
  HEADER_SEARCH_PLACEMENTS,
  HEADER_WORDMARKS,
  HERO_RATIOS,
  TAB_BARS,
  HEADING_WEIGHTS,
  PRICE_COLOURS,
  CARD_CHROME,
  GRID_GUTTERS,
} from '@ebda/shared';

/**
 * Theme keys that are merchant switches. `showNewBadge` (Ruling D1016-NEW-1) gates the
 * card "New" badge on every card path; a string "false" must never reach `=== true` checks.
 */
export const THEME_BOOLEAN_KEYS = [
  'showNewBadge',
  // the other product-card switches, ported from the retired page builder (Ruling VE-17)
  'showBrandBadge',
  'showQuickAdd',
  'normalizeProductImages',
  'saleBadgeLegacyCorner',
] as const;

export const themeSchema = z
  .record(z.string(), z.unknown())
  .refine(
    data => {
      // Validate known string fields have reasonable lengths
      const stringFields = [
        'primaryColor',
        'secondaryColor',
        'accentColor',
        'backgroundColor',
        'textColor',
        'buttonStyle',
      ];
      for (const field of stringFields) {
        if (field in data && typeof data[field] === 'string' && (data[field] as string).length > 50)
          return false;
      }
      const longStringFields = ['fontFamily', 'headingFontFamily'];
      for (const field of longStringFields) {
        if (
          field in data &&
          typeof data[field] === 'string' &&
          (data[field] as string).length > 100
        )
          return false;
      }
      return true;
    },
    { message: 'Theme field values exceed maximum length' }
  )
  .superRefine((data, ctx) => {
    // Look-only keys feed CSS variables through fixed maps: only their known values (or null =
    // delete the key) may be stored, so a bad value can never reach the storefront.
    const allowed: Record<string, readonly string[]> = {
      density: LOOK_DENSITIES,
      imageRatio: LOOK_IMAGE_RATIOS,
      motion: LOOK_MOTIONS,
      wordmarkSize: LOOK_WORDMARK_SIZES,
      overPhotoChrome: LOOK_OVER_PHOTO_CHROMES,
      receiptStyle: LOOK_RECEIPT_STYLES,
      cardCta: LOOK_CARD_CTAS,
      cardHover: LOOK_CARD_HOVERS,
      cardBadge: LOOK_CARD_BADGES,
      headerLogoPlacement: HEADER_LOGO_PLACEMENTS,
      headerSearch: HEADER_SEARCH_PLACEMENTS,
      headerWordmark: HEADER_WORDMARKS,
      heroRatio: HERO_RATIOS,
      tabBar: TAB_BARS,
      headingWeight: HEADING_WEIGHTS,
      priceColour: PRICE_COLOURS,
      cardHeart: CARD_CHROME,
      cardSwatches: CARD_CHROME,
      cardTags: CARD_CHROME,
      gridGutter: GRID_GUTTERS,
    };
    for (const [key, values] of Object.entries(allowed)) {
      if (!(key in data) || data[key] === null) continue;
      if (typeof data[key] !== 'string' || !values.includes(data[key] as string))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be one of ${values.join(', ')}`,
        });
    }
    // Merchant on/off switches stored in the theme: a boolean, or null (= delete the key).
    for (const key of THEME_BOOLEAN_KEYS) {
      if (!(key in data) || data[key] === null) continue;
      if (typeof data[key] !== 'boolean')
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be a boolean`,
        });
    }
  });
