import { storefrontText } from '@ebda/shared';
import type { Product, Category } from '@/lib/api';
import type { RecommendedProduct } from '../hooks/useProductRecommendations';
import type { TemplateProduct, TemplateCategory } from './types';

/**
 * Card stock — ONE rule for every card mapper (C-01, 2026-10-15).
 *
 * Prefer the server-computed `inStock` (enrichStockFlags: variant-aware, a
 * disabled variant is not stock). Fall back to `inventory` only for a payload
 * that predates the flag. Never hard-code it in stock: the recommendation
 * and wishlist mappers did, so a sold-out product still offered a one-tap add.
 */
export function cardInStock(p: { inStock?: boolean | null; inventory?: number | null }): boolean {
  if (typeof p.inStock === 'boolean') return p.inStock;
  return p.inventory === undefined || p.inventory === null || p.inventory > 0;
}

/**
 * Card variants — keep EVERY variant row (the cards key "choose options" vs
 * quick-add on `variants.length`, and price "From <min>" on the prices). A
 * mapper that drops this field turns a sized product into a one-tap add of a
 * sizeless line; the cart API now refuses that (VARIANT_REQUIRED), but the
 * card must not offer it in the first place.
 */
export function cardVariants(
  variants:
    | ReadonlyArray<{ price?: number | null; compareAtPrice?: number | null }>
    | null
    | undefined
): TemplateProduct['variants'] {
  if (!variants) return undefined;
  return variants.map(v => ({
    price: typeof v.price === 'number' ? v.price : undefined,
    compareAtPrice: typeof v.compareAtPrice === 'number' ? v.compareAtPrice : undefined,
  }));
}

/** True when the card must send the shopper to the PDP to choose options. */
export function needsOptions(p: { variants?: ReadonlyArray<unknown> | null }): boolean {
  return (p.variants?.length ?? 0) > 0;
}

/**
 * Map the API's Product shape into the TemplateProduct shape that every
 * template's ProductCard / ProductGrid accepts. Used wherever a page
 * renders products through the template system.
 */
export function toTemplateProduct(p: Product): TemplateProduct {
  return {
    id: p.id,
    name: storefrontText(p.name, false),
    // Preserve nameAr so RTL templates render Arabic product names instead
    // of falling through to the English `name`. The API consistently returns
    // `nameAr` for tenants that have entered it (e.g. Wady Aljuz).
    nameAr: arText(p.nameAr),
    slug: p.slug,
    price: p.price,
    compareAtPrice: p.compareAtPrice ?? undefined,
    // Bug A fix: pass discountType + discountValue through so getDiscountBadgeText
    // can render "Save EGP X.XX" instead of "-Y%" for fixed-amount discounts.
    discountType: p.discountType ?? undefined,
    discountValue: p.discountValue ?? undefined,
    // Merchant-authored card badge. This adapter is an explicit whitelist, so
    // a field that is not named here is DROPPED — every card downstream would
    // render no badge while the admin showed a saved label. Same class of bug
    // as the `nameAr` and `discountType` lines above.
    badgeLabel: p.badgeLabel ?? undefined,
    badgeLabelAr: p.badgeLabelAr ?? undefined,
    images: (p.images || []).map(img => ({
      id: img.id || p.id,
      url: img.url,
      alt: img.alt,
    })),
    inStock: cardInStock(p),
    // Whitelist adapter: without this a backorderable sold-out piece read as
    // available in a PDP related row but sold-out on the PLP card.
    acceptsBackorder: p.acceptsBackorder === true,
    // Pass variant prices through so the cards can derive
    // "From <min>" headlines for multi-variant products.
    variants: cardVariants(p.variants),
    // Whitelist adapter: without this the card swatch dots never render.
    options: p.options,
    // Whitelist adapter: without this the card fact chips never render.
    facts: p.facts,
    // Whitelist adapter: without this the card "3D" chip never renders.
    has3d: p.has3d === true,
    // Whitelist adapter: without this the "New" badge never rendered on any card.
    createdAt: p.createdAt ?? null,
  };
}

/**
 * The recommendation payload (FBT grid, "You might also like" strip, cart
 * recommendations) → TemplateProduct. ONE mapper for the three surfaces that
 * each used to hand-build their own (and each dropped variants or hard-coded
 * the product as in stock).
 */
export function recommendedToTemplateProduct(p: RecommendedProduct): TemplateProduct {
  return {
    id: p.id,
    name: storefrontText(p.name, false),
    nameAr: arText(p.nameAr),
    slug: p.slug,
    price: p.price,
    compareAtPrice: p.compareAtPrice ?? undefined,
    discountType: p.discountType ?? undefined,
    discountValue: p.discountValue ?? undefined,
    badgeLabel: p.badgeLabel ?? undefined,
    badgeLabelAr: p.badgeLabelAr ?? undefined,
    images: p.images,
    inStock: cardInStock(p),
    acceptsBackorder: p.acceptsBackorder === true,
    variants: cardVariants(p.variants),
    options: p.options,
    facts: p.facts,
    // Whitelist adapter: without this the card "3D" chip never renders.
    has3d: p.has3d === true,
    createdAt: p.createdAt ?? null,
  };
}

/** One wishlist item's product, as `GET /wishlist` projects it (lib/wishlist-card.ts). */
export interface WishlistCardProduct {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | null;
  badgeLabel?: string | null;
  badgeLabelAr?: string | null;
  images: string[];
  status: string;
  inStock?: boolean;
  acceptsBackorder?: boolean;
  variants?: Array<{ id: string; price?: number | null; compareAtPrice?: number | null }>;
  options?: TemplateProduct['options'];
  facts?: TemplateProduct['facts'];
  has3d?: boolean;
  createdAt?: string | null;
}

/** The wishlist grid's mapper (same stock + variant rules as every other card). */
export function wishlistToTemplateProduct(itemId: string, p: WishlistCardProduct): TemplateProduct {
  return {
    id: p.id,
    name: storefrontText(p.name, false),
    nameAr: arText(p.nameAr),
    slug: p.slug,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    discountType: p.discountType ?? undefined,
    discountValue: p.discountValue ?? undefined,
    badgeLabel: p.badgeLabel ?? undefined,
    badgeLabelAr: p.badgeLabelAr ?? undefined,
    images: p.images.map((url, i) => ({ id: `${itemId}-${i}`, url })),
    // An unpublished product is not buyable whatever the stock says; an older
    // payload without the flag falls back to the status rule it used before.
    inStock: p.status === 'active' && (typeof p.inStock === 'boolean' ? p.inStock : true),
    acceptsBackorder: p.status === 'active' && p.acceptsBackorder === true,
    variants: cardVariants(p.variants),
    options: p.options,
    facts: p.facts,
    // Whitelist adapter: without this the card "3D" chip never renders.
    has3d: p.has3d === true,
    createdAt: p.createdAt ?? null,
  };
}

/**
 * Map the API's Category shape into the TemplateCategory shape.
 */
export function toTemplateCategory(c: Category): TemplateCategory {
  return {
    id: c.id,
    name: storefrontText(c.name, false),
    nameAr: arText(c.nameAr),
    slug: c.slug || c.name.toLowerCase().replace(/\s+/g, '-'),
    image: c.image,
    productCount: c.productCount,
  };
}

/** Arabic copy: Western digits + bidi-isolated numbers (PREMIUM-12). Absent stays absent. */
function arText<T extends string | null | undefined>(v: T): T {
  return (v ? storefrontText(v, true) : v) as T;
}
