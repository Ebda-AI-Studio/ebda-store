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
// Hesabe Payment Provider
// https://www.hesabe.com/
// ==========================================

interface HesabeCheckoutResponse {
  status: boolean;
  code: string;
  message: string;
  response: {
    data: string; // Encrypted response
  };
}

interface HesabeDecryptedCheckout {
  token: string;
  paymentId: string;
  checkoutUrl: string;
}

interface HesabePaymentStatus {
  status: boolean;
  response: {
    resultCode: string;
    paymentId: string;
    orderReferenceNumber: string;
    amount: number;
    variable1: string;
    variable2: string;
    variable3: string;
    variable4: string;
    variable5: string;
    paymentType: string;
  };
}

export class HesabePaymentProvider implements IPaymentProvider {
  readonly name = 'hesabe' as const;
  private config!: PaymentProviderConfig;
  private ivKey = ''; // Provided by Hesabe
  private encryptionKey = ''; // Provided by Hesabe

  initialize(config: PaymentProviderConfig): void {
    this.config = {
      ...config,
      baseUrl: config.isTestMode ? 'https://sandbox.hesabe.com' : 'https://api.hesabe.com',
    };

    // Parse secret key for IV and encryption key
    // Format: "ivKey:encryptionKey"
    if (config.secretKey) {
      const [iv, key] = config.secretKey.split(':');
      this.ivKey = iv;
      this.encryptionKey = key;
    }
  }

  private encrypt(data: object): string {
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      Buffer.from(this.encryptionKey, 'utf8'),
      Buffer.from(this.ivKey, 'utf8')
    );

    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
    encrypted += cipher.final('base64');

