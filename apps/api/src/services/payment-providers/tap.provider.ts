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

// ==========================================
// Tap Payments Provider
// https://developers.tap.company/
// ==========================================

interface TapChargeResponse {
  id: string;
  status: string;
  amount: number;
  currency: string;
  transaction: {
    url: string;
    created: string;
    expiry: {
      period: number;
      type: string;
    };
  };
  redirect: {
    url: string;
  };
  customer: {
    id: string;
  };
  source: {
    id: string;
    payment_method: string;
  };
  metadata?: Record<string, string>;
}

interface TapRefundResponse {
  id: string;
  status: string;
  amount: number;
  currency: string;
  charge_id: string;
  reason: string;
  created: number;
}

export class TapPaymentProvider implements IPaymentProvider {
  readonly name = 'tap' as const;
  private config!: PaymentProviderConfig;

  initialize(config: PaymentProviderConfig): void {
    this.config = {
      ...config,
      baseUrl: config.isTestMode ? 'https://api.tap.company/v2' : 'https://api.tap.company/v2',
    };
  }

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'POST',
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

    const data = (await response.json()) as { errors?: { description: string }[] };

    if (!response.ok) {
      console.error('[TAP ERROR]', data);
      throw new Error(data.errors?.[0]?.description || 'Tap API request failed');
    }

    return data as T;
  }

  async createPayment(request: CreatePaymentRequest): Promise<PaymentResponse> {
    const amountInKWD = request.amount / 1000; // Convert fils to KWD

    const chargeData = {
      amount: amountInKWD,
      currency: request.currency,
      customer_initiated: true,
      threeDSecure: true,
      save_card: false,
      description: `Order #${request.orderNumber}`,
      metadata: {
        orderId: request.orderId,
        orderNumber: request.orderNumber,
        ...request.metadata,
      },
      receipt: {
        email: true,
        sms: !!request.customer.phone,
      },
      customer: {
        first_name: request.customer.name.split(' ')[0],
        last_name: request.customer.name.split(' ').slice(1).join(' ') || '',
        email: request.customer.email,
        phone: request.customer.phone
          ? {
              country_code: '965', // Kuwait
              number: request.customer.phone.replace(/^\+965/, ''),
            }
          : undefined,
      },
      source: { id: 'src_all' }, // Allow all payment methods
      redirect: {
        url: request.callbackUrl,
      },
      post: request.webhookUrl
        ? {
            url: request.webhookUrl,
          }
        : undefined,
    };

    const charge = await this.request<TapChargeResponse>('/charges', 'POST', chargeData);

    return {
      success: true,
      provider: 'tap',
      transactionId: charge.id,
      paymentUrl: charge.transaction.url,
      metadata: {
        customerId: charge.customer?.id,
        status: charge.status,
      },
    };
  }

  async getPaymentStatus(transactionId: string): Promise<PaymentStatusResponse> {
    const charge = await this.request<TapChargeResponse>(`/charges/${transactionId}`, 'GET');

    const statusMap: Record<string, PaymentStatus> = {
      INITIATED: 'pending',
      CAPTURED: 'completed',
      AUTHORIZED: 'processing',
      FAILED: 'failed',
      CANCELLED: 'cancelled',
      DECLINED: 'failed',
      RESTRICTED: 'failed',
      VOID: 'cancelled',
      TIMEDOUT: 'expired',
      UNKNOWN: 'pending',
    };

    return {
      success: true,
      provider: 'tap',
      transactionId: charge.id,
      status: statusMap[charge.status] || 'pending',
      amount: Math.round(charge.amount * 1000), // Convert to fils
      currency: charge.currency as Currency,
      paymentMethod: charge.source?.payment_method,
      paidAt: charge.status === 'CAPTURED' ? new Date() : undefined,
      metadata: charge.metadata,
    };
  }

  async refund(request: RefundRequest): Promise<RefundResponse> {
    const refundData: Record<string, unknown> = {
      charge_id: request.transactionId,
      reason: request.reason || 'requested_by_customer',
    };

    if (request.amount) {
      refundData.amount = request.amount / 1000; // Convert fils to KWD
    }

    const refund = await this.request<TapRefundResponse>('/refunds', 'POST', refundData);

    return {
      success: refund.status === 'PENDING' || refund.status === 'CAPTURED',
      provider: 'tap',
      refundId: refund.id,
      transactionId: refund.charge_id,
      amount: Math.round(refund.amount * 1000),
      status: refund.status === 'CAPTURED' ? 'completed' : 'pending',
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
      id: string;
      object: string;
      status: string;
      amount: number;
      currency: string;
      source?: { payment_method?: string };
      metadata?: Record<string, string>;
    };

    const statusMap: Record<string, PaymentStatus> = {
      CAPTURED: 'completed',
      FAILED: 'failed',
      CANCELLED: 'cancelled',
      REFUNDED: 'refunded',
    };

    return {
      provider: 'tap',
      event: data.object,
      transactionId: data.id,
      status: statusMap[data.status] || 'pending',
      amount: Math.round(data.amount * 1000),
      currency: data.currency as Currency,
      paymentMethod: data.source?.payment_method,
      paidAt: data.status === 'CAPTURED' ? new Date() : undefined,
      rawPayload: payload,
    };
  }

  async getPaymentMethods(_amount: number, currency: Currency): Promise<AvailablePaymentMethod[]> {
    // Tap uses source IDs for payment methods
    const methods: AvailablePaymentMethod[] = [
      { id: 'src_kw.knet', code: 'knet', name: 'KNET', nameAr: 'كي نت' },
      { id: 'src_visamastercard', code: 'visa', name: 'Visa/Mastercard', nameAr: 'فيزا/ماستركارد' },
      { id: 'src_apple_pay', code: 'apple_pay', name: 'Apple Pay', nameAr: 'آبل باي' },
      { id: 'src_google_pay', code: 'google_pay', name: 'Google Pay', nameAr: 'جوجل باي' },
      { id: 'src_samsung_pay', code: 'samsung_pay', name: 'Samsung Pay', nameAr: 'سامسونج باي' },
    ];

    // Filter based on currency
    if (currency === 'KWD') {
      return methods;
    }

    // Remove KNET for non-KWD currencies
    return methods.filter(m => m.code !== 'knet');
  }
}
