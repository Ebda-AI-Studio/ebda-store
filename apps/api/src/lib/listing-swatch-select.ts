import type { Prisma } from '@ebda/database';

/**
 * Card/carousel swatch payload for the storefront LISTING selects (not the PDP,
 * which returns the full option graph). Only values that carry a swatch ship,
 * capped at 3 options x 8 values, so non-swatch stores add one empty batched
 * query per page.
 *
 * CACHE CLASS: BOUNDED-stale. On the product listing / PDP cache, every
 * option-value write already calls the product cache bust (Task 1), so a
 * swatch edit invalidates this payload on the same path as variant writes.
 * The recommendation payloads (`recommendation.service.ts`, `CACHE_TTL_SECONDS`
 * = 300) are NOT busted by that path: they ride their own 5-minute TTL, so a
 * swatch edit can take up to 5 minutes to reach "you might also like" /
 * "frequently bought together" cards. Wishlist reads are uncached.
 */
export const LISTING_SWATCH_OPTIONS_SELECT = {
  orderBy: { position: 'asc' as const },
  take: 3,
  select: {
    name: true,
    nameAr: true,
    // Total swatch-bearing values (take: 8 below caps the rows), so the card's
    // "+N" counts every colour and not just the 8 shipped.
    _count: {
      select: {
        values: {
          where: { OR: [{ swatchHex: { not: null } }, { swatchImageUrl: { not: null } }] },
        },
      },
    },
    values: {
      where: { OR: [{ swatchHex: { not: null } }, { swatchImageUrl: { not: null } }] },
      orderBy: { position: 'asc' as const },
      take: 8,
      select: { id: true, value: true, valueAr: true, swatchHex: true, swatchImageUrl: true },
    },
  },
} satisfies Prisma.Product$optionsArgs;
