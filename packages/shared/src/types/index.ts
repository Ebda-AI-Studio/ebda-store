// Shared Types

// Store Theme & Template Types
export * from './store-theme';

// Store Layout Settings (Demo Store-style flow toggles)
export * from './store-layout';

// Per-template branded layout baselines (Brand Engine Phase 2)
export * from './template-baselines';

// Per-store typography overrides
export * from './typography';

// Canonical image-asset sizes (single source of truth for design.md +
// admin "Recommended size" hints + future server-side validators).
export * from './image-standards';

// Engagement: floating action button widget (super-admin opt-in via
// the `floating_widget` feature flag; per-store config on
// `Store.settings.floatingWidget`).
export * from './floating-widget';

// AI autofill field registry — which Product fields the engine manages,
// their source dependencies, and provenance helpers.
export * from './ai-autofill';

// API Response Types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: PaginationMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// User Types
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: UserRole;
  createdAt: Date | string;
  updatedAt?: Date | string;
}

export type UserRole = 'customer' | 'store_admin' | 'super_admin' | 'staff';

// Store Types
export interface Store {
  id: string;
  name: string;
  slug: string;
  domain?: string | null;
  logo?: string;
  ownerId?: string;
  status: StoreStatus;
  plan?: StorePlan;
  settings?: StoreSettings | Record<string, unknown>;
  enabledFeatures?: string[];
  owner?: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  _count?: {
    products: number;
    orders: number;
    customers?: number;
  };
  stats?: {
    revenue: number;
    ordersThisMonth: number;
  };
  createdAt: Date | string;
  updatedAt?: Date | string;
}

export type StoreStatus = 'active' | 'inactive' | 'suspended';

export type StorePlan = 'free' | 'starter' | 'professional' | 'enterprise';

export interface StoreSettings {
  currency: string;
  timezone: string;
  locale: string;
  theme: string;
  /**
   * Optional, opt-in: when set to a valid email, every order placed in this
   * store auto-emails the rendered invoice to this address (e.g. the store
   * owner). Empty/unset = no owner invoice email is sent. Per-store — only
   * stores that configure it receive it.
   *
   * `null` is the CLEARED form: the admin sends an explicit null when the
   * merchant empties the field, because an omitted key would be preserved by
   * the server's shallow `settings` merge (the merchant could never turn the
   * invoice emails off). Readers treat null exactly like unset.
   */
  orderInvoiceEmail?: string | null;
  /**
   * Optional, opt-in per-store checkout "delivery" block: a merchant-written
   * bilingual note plus a set of merchant-configured delivery time windows
   * the customer picks from. Both parts toggle independently. Platform-level
   * — any store can enable it via this config, never a hardcoded slug.
   */
  checkoutDelivery?: CheckoutDeliverySettings;
  /**
   * Optional store-wide delivery estimate in BUSINESS days (the `deliveryOffDays` skipped, Friday by default), integers 0-30,
   * min <= max. The PDP "delivers by" chip uses it only when no active shipping zone carries
   * day numbers (area-rate stores). `null` is the CLEARED form: the server's settings merge is
   * shallow, so the admin sends an explicit null to remove it (same as `orderInvoiceEmail`).
   */
  deliveryDays?: { min: number; max: number } | null;
  /**
   * Optional per-store courier calendar: weekdays with NO delivery, `Date#getUTCDay` numbers
   * (0=Sun ... 6=Sat). Unset/null = Friday only; `[]` = delivers every day; unique ints, at
   * most 6 (one working day minimum). Applies to the delivery estimate for zones AND the
   * `deliveryDays` fallback. `null` clears (shallow settings merge), like `deliveryDays`.
   */
  deliveryOffDays?: number[] | null;
  /**
   * Optional merchant-configured instalment display on the PDP (Ruling B2-9): arithmetic over
   * these settings, shown as an estimate, never a payment method. `null` clears (shallow merge).
   */
  instalments?: import('../commerce/instalments').Instalments | null;
  /**
   * Optional, opt-in per-store minimum order value in PIASTRES (1 EGP = 1000
   * piastres). When set to a positive number, a customer cannot place an order
   * whose items subtotal (before shipping/tax) falls below it. `0` or
   * unset = no minimum. Platform-level — any store can enable it via this
   * config, never a hardcoded slug. Enforced server-side in
   * `OrderService.create`; the storefront cart/checkout surfaces mirror
   * the same rule for UX (disable the checkout CTA) but the API check is
   * the real guard.
   */
  minimumOrderFils?: number;
}

/**
 * Per-store checkout delivery block config (`Store.settings.checkoutDelivery`).
 * Storefront shows this immediately above the checkout Pay button; the
 * customer's window choice is persisted onto the order's `notes` field
 * (no dedicated DB column). See apps/web checkout + apps/admin
 * /stores/[id]/delivery for the two surfaces that read/write this.
 */
