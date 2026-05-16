// ==========================================
// Payment Provider Types
// Common interfaces for all Kuwait payment gateways
// ==========================================

export type PaymentProvider = 'tap' | 'myfatoorah' | 'hesabe' | 'upayments' | 'cod';

export type PaymentMethod =
  | 'knet'
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'mada'
  | 'apple_pay'
  | 'google_pay'
  | 'samsung_pay';

export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'cancelled'
  | 'expired'
  | 'cod_pending';

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
  /**
   * Optional channels the provider should use to notify the customer
   * about the generated payment URL. Defaults to 'link' (just return
   * the URL, no provider-side send). MyFatoorah supports this natively
   * via `NotificationOption`; other providers may ignore it.
   *
   *   - 'link': return URL only, merchant copies/shares manually
   *   - 'email': provider sends email with the link
   *   - 'all': provider sends via every available channel
   *
   * SMS intentionally NOT exposed yet (Ahmad 2026-05-16).
   */
  notifyVia?: 'link' | 'email' | 'all';
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

export interface RefundStatusResponse {
  success: boolean;
  provider: PaymentProvider;
  refundId: string;
  /** Normalized status across providers. MyFatoorah's "Refunded" =>
   *  completed, "Pending" => pending, "Canceled" => failed. */
  status: 'pending' | 'completed' | 'failed';
  amount?: number;
  refundedAmount?: number;
  refundReference?: string;
  /** Original provider response for debugging / portal cross-reference. */
  raw?: Record<string, unknown>;
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
  /** Set when the webhook event is a refund status change rather than
   *  a payment status change. handleWebhook routes refund events to a
   *  separate code path that updates Payment.metadata.refundStatus
   *  without re-mutating the order's payment lifecycle. */
  refund?: {
    /** Provider's own refund ID (RefundId for MyFatoorah). Maps to
     *  Payment.refundId we saved when MakeRefund returned. */
    refundId: string;
    refundReference?: string;
    /** Normalized refund status: completed = funds returned to customer's
     *  card; pending = queued (MyFatoorah finance team); failed = canceled. */
    status: 'pending' | 'completed' | 'failed';
    /** Refund amount in fils. */
    amount?: number;
  };
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
   * Look up refund status (for providers whose refunds are not instant —
   * MyFatoorah queues refunds for finance team review). Returns the
   * latest status of the refund identified by `refundId` (provider's own
   * refund ID, NOT our internal Payment.id). Optional — providers whose
   * refunds settle synchronously may not implement this.
   */
  getRefundStatus?(refundId: string): Promise<RefundStatusResponse>;

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
