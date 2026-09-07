export interface AddressJson {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  country?: string;
  city?: string;
  area?: string;
  block?: string;
  street?: string;
  avenue?: string;
  house?: string;
  building?: string;
  floor?: string;
  apartment?: string;
  notes?: string;
  // Governorate (top-level KW administrative division) — added 2026-06-18.
  governorate?: string;
  governorateAr?: string;
  // Bilingual fallback fields stored as the customer entered them
  cityAr?: string;
  areaAr?: string;
  streetAr?: string;
}

export interface OrderItemDetail {
  id: string;
  productId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  price: number;
  total: number;
  product?: {
    id: string;
    // Arabic product name from the live product (order_items only snapshots
    // the English productName); used to localize the item label in RTL.
    nameAr?: string | null;
    images?: Array<{ url: string; alt?: string | null }>;
  };
  /**
   * I6 (final review): bundle-expansion tags. A bundle purchase expands into
   * one `OrderItem` per component at checkout, all sharing one `bundleGroupId`
   * per box (never per bundle-in-cart — two boxes of the same bundle produce
   * TWO groups). `bundleName`/`bundleNameAr` are snapshotted at checkout time
   * like `productName`, so a renamed/deleted bundle still shows the name the
   * customer actually bought. Unlike the storefront's `groupOrderLinesForDisplay`
   * (which COLLAPSES a group into one row), the admin order screen must keep
   * every component line visible — the merchant fulfilling the order needs to
   * know what to physically put in the box — and only GROUP + LABEL them under
   * the bundle name.
   */
  bundleGroupId?: string | null;
  bundleName?: string | null;
  bundleNameAr?: string | null;
}

export interface OrderPaymentDetail {
  id: string;
  provider: string;
  /** Specific method within the provider (e.g. knet, visa, mastercard). */
  method?: string | null;
  status: string;
  amount: number;
  /** Provider-side transaction id, useful for reconciliation. */
  transactionId?: string | null;
  /** Provider's hosted-checkout URL (MyFatoorah / Tap / Hesabe / UPayments).
   *  Set by PaymentService.createPayment + persisted on the Payment row
   *  via the Prisma `payment_url` column. */
  paymentUrl?: string | null;
  /** Legacy alias for paymentUrl kept for backwards compatibility. */
  paymentLink?: string | null;
  createdAt: string;
}

export interface OrderDetail {
  id: string;
  storeId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  /**
   * Order provenance — 'web' (human checkout, default) | 'agent' (placed by
   * an AI agent via the MCP `place_order` tool). Nullable/optional because
   * pre-migration rows and any consumer that doesn't select it may omit it;
   * treat missing as 'web'. Surfaced on this page via PlatformCard + the
   * status pill row (agent badge) — every-data-needs-a-UI.
   */
  source?: string | null;
  subtotal: number;
  tax: number;
  shipping: number;
  discount: number;
  total: number;
  currency: string;
  couponCode?: string | null;
  couponDiscount?: number;
  /** The automatic-promotion portion of `discount` (0 when a coupon — not a
   *  promotion — was the winning lever, or when no discount applied). */
  promotionDiscount?: number;
  /** The promotion that discounted this order, when `promotionDiscount` > 0.
   *  Null when a coupon (or nothing) was the winning lever. */
  appliedPromotion?: { id: string; name: string; nameAr?: string | null } | null;
  /**
   * Reporting-only: Σ(componentSum − bundlePrice) across every bundle box in
   * the order. Unlike `couponDiscount`/`promotionDiscount`, this is NOT a
   * component of `discount` — the saving is already reflected in a lower
   * `subtotal` (a bundle is priced at `bundlePrice`, never `componentSum`),
   * so it must never be subtracted from anything here; it is shown purely so
   * the merchant can see how much a customer saved by buying the bundle.
   */
  bundleDiscount?: number;
  notes: string | null;
  customerNotes: string | null;
  shippingAddress: AddressJson | null;
  billingAddress: AddressJson | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  customer?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
  } | null;
  items: OrderItemDetail[];
  payments: OrderPaymentDetail[];
}
