/** Shared checkout types — single source of truth for CartItem, Coupon, and PaymentProvider. */

export interface CheckoutCartItem {
  id: string;
  productId: string;
  quantity: number;
  price: number;
  /** Personalisation text shown under the line name. */
  note?: string;
  /** The chosen variant ("Rose / S / 52"), as the cart and receipt show it (IA-02). */
  variantTitle?: string;
  variantTitleAr?: string;
  /** Gold line (B5): today's rate behind the price; the summary prints it under the line. */
  gold?: import('@ebda/shared').PublicGoldPricing;
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
  /**
   * Units of this bundle's limiting component still purchasable — mirrors
   * `CartContext`'s `CartBundle.available` (#1555: this was dropped when
   * `CheckoutClient` built its bundle list off the cart context, so the
   * stock state the API already returns never reached checkout).
   */
  available: number;
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