    return encrypted;
  }

  private decrypt(data: string): object {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(this.encryptionKey, 'utf8'),
      Buffer.from(this.ivKey, 'utf8')
    );

    let decrypted = decipher.update(data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted);
  }

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'POST',
    body?: object
  ): Promise<T> {
    const encryptedData = body ? this.encrypt(body) : undefined;

    const response = await fetch(`${this.config.baseUrl}${endpoint}`, {
      method,
      headers: {
        accessCode: this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: encryptedData ? JSON.stringify({ data: encryptedData }) : undefined,
      // A hung provider request must degrade exactly like a network error
      // (fail-soft catch upstream), not hang the checkout indefinitely.
      signal: AbortSignal.timeout(8000),
    });

    const result = (await response.json()) as HesabeCheckoutResponse;

    if (!response.ok || !result.status) {
      logger.error(
        { statusCode: response.status, code: result.code, message: result.message },
        'Hesabe API request failed'
      );
      throw new Error(result.message || 'Hesabe API request failed');
    }

    // Decrypt response if it contains encrypted data
    if (result.response?.data) {
      return this.decrypt(result.response.data) as T;
    }

    return result as unknown as T;
  }

  async createPayment(request: CreatePaymentRequest): Promise<PaymentResponse> {
    const amountInKWD = request.amount / 1000; // Convert fils to KWD

    const checkoutData = {
      merchantCode: this.config.merchantId,
      amount: amountInKWD,
      paymentType: 0, // 0 = All payment types
      responseUrl: request.callbackUrl,
      failureUrl: request.errorUrl,
      orderReferenceNumber: request.orderNumber,
      variable1: request.orderId,
      variable2: request.customer.email,
      variable3: request.customer.name,
      variable4: request.customer.phone || '',
      variable5: JSON.stringify(request.metadata || {}),
    };

    const result = await this.request<HesabeDecryptedCheckout>('/checkout', 'POST', checkoutData);

    return {
      success: true,
      provider: 'hesabe',
      transactionId: result.paymentId,
      paymentUrl: result.checkoutUrl,
      metadata: {
        token: result.token,
      },
    };
  }

  async getPaymentStatus(transactionId: string): Promise<PaymentStatusResponse> {
    const response = await this.request<HesabePaymentStatus>('/payment/status', 'POST', {
      paymentId: transactionId,
    });

    const data = response.response;

    // Hesabe result codes
    const statusMap: Record<string, PaymentStatus> = {
      CAPTURED: 'completed',
      NOT_CAPTURED: 'failed',
      CANCELLED: 'cancelled',
      PENDING: 'pending',
    };

    return {
      success: true,
      provider: 'hesabe',
      transactionId: data.paymentId,
      status: statusMap[data.resultCode] || 'pending',
      amount: Math.round(data.amount * 1000),
      currency: 'KWD' as Currency,
      paymentMethod: data.paymentType,
      paidAt: data.resultCode === 'CAPTURED' ? new Date() : undefined,
      metadata: {
        orderReferenceNumber: data.orderReferenceNumber,
        variable1: data.variable1,
        variable2: data.variable2,
      },
    };
  }

  async refund(request: RefundRequest): Promise<RefundResponse> {
    const refundData = {
      paymentId: request.transactionId,
      amount: request.amount ? request.amount / 1000 : undefined,
      reason: request.reason || 'Customer requested refund',
    };

    const response = await this.request<{
      status: boolean;
      refundId: string;
      amount: number;
    }>('/refund', 'POST', refundData);

    return {
      success: response.status,
      provider: 'hesabe',
      refundId: response.refundId,
      transactionId: request.transactionId,
      amount: Math.round(response.amount * 1000),
      status: response.status ? 'completed' : 'failed',
    };
  }

  verifyWebhook(payload: unknown, signature: string): boolean {
    if (!this.config.webhookSecret) return false;

    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const expectedSignature = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(payloadString)
      .digest('hex');

    // Same-length guard (parity with Tap) — timingSafeEqual THROWS a RangeError
    // on unequal-length buffers, so a malformed/probe/rotated-secret signature
    // would 500 the webhook instead of cleanly returning false.
    if (signature.length !== expectedSignature.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  }

  parseWebhook(payload: unknown): WebhookPayload {
    // Hesabe sends encrypted webhook data
    const data = this.decrypt((payload as { data: string }).data) as {
      paymentId: string;
      resultCode: string;
      amount: number;
      paymentType: string;
      orderReferenceNumber: string;
    };

    const statusMap: Record<string, PaymentStatus> = {
      CAPTURED: 'completed',
      NOT_CAPTURED: 'failed',
      CANCELLED: 'cancelled',
    };

    return {
      provider: 'hesabe',
      event: 'payment',
      transactionId: data.paymentId,
      status: statusMap[data.resultCode] || 'pending',
      amount: Math.round(data.amount * 1000),
      currency: 'KWD' as Currency,
      paymentMethod: data.paymentType,
      paidAt: data.resultCode === 'CAPTURED' ? new Date() : undefined,
      rawPayload: payload,
    };
  }

  async getPaymentMethods(_amount: number, _currency: Currency): Promise<AvailablePaymentMethod[]> {
    // Hesabe payment methods
    return [
      {
        id: 1,
        code: 'knet',
        name: 'KNET',
        nameAr: 'كي نت',
        logo: 'https://www.hesabe.com/images/knet.png',
      },
      {
        id: 2,
        code: 'visa',
        name: 'Visa',
        nameAr: 'فيزا',
        logo: 'https://www.hesabe.com/images/visa.png',
      },
      {
        id: 3,
        code: 'mastercard',
        name: 'Mastercard',
        nameAr: 'ماستركارد',
        logo: 'https://www.hesabe.com/images/mastercard.png',
      },
      {
        id: 7,
        code: 'apple_pay',
        name: 'Apple Pay',
        nameAr: 'آبل باي',
        logo: 'https://www.hesabe.com/images/applepay.png',
      },
      {
        id: 8,
        code: 'samsung_pay',
        name: 'Samsung Pay',
        nameAr: 'سامسونج باي',
        logo: 'https://www.hesabe.com/images/samsungpay.png',
      },
    ];
  }
}
