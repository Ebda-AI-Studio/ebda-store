// Shared Types

// Store Theme & Template Types
export * from './store-theme';

// Store Layout Settings (Pecannbee-style flow toggles)
export * from './store-layout';

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

export type UserRole = 'customer' | 'store_admin' | 'super_admin';

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

export interface Product {
  id: string;
  storeId?: string;
  name: string;
  nameAr?: string;
  slug: string;
  description?: string;
  descriptionAr?: string;
  price: number;
  compareAtPrice?: number;
  costPrice?: number;
  sku?: string | null;
  barcode?: string;
  inventory: number;
  lowStockThreshold?: number;
  trackInventory?: boolean;
  status: ProductStatus;
  isFeatured?: boolean;
  isNew?: boolean;
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
