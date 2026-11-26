/**
 * The product shape both wishlist reads hand to the storefront cards
 * (`GET /wishlist` and the public shared wishlist).
 *
 * The cards decide quick-add vs "choose options" vs sold-out from `variants`,
 * `inStock` and `acceptsBackorder`. These projections used to carry none of
 * them (the client derived `inStock` from `status === 'active'`), so a sized
 * product offered a one-tap add and a sold-out one looked buyable (C-01,
 * 2026-10-15). Stock flags come from `enrichStockFlags`, the same function the
 * listing uses, so a wishlist card and a listing card never disagree.
 *
 * Prices stay in this surface's own unit (major, via `fromMinor`), variant
 * prices included, so the card's "From <min>" headline compares like with like.
 */
import { fromMinor } from '@ebda/shared';
import { enrichStockFlags } from './effective-inventory';

/** Include/select fragment for the product relation of a wishlist item. */
export const WISHLIST_CARD_VARIANTS_SELECT = {
  select: {
    id: true,
    price: true,
    compareAtPrice: true,
    inventory: true,
    allowBackorder: true,
    // Read for the stock rule (a disabled variant is not stock), then stripped.
    isActive: true,
  },
} as const;

interface WishlistProductRow {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  price: number;
  compareAtPrice: number | null;
  badgeLabel?: string | null;
  badgeLabelAr?: string | null;
  status: string;
  inventory: number;
  allowBackorder: boolean;
  lowStockThreshold: number;
  trackInventory?: boolean;
  images: Array<{ url: string }>;
  variants: Array<{
    id: string;
    price: number | null;
    compareAtPrice: number | null;
    inventory: number;
    allowBackorder: boolean;
    isActive: boolean;
  }>;
  options?: unknown;
  facts?: unknown;
  /** Card "3D" chip: selected as `{ id }` by the wishlist reads. */
  model3d?: { id: string } | null;
  /** Feeds the card "New" badge (isProductNew); the wishlist reads include every scalar. */
  createdAt?: Date | string | null;
}

export function wishlistCardProduct(p: WishlistProductRow) {
  const stock = enrichStockFlags({
    inventory: p.inventory,
    allowBackorder: p.allowBackorder,
    lowStockThreshold: p.lowStockThreshold,
    trackInventory: p.trackInventory,
    variants: p.variants,
  });
  // A product the merchant unpublished is not buyable whatever its stock.
  const active = p.status === 'active';
  return {
    id: p.id,
    name: p.name,
    nameAr: p.nameAr ?? undefined,
    slug: p.slug,
    price: fromMinor(p.price),
    compareAtPrice: p.compareAtPrice ? fromMinor(p.compareAtPrice) : undefined,
    // Merchant-authored card badge — the wishlist grid renders through
    // T.ProductGrid → the theme ProductCards, so this projection must
    // carry it or the badge silently disappears on this one surface.
    badgeLabel: p.badgeLabel,
    badgeLabelAr: p.badgeLabelAr,
    images: p.images.map(img => img.url),
    status: p.status,
    inStock: active && stock.inStock,
    acceptsBackorder: active && stock.acceptsBackorder,
    variants: p.variants.map(v => ({
      id: v.id,
      price: v.price == null ? null : fromMinor(v.price),
      compareAtPrice: v.compareAtPrice == null ? null : fromMinor(v.compareAtPrice),
    })),
    options: p.options,
    facts: p.facts,
    has3d: Boolean(p.model3d),
    createdAt: p.createdAt ?? undefined,
  };
}
