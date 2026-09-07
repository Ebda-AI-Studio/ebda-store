/** Shared checkout types — single source of truth for CartItem, Coupon, and PaymentProvider. */

export interface CheckoutCartItem {
  id: string;
  productId: string;
  quantity: number;
  price: number;
  product: {
    id: string;
    name: string;
    /** Arabic display name — OrderSummary picks this when locale is
     *  Arabic. Optional because not every product is translated. */
    nameAr?: string;
    slug: string;
    images: { id: string; url: string; alt?: string }[];
  };
}

/**
 * A bundle line in the checkout order summary — rendered as ONE row (see
 * `BundleLine`), never split into its per-component allocated prices.
 * Mirrors `CartContext`'s `CartBundle`.
 */
export interface CheckoutCartBundle {
  id: string;
  bundleId: string;
  name: string;
  nameAr?: string;
  image?: string;
  quantity: number;
  total: number;
}

export interface Coupon {
  id: string;
  code: string;
  name: string;
  type: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
}

export interface PaymentProvider {
  id: string;
  name: string;
  nameAr?: string;
  description?: string;
  descriptionAr?: string;
  logo?: string;
  methods?: string[];
  enabled?: boolean;
}
