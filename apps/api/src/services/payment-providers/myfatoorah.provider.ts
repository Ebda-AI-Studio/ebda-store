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
// MyFatoorah Payment Provider
// https://docs.myfatoorah.com/
// ==========================================

interface MyFatoorahPaymentMethod {
  PaymentMethodId: number;
  PaymentMethodAr: string;
  PaymentMethodEn: string;
  PaymentMethodCode: string;
  IsDirectPayment: boolean;
  ServiceCharge: number;
  TotalAmount: number;
  CurrencyIso: string;
  ImageUrl: string;
}

interface MyFatoorahExecuteResponse {
  IsSuccess: boolean;
  Message: string;
  ValidationErrors: Array<{ Name: string; Error: string }> | null;
  Data: {
    InvoiceId: number;
    InvoiceURL: string;
    CustomerReference: string;
  };
}

interface MyFatoorahStatusResponse {
  IsSuccess: boolean;
  Data: {
    InvoiceId: number;
    InvoiceStatus: 'Pending' | 'Paid' | 'Failed' | 'Expired';
    InvoiceReference: string;
    CustomerReference: string;
    InvoiceValue: number;
    CustomerName: string;
    CustomerMobile: string;
    CustomerEmail: string;
    TransactionStatus: string;
    PaymentMethod: string;
    PaymentId: string;
    PaidCurrency: string;
    PaidCurrencyValue: number;
    InvoiceTransactions: Array<{
      TransactionStatus: string;
      PaymentId: string;
      AuthorizationId: string;
      TransactionValue: number;
      Currency: string;
    }>;
  };
}

interface MyFatoorahRefundResponse {
  IsSuccess: boolean;
  Data: {
    Key: string;
    RefundId: number;
    Amount: number;
    RefundReference: string;
  };
}

export class MyFatoorahPaymentProvider implements IPaymentProvider {
  readonly name = 'myfatoorah' as const;
  private config!: PaymentProviderConfig;

