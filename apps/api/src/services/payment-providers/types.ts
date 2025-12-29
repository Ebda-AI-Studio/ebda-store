// ==========================================
// Payment Provider Types
// Common interfaces for all Kuwait payment gateways
// ==========================================

export type PaymentProvider = 'tap' | 'myfatoorah' | 'hesabe' | 'upayments';

export type PaymentMethod = 'knet' | 'visa' | 'mastercard' | 'amex' | 'mada' | 'apple_pay' | 'google_pay' | 'samsung_pay';

export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded' | 'partially_refunded' | 'cancelled' | 'expired';

export type Currency = 'KWD' | 'USD' | 'EUR' | 'GBP' | 'AED' | 'SAR' | 'BHD' | 'OMR' | 'QAR';

export interface CustomerInfo {
  id?: string;
  name: string;
  email: string;
  phone?: string;
  language?: 'en' | 'ar';
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  country: string;
  postalCode?: string;
}

export interface PaymentItem {
  name: string;
  description?: string;
  quantity: number;
  unitPrice: number; // In fils (1 KWD = 1000 fils)
  sku?: string;
}

export interface CreatePaymentRequest {
  orderId: string;
  orderNumber: string;
  amount: number; // In fils (1 KWD = 1000 fils)
  currency: Currency;
  customer: CustomerInfo;
  items?: PaymentItem[];
  shippingAddress?: Address;
  billingAddress?: Address;
  callbackUrl: string;
  errorUrl: string;
  webhookUrl?: string;
  metadata?: Record<string, string>;
}

export interface PaymentResponse {
  success: boolean;
  provider: PaymentProvider;
  transactionId: string;
  invoiceId?: string;
  paymentUrl: string;
  paymentMethods?: AvailablePaymentMethod[];
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface AvailablePaymentMethod {
  id: string | number;
  code: PaymentMethod | string;
  name: string;
  nameAr?: string;
  logo?: string;
  fee?: number;
  isDirectPayment?: boolean;
}

export interface PaymentStatusResponse {
  success: boolean;
  provider: PaymentProvider;
  transactionId: string;
  invoiceId?: string;
  status: PaymentStatus;
  amount: number;
  currency: Currency;
  paidAmount?: number;
  paidCurrency?: Currency;
  paymentMethod?: string;
  paidAt?: Date;
  failureReason?: string;
  refundedAmount?: number;
  metadata?: Record<string, unknown>;
}

export interface RefundRequest {
  transactionId: string;
  amount?: number; // Partial refund amount in fils
  reason?: string;
}

export interface RefundResponse {
  success: boolean;
  provider: PaymentProvider;
  refundId: string;
  transactionId: string;
  amount: number;
  status: 'pending' | 'completed' | 'failed';
  metadata?: Record<string, unknown>;
}

export interface WebhookPayload {
  provider: PaymentProvider;
  event: string;
  transactionId: string;
  invoiceId?: string;
  status: PaymentStatus;
  amount: number;
  currency: Currency;
  paymentMethod?: string;
  paidAt?: Date;
  rawPayload: unknown;
}

export interface PaymentProviderConfig {
  apiKey: string;
  secretKey?: string;
  merchantId?: string;
  baseUrl: string;
  isTestMode: boolean;
  webhookSecret?: string;
}

export interface IPaymentProvider {
  readonly name: PaymentProvider;

  /**
   * Initialize the payment provider
   */
  initialize(config: PaymentProviderConfig): void;

  /**
   * Create a new payment
   */
  createPayment(request: CreatePaymentRequest): Promise<PaymentResponse>;

  /**
   * Get payment status
   */
  getPaymentStatus(transactionId: string): Promise<PaymentStatusResponse>;

  /**
   * Process refund
   */
  refund(request: RefundRequest): Promise<RefundResponse>;

  /**
   * Verify webhook signature
   */
  verifyWebhook(payload: unknown, signature: string): boolean;

  /**
   * Parse webhook payload
   */
  parseWebhook(payload: unknown): WebhookPayload;

  /**
   * Get available payment methods
   */
  getPaymentMethods(amount: number, currency: Currency): Promise<AvailablePaymentMethod[]>;
}
