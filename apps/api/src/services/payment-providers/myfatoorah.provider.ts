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
      console.error('[MYFATOORAH ERROR]', data);
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

    // Execute payment with all methods available
    const executeData = {
      PaymentMethodId: 0, // 0 means show all payment methods
      InvoiceValue: amountInKWD,
      CustomerName: request.customer.name,
      CustomerEmail: request.customer.email,
      CustomerMobile: request.customer.phone,
      CustomerReference: request.orderNumber,
      DisplayCurrencyIso: request.currency,
      CallBackUrl: request.callbackUrl,
      ErrorUrl: request.errorUrl,
      Language: request.customer.language || 'en',
      InvoiceItems: request.items?.map(item => ({
        ItemName: item.name,
        Quantity: item.quantity,
        UnitPrice: item.unitPrice / 1000,
      })),
      UserDefinedField: request.orderId,
    };

    const executeResponse = await this.request<MyFatoorahExecuteResponse>(
      '/v2/ExecutePayment',
      'POST',
      executeData
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

  verifyWebhook(_payload: unknown, _signature: string): boolean {
    // MyFatoorah uses callback verification through the payment status API
    // There's no signature verification for webhooks
    return true;
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