  initialize(config: PaymentProviderConfig): void {
    this.config = {
      ...config,
      baseUrl: config.isTestMode ? 'https://apitest.myfatoorah.com' : 'https://api.myfatoorah.com',
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

    const data = (await response.json()) as {
      IsSuccess: boolean;
      Message?: string;
      ValidationErrors?: { Error: string }[];
      Data?: unknown;
    };

    if (!response.ok || !data.IsSuccess) {
      logger.error(
        {
          statusCode: response.status,
          message: data.Message,
          validationErrors: data.ValidationErrors,
        },
        'MyFatoorah API request failed'
      );
      throw new Error(
        data.Message || data.ValidationErrors?.[0]?.Error || 'MyFatoorah API request failed'
      );
    }

    return data as T;
  }

  async createPayment(request: CreatePaymentRequest): Promise<PaymentResponse> {
    const amountInKWD = request.amount / 1000; // Convert fils to KWD

    // First get available payment methods
    const methodsResponse = await this.request<{
      IsSuccess: boolean;
      Data: { PaymentMethods: MyFatoorahPaymentMethod[] };
    }>('/v2/InitiatePayment', 'POST', {
      InvoiceAmount: amountInKWD,
      CurrencyIso: request.currency,
    });

    const paymentMethods = methodsResponse.Data.PaymentMethods;

    // MyFatoorah's CustomerMobile is capped at 11 characters and must be
    // digits only — Kuwait format is `965XXXXXXXX` (3 country + 8 local).
    // Common inbound shapes that all need to land at 11 digits:
    //   `+96541169141`   → strip `+`         → 11 ✓
    //   `0096541169141`  → strip `00`        → 11 ✓
    //   `965 4116 9141`  → strip non-digits  → 11 ✓
    //   `96541169141`    → already correct   → 11 ✓
    // We strip non-digit chars, drop an `00` international prefix, then
    // keep the last 11 digits as a hard cap. If the result is empty (no
    // phone provided), omit the field entirely — MyFatoorah accepts that.
    const normalizeMobile = (raw: string | undefined): string | undefined => {
      if (!raw) return undefined;
      const digits = raw.replace(/\D/g, '');
      const noIntlPrefix = digits.startsWith('00') ? digits.slice(2) : digits;
      const trimmed = noIntlPrefix.slice(-11);
      return trimmed.length > 0 ? trimmed : undefined;
    };

    // MyFatoorah's v2 API has two payment endpoints:
    //   - /v2/ExecutePayment — requires a SPECIFIC PaymentMethodId from
    //     InitiatePayment. Used for embedded checkouts where the merchant
    //     already knows which method (KNET / Visa / etc.) the user picked.
    //     PaymentMethodId: 0 (legacy "show all methods" sentinel) is
    //     rejected with 400 "This payment method is not supported".
    //   - /v2/SendPayment — returns an InvoiceURL pointing at MyFatoorah's
    //     hosted multi-method selection page. The user picks method THERE.
    // FWB's UX is "select MyFatoorah at checkout → redirect to MyFatoorah →
    // pick method on their page", which is the SendPayment flow.
    // MyFatoorah NotificationOption mapping:
    //   LNK = return URL only (default; merchant copies/shares manually)
    //   EML = provider sends email with the link
    //   ALL = provider sends via SMS + email
    // Caller picks via request.notifyVia. SMS-only intentionally NOT
    // exposed yet (Ahmad 2026-05-16). Falls back to LNK on unknown
    // values so a typo doesn't silently dispatch unwanted comms.
    const notificationOption =
      request.notifyVia === 'email' ? 'EML' : request.notifyVia === 'all' ? 'ALL' : 'LNK';
    const sendData = {
      NotificationOption: notificationOption,
      InvoiceValue: amountInKWD,
      CustomerName: request.customer.name,
      CustomerEmail: request.customer.email,
      CustomerMobile: normalizeMobile(request.customer.phone),
      CustomerReference: request.orderNumber,
      DisplayCurrencyIso: request.currency,
      CallBackUrl: request.callbackUrl,
      ErrorUrl: request.errorUrl,
      Language: request.customer.language || 'en',
      InvoiceItemsList: request.items?.map(item => ({
        ItemName: item.name,
        Quantity: item.quantity,
        UnitPrice: item.unitPrice / 1000,
      })),
      UserDefinedField: request.orderId,
    };

    const executeResponse = await this.request<MyFatoorahExecuteResponse>(
      '/v2/SendPayment',
      'POST',
      sendData
    );

    return {
      success: true,
      provider: 'myfatoorah',
      transactionId: executeResponse.Data.InvoiceId.toString(),
      invoiceId: executeResponse.Data.InvoiceId.toString(),
      paymentUrl: executeResponse.Data.InvoiceURL,
      paymentMethods: paymentMethods.map(m => ({
        id: m.PaymentMethodId,
        code: m.PaymentMethodCode.toLowerCase(),
        name: m.PaymentMethodEn,
        nameAr: m.PaymentMethodAr,
        logo: m.ImageUrl,
        fee: m.ServiceCharge,
        isDirectPayment: m.IsDirectPayment,
      })),
      metadata: {
        customerReference: executeResponse.Data.CustomerReference,
      },
    };
  }

  async getPaymentStatus(transactionId: string): Promise<PaymentStatusResponse> {
    const response = await this.request<MyFatoorahStatusResponse>('/v2/GetPaymentStatus', 'POST', {
      Key: transactionId,
      KeyType: 'InvoiceId',
    });

    const data = response.Data;

    const statusMap: Record<string, PaymentStatus> = {
      Pending: 'pending',
      Paid: 'completed',
      Failed: 'failed',
      Expired: 'expired',
    };

    return {
      success: true,
      provider: 'myfatoorah',
      transactionId: data.InvoiceId.toString(),
      invoiceId: data.InvoiceId.toString(),
      status: statusMap[data.InvoiceStatus] || 'pending',
      amount: Math.round(data.InvoiceValue * 1000),
      currency: (data.PaidCurrency as Currency) || 'KWD',
      paidAmount: data.PaidCurrencyValue ? Math.round(data.PaidCurrencyValue * 1000) : undefined,
      paidCurrency: data.PaidCurrency as Currency,
      paymentMethod: data.PaymentMethod,
      paidAt: data.InvoiceStatus === 'Paid' ? new Date() : undefined,
      metadata: {
        invoiceReference: data.InvoiceReference,
        customerReference: data.CustomerReference,
        paymentId: data.PaymentId,
      },
    };
  }

  async refund(request: RefundRequest): Promise<RefundResponse> {
    // First get payment details
    const status = await this.getPaymentStatus(request.transactionId);

    const refundData: Record<string, unknown> = {
      Key: status.metadata?.paymentId || request.transactionId,
      KeyType: 'PaymentId',
      RefundChargeOnCustomer: false,
      ServiceChargeOnCustomer: false,
      Comment: request.reason || 'Refund requested',
    };

    if (request.amount) {
      refundData.Amount = request.amount / 1000;
    }

    const response = await this.request<MyFatoorahRefundResponse>(
      '/v2/MakeRefund',
      'POST',
      refundData
    );

    return {
      success: true,
      provider: 'myfatoorah',
      refundId: response.Data.RefundId.toString(),
      transactionId: request.transactionId,
      amount: Math.round(response.Data.Amount * 1000),
      status: 'completed',
      metadata: {
        refundReference: response.Data.RefundReference,
      },
    };
  }

  verifyWebhook(payload: unknown, signature: string): boolean {
    const secret = this.config.webhookSecret;

    // Reject if no webhook secret is configured — cannot verify without it
    if (!secret) {
      logger.warn('MYFATOORAH_WEBHOOK_SECRET is not configured; rejecting webhook');
      return false;
    }

    // Reject if no signature was supplied by the caller
    if (!signature) {
      return false;
    }

    // Compute HMAC-SHA256 over the raw JSON body string
    const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);

    const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

    // Constant-time comparison to prevent timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature.toLowerCase(), 'hex'),
        Buffer.from(expected, 'hex')
      );
    } catch {
      // Buffers of different lengths (or non-hex input) will throw — treat as mismatch
      return false;
    }
  }

  parseWebhook(payload: unknown): WebhookPayload {
    const data = payload as {
      Event: string;
      Data: {
        InvoiceId: number;
        InvoiceStatus: string;
        InvoiceValue: number;
        Currency: string;
        PaymentMethod: string;
      };
    };

    const statusMap: Record<string, PaymentStatus> = {
      Paid: 'completed',
      Failed: 'failed',
      Expired: 'expired',
      Pending: 'pending',
    };

    return {
      provider: 'myfatoorah',
      event: data.Event,
      transactionId: data.Data.InvoiceId.toString(),
      invoiceId: data.Data.InvoiceId.toString(),
      status: statusMap[data.Data.InvoiceStatus] || 'pending',
      amount: Math.round(data.Data.InvoiceValue * 1000),
      currency: data.Data.Currency as Currency,
      paymentMethod: data.Data.PaymentMethod,
      paidAt: data.Data.InvoiceStatus === 'Paid' ? new Date() : undefined,
      rawPayload: payload,
    };
  }

  async getPaymentMethods(amount: number, currency: Currency): Promise<AvailablePaymentMethod[]> {
    const response = await this.request<{
      IsSuccess: boolean;
      Data: { PaymentMethods: MyFatoorahPaymentMethod[] };
    }>('/v2/InitiatePayment', 'POST', {
      InvoiceAmount: amount / 1000,
      CurrencyIso: currency,
    });

    return response.Data.PaymentMethods.map(m => ({
      id: m.PaymentMethodId,
      code: m.PaymentMethodCode.toLowerCase(),
      name: m.PaymentMethodEn,
      nameAr: m.PaymentMethodAr,
      logo: m.ImageUrl,
      fee: m.ServiceCharge,
      isDirectPayment: m.IsDirectPayment,
    }));
  }
}
