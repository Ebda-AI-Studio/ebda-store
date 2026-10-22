/**
 * Pure cart-line helpers shared by `CartContext` — kept out of the React
 * module so they can be tested on real values (no provider, no DOM).
 */
import type { PublicGoldPricing } from '@ebda/shared';
import type { CartItem, CartBundle } from './CartContext';

// Shape returned by GET /public/cart
export interface ServerCartItem {
  id: string;
  productId: string;
  quantity: number;
  variantId?: string | null;
  /** Personalisation text (cleaned server-side); part of the line identity. */
  note?: string | null;
  product: {
    id: string;
    name: string;
    nameAr?: string | null;
    slug: string;
    price: number;
    images?: Array<{ id: string; url: string; alt?: string | null }>;
    categories?: Array<{ category: { name?: string; nameAr?: string } }>;
    /** Made-to-order lead time (business days): the longest in the cart sets the earliest delivery date. */
    leadTimeDays?: number | null;
  };
  variant?: { id: string; title: string; titleAr?: string | null; price?: number } | null;
  unavailable?: boolean;
  /**
   * Server-resolved pricing for this buyer (B2B Task 3): the unit price actually charged (tier / group price / retail),
   * the retail list price, where the price came from, and the product's minimum order quantity state. Absent on a line
   * the server did not price (an unavailable line) and on responses from an older API.
   */
  unitPrice?: number;
  listPrice?: number;
  priceSource?: 'base' | 'tier' | 'group';
  priceTierMinQty?: number | null;
  /** Highest price break on offer for this line (null / absent = none). */
  priceLadderTopMinQty?: number | null;
  belowMoq?: boolean;
  moqRequired?: number | null;
  /** Gold line (B5-17): the price moved since it was added; the cart / checkout show the notice. */
  priceChanged?: boolean;
  previousUnitPrice?: number | null;
  goldPricing?: PublicGoldPricing;
}

export function mapServerItem(item: ServerCartItem): CartItem {
  return {
    id: item.id,
    productId: item.productId,
    name: item.product.name,
    nameAr: item.product.nameAr ?? undefined,
    // The SERVER-resolved unit price for this buyer (tier / group / retail): the cart and checkout render this and never
    // multiply a catalogue price themselves. Falls back to the chosen variant's price (then the parent product's) for a
    // line the server did not price (unavailable) or an older API response.
    price: item.unitPrice ?? item.variant?.price ?? item.product.price,
    listPrice: item.listPrice,
    priceSource: item.priceSource,
    priceTierMinQty: item.priceTierMinQty ?? undefined,
    priceLadderTopMinQty: item.priceLadderTopMinQty ?? undefined,
    belowMoq: item.belowMoq === true ? true : undefined,
    moqRequired: item.moqRequired ?? undefined,
    quantity: item.quantity,
    image: item.product.images?.[0]?.url,
    slug: item.product.slug,
    category: item.product.categories?.[0]?.category?.name,
    variantId: item.variantId ?? undefined,
    variantTitle: item.variant?.title ?? undefined,
    variantTitleAr: item.variant?.titleAr ?? undefined,
    note: item.note ?? undefined,
    unavailable: item.unavailable === true ? true : undefined,
    leadTimeDays: item.product.leadTimeDays ?? undefined,
    priceChanged: item.priceChanged === true ? true : undefined,
    previousPrice: item.priceChanged === true ? (item.previousUnitPrice ?? undefined) : undefined,
    gold: item.goldPricing ?? undefined,
  };
}

/**
 * One cart line = (product, variant, personalisation note). "Sara" and "Omar"
 * on the same abaya are two lines; the same note merges. Mirrors the server's
 * unique index (cart_id, product_id, variant_id, COALESCE(note, '')).
 */
export function sameLine(
  a: Pick<CartItem, 'productId' | 'variantId' | 'note'>,
  b: Pick<CartItem, 'productId' | 'variantId' | 'note'>
): boolean {
  return (
    a.productId === b.productId &&
    (a.variantId ?? null) === (b.variantId ?? null) &&
    (a.note ?? null) === (b.note ?? null)
  );
}

/**
 * Count + total of what the customer can actually buy. A line flagged
 * `unavailable` (#1766 — product deleted) is excluded from both, matching the
 * server's `subtotal`; it is still listed so the customer can remove it.
 */
export function cartTotals(
  items: ReadonlyArray<Pick<CartItem, 'price' | 'quantity' | 'unavailable'>>,
  bundles: ReadonlyArray<Pick<CartBundle, 'quantity' | 'total'>>
): { itemCount: number; total: number } {
  const orderable = items.filter(item => !item.unavailable);
  return {
    itemCount:
      orderable.reduce((sum, item) => sum + item.quantity, 0) +
      bundles.reduce((sum, b) => sum + b.quantity, 0),
    total:
      orderable.reduce((sum, item) => sum + item.price * item.quantity, 0) +
      bundles.reduce((sum, b) => sum + b.total, 0),
  };
}
