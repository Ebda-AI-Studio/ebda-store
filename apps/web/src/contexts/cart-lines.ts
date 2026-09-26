/**
 * Pure cart-line helpers shared by `CartContext` — kept out of the React
 * module so they can be tested on real values (no provider, no DOM).
 */
import type { CartItem, CartBundle } from './CartContext';

// Shape returned by GET /public/cart
export interface ServerCartItem {
  id: string;
  productId: string;
  quantity: number;
  variantId?: string | null;
  product: {
    id: string;
    name: string;
    nameAr?: string | null;
    slug: string;
    price: number;
    images?: Array<{ id: string; url: string; alt?: string | null }>;
    categories?: Array<{ category: { name?: string; nameAr?: string } }>;
  };
  variant?: { id: string; title: string; titleAr?: string | null; price?: number } | null;
  unavailable?: boolean;
}

export function mapServerItem(item: ServerCartItem): CartItem {
  return {
    id: item.id,
    productId: item.productId,
    name: item.product.name,
    nameAr: item.product.nameAr ?? undefined,
    // Show the chosen variant's price (fall back to the parent product for
    // variant-less products) — matches what the server charges.
    price: item.variant?.price ?? item.product.price,
    quantity: item.quantity,
    image: item.product.images?.[0]?.url,
    slug: item.product.slug,
    category: item.product.categories?.[0]?.category?.name,
    variantId: item.variantId ?? undefined,
    variantTitle: item.variant?.title ?? undefined,
    variantTitleAr: item.variant?.titleAr ?? undefined,
    unavailable: item.unavailable === true ? true : undefined,
  };
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
