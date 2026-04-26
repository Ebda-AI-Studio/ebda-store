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
    images?: Array<{ url: string; alt?: string | null }>;
  };
}

export interface OrderPaymentDetail {
  id: string;
  provider: string;
  status: string;
  amount: number;
  paymentLink?: string | null;
  createdAt: string;
}

export interface OrderDetail {
  id: string;
  storeId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  subtotal: number;
  tax: number;
  shipping: number;
  discount: number;
  total: number;
  currency: string;
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