export interface CheckoutDeliverySettings {
  /** Merchant-written informational note shown to the customer. */
  note: {
    enabled: boolean;
    text: string;
    textAr: string;
  };
  /** Merchant-configured delivery time windows the customer picks one from. */
  windows: {
    enabled: boolean;
    items: CheckoutDeliveryWindow[];
  };
}

/** A single merchant-configured delivery time window. */
export interface CheckoutDeliveryWindow {
  id: string;
  label: string;
  labelAr: string;
  /** 24h "HH:mm", store-local time. */
  start: string;
  /** 24h "HH:mm", store-local time. */
  end: string;
  /**
   * Optional 24h "HH:mm", store-local time — the last moment a customer can
   * order for this window today. Falls back to `start` when unset/empty,
   * preserving the platform's original "window closes at start" behavior.
   */
  orderBy?: string;
}

// Category Types
export interface Category {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  description?: string | null;
  descriptionAr?: string | null;
  image?: string | null;
  isActive?: boolean;
  sortOrder?: number;
  productCount?: number;
  _count?: { products: number };
}

// Product Types
export interface ProductImage {
  id: string;
  url: string;
  alt?: string;
  position: number;
}

export interface ProductCategory {
  id?: string;
  categoryId?: string;
  category: {
    id: string;
    name: string;
    nameAr?: string;
    slug?: string;
  };
}

export interface ProductTag {
  tagId?: string;
  tag: {
    id: string;
    name: string;
  };
}

export interface ProductVariant {
  id: string;
  name?: string;
  sku?: string;
  price: number;
  compareAtPrice?: number;
  inventory?: number;
  options: Record<string, string>;
}

export interface ProductOption {
  id: string;
  name: string;
  values: string[];
}

/**
 * Hard cap on a merchant-authored product card badge label, in characters,
 * applied AFTER trimming.
 *
 * One number, three enforcement points — DB (`products.badge_label
 * VARCHAR(32)`), API Zod (`product.routes.ts`), admin input `maxLength` —
 * because a cap that lives only in the form is a suggestion. A badge is a
 * chip on a product card ("Offer", "عرض"), never a sentence: an unbounded
 * label breaks the layout on all eight card render paths at once.
 */
export const PRODUCT_BADGE_LABEL_MAX_LENGTH = 32;

export interface Product {
  id: string;
  storeId?: string;
  name: string;
  nameAr?: string;
  slug: string;
  description?: string;
  descriptionAr?: string;
  price: number;
  compareAtPrice?: number | null;
  costPrice?: number | null;
  /** Stored discount type — 'percentage' | 'fixed'. null = no admin-authored discount. */
  discountType?: 'percentage' | 'fixed' | null;
  /** Stored discount value — basis points for percentage, piastres for fixed. null when no discount. */
  discountValue?: number | null;
  sku?: string | null;
  barcode?: string;
  inventory: number;
  lowStockThreshold?: number;
  trackInventory?: boolean;
  status: ProductStatus;
  isFeatured?: boolean;
  isNew?: boolean;
  /**
   * Merchant-authored free-text card badge (EN). `null`/absent renders
   * nothing — the badge does not exist until a merchant types a label.
   * Capped at PRODUCT_BADGE_LABEL_MAX_LENGTH after trimming.
   */
  badgeLabel?: string | null;
  /**
   * Arabic counterpart of `badgeLabel`, same convention as `nameAr` /
   * `descriptionAr`. Either side alone is enough: the storefront prefers the
   * current locale's value and falls back to the other, so a merchant who
   * fills only one language still gets a badge in both.
   */
  badgeLabelAr?: string | null;
  hasVariants?: boolean;
  weight?: number;
  images: ProductImage[];
  categories?: ProductCategory[] | string[];
  tags?: ProductTag[] | string[];
  variants?: ProductVariant[];
  options?: ProductOption[];
  store?: { id: string; name: string; slug: string };
  createdAt: Date | string;
  updatedAt?: Date | string;
}

export type ProductStatus = 'draft' | 'active' | 'archived';

// Cart Types
export interface Cart {
  id: string;
  storeId?: string;
  customerId?: string;
  sessionId?: string;
  items: CartItem[];
  subtotal: number;
  total?: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface CartItem {
  id: string;
  productId: string;
  quantity: number;
  price: number;
  product?: Product;
}

// Order Types
export interface OrderCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface Order {
  id: string;
  storeId?: string;
  customerId?: string;
  orderNumber?: string;
  status: OrderStatus;
  paymentStatus?: string;
  items?: OrderItem[];
  customer?: OrderCustomer;
  subtotal?: number;
  tax?: number;
  shipping?: number;
  total: number;
  shippingAddress?: Address | Record<string, string>;
  billingAddress?: Address | Record<string, string>;
  paymentMethod?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  createdAt: Date | string;
  updatedAt?: Date | string;
}

export type OrderStatus =
  | 'pending'
  | 'awaiting_payment_confirmation'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded';

export interface OrderItem {
  id: string;
  productId: string;
  productName?: string;
  quantity: number;
  price: number;
  product?: Product;
}

export interface Address {
  firstName: string;
  lastName: string;
  company?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
}
