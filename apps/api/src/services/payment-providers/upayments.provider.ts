import crypto from 'crypto';
import {
  IPaymentProvider,
  PaymentProviderConfig,
  CreatePaymentRequest,
  PaymentResponse,
  PaymentStatusResponse,
  RefundRequest,
  RefundResponse,
  WebhookPayload,
  AvailablePaymentMethod,
  Currency,
  PaymentStatus,
} from './types';
import logger from '../../lib/logger';

// ==========================================
// UPayments Provider
// https://upayments.com/
// ==========================================

interface UPaymentsCreateResponse {
  status: string;
  message: string;
  data: {
    link: string;
    invoice_id: string;
    order_id: string;
  };
}

interface UPaymentsStatusResponse {
  status: string;
  data: {
    invoice_id: string;
    order_id: string;
    payment_status: string;
    amount: number;
    currency: string;
    customer_name: string;
    customer_email: string;
    customer_phone: string;
    payment_type: string;
    transaction_id: string;
    paid_at: string | null;
  };
}

interface UPaymentsRefundResponse {
  status: string;
  message: string;
  data: {
    refund_id: string;
    amount: number;
    status: string;
  };
}

export class UPaymentsProvider implements IPaymentProvider {
  readonly name = 'upayments' as const;
  private config!: PaymentProviderConfig;

  initialize(config: PaymentProviderConfig): void {
    this.config = {
      ...config,
      baseUrl: config.isTestMode
        ? 'https://sandboxapi.upayments.com/api/v1'
        : 'https://api.upayments.com/api/v1',
    };
  }

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'POST',
    body?: object
  ): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await response.json()) as { status?: string; message?: string };

    if (!response.ok || data.status === 'error') {
      logger.error(
        { statusCode: response.status, message: data.message },
        'UPayments API request failed'
      );
      throw new Error(data.message || 'UPayments API request failed');
    }

    return data as T;
  }

  async createPayment(request: CreatePaymentRequest): Promise<PaymentResponse> {
    const amountInKWD = request.amount / 1000; // Convert fils to KWD

    const paymentData = {
      merchant_id: this.config.merchantId,
      username: this.config.apiKey,
      password: this.config.secretKey,
      api_key: this.config.apiKey,
      order_id: request.orderNumber,
      total_price: amountInKWD,
      currency_code: request.currency,
      success_url: request.callbackUrl,
      error_url: request.errorUrl,
      test_mode: this.config.isTestMode ? 1 : 0,
      customer_name: request.customer.name,
      customer_email: request.customer.email,
      customer_mobile: request.customer.phone,
      payment_gateway: 'knet', // Default to KNET
      whitelabled: true,
      payment_methods: ['knet', 'cc'], // KNET and Credit Cards
      reference: {
        id: request.orderId,
      },
      product_title: `Order #${request.orderNumber}`,
      product_name: request.items?.map(i => i.name).join(', ') || `Order #${request.orderNumber}`,
      product_price: request.items?.map(i => ({
        name: i.name,
        qty: i.quantity,
        price: i.unitPrice / 1000,
      })),
      notifications: {
        emails: [request.customer.email],
        mobiles: request.customer.phone ? [request.customer.phone] : [],
      },
    };

    const result = await this.request<UPaymentsCreateResponse>(
      '/create-payment',
      'POST',
      paymentData
    );

    return {
      success: result.status === 'success',
      provider: 'upayments',
      transactionId: result.data.invoice_id,
      invoiceId: result.data.invoice_id,
      paymentUrl: result.data.link,
      metadata: {
        orderId: result.data.order_id,
      },
    };
  }

  async getPaymentStatus(transactionId: string): Promise<PaymentStatusResponse> {
    const response = await this.request<UPaymentsStatusResponse>(
      `/get-payment-status/${transactionId}`,
      'GET'
    );

    const data = response.data;

    const statusMap: Record<string, PaymentStatus> = {
      success: 'completed',
      paid: 'completed',
      failed: 'failed',
      pending: 'pending',
      cancelled: 'cancelled',
      expired: 'expired',
    };

    return {
      success: true,
      provider: 'upayments',
      transactionId: data.invoice_id,
      invoiceId: data.invoice_id,
      status: statusMap[data.payment_status.toLowerCase()] || 'pending',
      amount: Math.round(data.amount * 1000),
      currency: data.currency as Currency,
      paymentMethod: data.payment_type,
      paidAt: data.paid_at ? new Date(data.paid_at) : undefined,
      metadata: {
        orderId: data.order_id,
        transactionId: data.transaction_id,
      },
    };
  }

  async refund(request: RefundRequest): Promise<RefundResponse> {
    const refundData: Record<string, unknown> = {
      invoice_id: request.transactionId,
      reason: request.reason || 'Customer requested refund',
    };

    if (request.amount) {
      refundData.amount = request.amount / 1000;
    }

    const response = await this.request<UPaymentsRefundResponse>(
      '/create-refund',
      'POST',
      refundData
    );

    return {
      success: response.status === 'success',
      provider: 'upayments',
      refundId: response.data.refund_id,
      transactionId: request.transactionId,
      amount: Math.round(response.data.amount * 1000),
      status: response.data.status === 'success' ? 'completed' : 'pending',
    };
  }

  verifyWebhook(payload: unknown, signature: string): boolean {
    if (!this.config.webhookSecret) return false;

    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const expectedSignature = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(payloadString)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  }

  parseWebhook(payload: unknown): WebhookPayload {
    const data = payload as {
      event: string;
      invoice_id: string;
      order_id: string;
      payment_status: string;
      amount: number;
      currency: string;
      payment_type: string;
      paid_at: string | null;
    };

    const statusMap: Record<string, PaymentStatus> = {
      success: 'completed',
      paid: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
    };

    return {
      provider: 'upayments',
      event: data.event,
      transactionId: data.invoice_id,
      invoiceId: data.invoice_id,
      status: statusMap[data.payment_status.toLowerCase()] || 'pending',
      amount: Math.round(data.amount * 1000),
      currency: data.currency as Currency,
      paymentMethod: data.payment_type,
      paidAt: data.paid_at ? new Date(data.paid_at) : undefined,
      rawPayload: payload,
    };
  }

  async getPaymentMethods(_amount: number, currency: Currency): Promise<AvailablePaymentMethod[]> {
    const methods: AvailablePaymentMethod[] = [
      { id: 'knet', code: 'knet', name: 'KNET', nameAr: 'كي نت' },
      { id: 'cc', code: 'visa', name: 'Credit Card', nameAr: 'بطاقة ائتمان' },
      { id: 'samsung_pay', code: 'samsung_pay', name: 'Samsung Pay', nameAr: 'سامسونج باي' },
      { id: 'apple_pay', code: 'apple_pay', name: 'Apple Pay', nameAr: 'آبل باي' },
      { id: 'google_pay', code: 'google_pay', name: 'Google Pay', nameAr: 'جوجل باي' },
    ];

    // KNET only works with KWD
    if (currency !== 'KWD') {
      return methods.filter(m => m.code !== 'knet');
    }

    return methods;
  }
}
