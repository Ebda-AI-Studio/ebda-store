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
