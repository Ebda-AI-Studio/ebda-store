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
