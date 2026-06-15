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
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}
export type UserRole = 'customer' | 'store_admin' | 'super_admin' | 'staff';
export interface Store {
  id: string;
  name: string;
  slug: string;
  domain?: string;
  ownerId: string;
  status: StoreStatus;
  settings: StoreSettings;
  createdAt: Date;
  updatedAt: Date;
}
export type StoreStatus = 'active' | 'inactive' | 'suspended';
export interface StoreSettings {
  currency: string;
  timezone: string;
  locale: string;
  theme: string;
}
export interface Product {
  id: string;
  storeId: string;
  name: string;
  slug: string;
  description: string;
  price: number;
  compareAtPrice?: number;
  sku?: string;
  inventory: number;
  status: ProductStatus;
  images: ProductImage[];
  categories: string[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}
export type ProductStatus = 'draft' | 'active' | 'archived';
export interface ProductImage {
  id: string;
  url: string;
  alt: string;
  position: number;
}
export interface Cart {
  id: string;
  storeId: string;
  customerId?: string;
  sessionId: string;
  items: CartItem[];
  subtotal: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface CartItem {
  id: string;
  productId: string;
  quantity: number;
  price: number;
}
export interface Order {
  id: string;
  storeId: string;
  customerId: string;
  orderNumber: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
  shippingAddress: Address;
  billingAddress: Address;
  paymentMethod: string;
  createdAt: Date;
  updatedAt: Date;
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
  productName: string;
  quantity: number;
  price: number;
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
//# sourceMappingURL=index.d.ts.map
