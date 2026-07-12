import crypto from 'crypto';
import {
  IPaymentProvider,
  PaymentProviderConfig,
  CreatePaymentRequest,
  PaymentResponse,
  PaymentStatusResponse,
  RefundRequest,
  RefundResponse,
  RefundStatusResponse,
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

const MYFATOORAH_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * MyFatoorah rejects an empty/blank CustomerEmail with the generic "Invalid
 * data" (caused a checkout P0 on 2026-06-10 — email is OPTIONAL at FWB checkout
 * so guests frequently have none). Always return a syntactically VALID email:
 * the customer's real one if present, else a deterministic placeholder on the
 * store's own domain (derived from the callback URL host, platform default if
 * the URL is unparseable). A valid address is accepted whether MyFatoorah
 * treats the field as required or optional; with NotificationOption=LNK no mail
 * is actually sent to it. Exported for regression testing.
 */
export function resolveMyFatoorahEmail(
  rawEmail: string | undefined,
  callbackUrl: string,
  orderNumber: string
): string {
  const real = rawEmail?.trim();
  if (real && MYFATOORAH_EMAIL_RE.test(real)) return real;
  let host = 'force-ai.co';
  try {
    const h = new URL(callbackUrl).hostname;
    if (h) host = h;
  } catch {
    /* keep platform default */
  }
  return `guest-${orderNumber}@${host}`;
}

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
      // A hung provider request must degrade exactly like a network error
      // (fail-soft catch upstream), not hang the checkout indefinitely.
      signal: AbortSignal.timeout(8000),
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
      // Surface the SPECIFIC field errors, not just the generic Message.
      // MyFatoorah's Message is frequently just "Invalid data" while the real
      // cause (e.g. CustomerEmail/CustomerMobile invalid) lives in
      // ValidationErrors — without this, the error reaching Sentry is an
      // undiagnosable "Invalid data" (cost us a P0 on 2026-06-10).
      const fieldErrors = (data.ValidationErrors || [])
        .map(v => {
          const e = v as { Name?: string; Error?: string };
          return e.Name ? `${e.Name}: ${e.Error}` : e.Error;
        })
        .filter(Boolean)
        .join('; ');
      throw new Error(
        [data.Message, fieldErrors].filter(Boolean).join(' — ') || 'MyFatoorah API request failed'
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

    // MyFatoorah rejects an empty/blank CustomerEmail with the generic
    // "Invalid data" (caused a checkout P0 on 2026-06-10). See
    // resolveMyFatoorahEmail below — always send a syntactically valid address.
    const customerEmail = resolveMyFatoorahEmail(
      request.customer.email,
      request.callbackUrl,
      request.orderNumber
    );

    const sendData = {
      NotificationOption: notificationOption,
      InvoiceValue: amountInKWD,
      CustomerName: request.customer.name,
      CustomerEmail: customerEmail,
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
    // First get payment details. MyFatoorah's MakeRefund needs:
    //   - Key + KeyType (PaymentId preferred, InvoiceId fallback)
    //   - Amount: REQUIRED per docs even for full refunds. Default to the
    //     paid amount from GetPaymentStatus so a full-refund call (where
    //     the caller passes no amount) still satisfies the API.
    // Note: MyFatoorah refunds are NOT instant — they create a refund
    // *request* that's reviewed and executed by MyFatoorah's finance team
    // (typically 1-3 business days). The API returns success on submission,
    // not on settlement.
    const status = await this.getPaymentStatus(request.transactionId);
    const paymentId = status.metadata?.paymentId as string | undefined;
    const refundKey = paymentId || request.transactionId;
    // MyFatoorah's working sample (and PHP/C#/Python SDKs) use lowercase
    // KeyType values — `paymentid` / `invoiceid`. The endpoint accepts
    // both casings in practice, but matching their canonical form rules
    // out case-sensitivity-related rejections that have bitten others.
    const refundKeyType = paymentId ? 'paymentid' : 'invoiceid';

    // Default to the full paid amount when the caller didn't specify a
    // partial refund. `request.amount` is in fils; MyFatoorah's API
    // expects the account's default currency unit (KWD for Wady Aljuz).
    const amountFils = request.amount ?? status.paidAmount ?? status.amount;
    if (!amountFils || amountFils <= 0) {
      throw new Error('Cannot determine refund amount — payment has no paid amount on record');
    }
    const amountKwd = amountFils / 1000;

    const refundData: Record<string, unknown> = {
      Key: refundKey,
      KeyType: refundKeyType,
      Amount: amountKwd,
      ServiceChargeOnCustomer: false,
      Comment: request.reason || 'Refund requested',
      // Correlate our order with MyFatoorah's refund record so the finance
      // team (and us later, via GetRefundStatus) can map refunds back to
      // our internal IDs without manual cross-referencing. Matches the
      // pattern in MyFatoorah's working sample response.
      ExternalIdentifier: `order:${request.transactionId}`,
    };

    logger.info(
      {
        keyType: refundKeyType,
        invoiceId: request.transactionId,
        amountFils,
        amountKwd,
        testMode: this.config.isTestMode,
      },
      '[MyFatoorah] MakeRefund request'
    );

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
      // MyFatoorah refunds are queued for finance-team review before
      // execution — so the response from MakeRefund means "submitted",
      // not "settled at the card network". The settle event arrives
      // later via webhook (or polled via GetRefundStatus).
      status: 'pending',
      metadata: {
        refundReference: response.Data.RefundReference,
      },
    };
  }

  /**
   * MyFatoorah's GetRefundStatus — checks where a previously-submitted
   * refund stands. Status flows Pending → Refunded (executed by finance
   * team) | Canceled (rejected). Use the `refundId` returned from the
   * MakeRefund call (we save it on `Payment.refundId`).
   *
   * Response shape per docs:
   *   Data.RefundStatusResult: [{ RefundId, RefundStatus, Amount,
   *     RefundReference, RefundAmount, InvoiceId }, ...]
   * We return the first matching entry (refundId is unique).
   */
  async getRefundStatus(refundId: string): Promise<RefundStatusResponse> {
    const response = await this.request<{
      IsSuccess: boolean;
      Data: {
        RefundStatusResult: Array<{
          RefundId: number;
          RefundStatus: 'Refunded' | 'Pending' | 'Canceled';
          InvoiceId: number;
          Amount: number;
          RefundReference: string;
          RefundAmount: number;
        }>;
      };
    }>('/v2/GetRefundStatus', 'POST', {
      Key: refundId,
      KeyType: 'refundid',
    });

    const result = response.Data.RefundStatusResult?.[0];
    if (!result) {
      throw new Error(`MyFatoorah returned no refund result for refundId ${refundId}`);
    }

    const statusMap: Record<string, RefundStatusResponse['status']> = {
      Refunded: 'completed',
      Pending: 'pending',
      Canceled: 'failed',
    };

    return {
      success: true,
      provider: 'myfatoorah',
      refundId: result.RefundId.toString(),
      status: statusMap[result.RefundStatus] || 'pending',
      amount: Math.round(result.Amount * 1000),
      refundedAmount: Math.round(result.RefundAmount * 1000),
      refundReference: result.RefundReference,
      raw: result as unknown as Record<string, unknown>,
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
      Event?: string;
      EventType?: number;
      Data: {
        // Invoice (payment) status webhook fields
        InvoiceId?: number;
        InvoiceStatus?: string;
        InvoiceValue?: number;
        Currency?: string;
        PaymentMethod?: string;
        // Refund webhook fields (MyFatoorah "Refund Status Changed" event)
        RefundId?: number;
        RefundStatus?: string;
        RefundReference?: string;
        Amount?: number;
        RefundAmount?: number;
      };
    };

    // MyFatoorah delivers two distinct webhook types over the same channel:
    //   - "TransactionsStatusChanged" — invoice/payment lifecycle (Paid /
    //     Failed / Expired / Pending) — what every existing checkout uses
    //   - "RefundStatusChanged" — refund execution (Refunded / Canceled /
    //     Pending) — fires when the finance team executes or rejects a
    //     previously-submitted MakeRefund
    // Distinguish by presence of RefundId in the Data block. EventType
    // numeric codes vary between portal versions; the field-shape check
    // is more reliable than parsing the type.
    const isRefundEvent = data.Data.RefundId !== undefined;

    if (isRefundEvent) {
      const refundStatusMap: Record<string, 'pending' | 'completed' | 'failed'> = {
        Refunded: 'completed',
        Pending: 'pending',
        Canceled: 'failed',
      };
      // Refund webhooks carry an InvoiceId too — the original payment's
      // invoice. We use it as the transactionId so handleWebhook can find
      // the right Payment row by invoiceId/transactionId.
      return {
        provider: 'myfatoorah',
        event: data.Event || 'RefundStatusChanged',
        transactionId: (data.Data.InvoiceId ?? data.Data.RefundId!).toString(),
        invoiceId: data.Data.InvoiceId?.toString(),
        // Keep status as the payment's status (unchanged by refund event) —
        // the refund-specific data rides on the optional `refund` field.
        // handleWebhook checks `refund` first and short-circuits before
        // touching the payment's primary status.
        status: 'completed',
        amount: Math.round((data.Data.Amount ?? 0) * 1000),
        currency: 'KWD' as Currency,
        refund: {
          refundId: data.Data.RefundId!.toString(),
          refundReference: data.Data.RefundReference,
          status: refundStatusMap[data.Data.RefundStatus || ''] || 'pending',
          amount: Math.round((data.Data.RefundAmount ?? data.Data.Amount ?? 0) * 1000),
        },
        rawPayload: payload,
      };
    }

    const statusMap: Record<string, PaymentStatus> = {
      Paid: 'completed',
      Failed: 'failed',
      Expired: 'expired',
      Pending: 'pending',
    };

    return {
      provider: 'myfatoorah',
      event: data.Event || 'TransactionsStatusChanged',
      transactionId: data.Data.InvoiceId!.toString(),
      invoiceId: data.Data.InvoiceId!.toString(),
      status: statusMap[data.Data.InvoiceStatus || ''] || 'pending',
      amount: Math.round((data.Data.InvoiceValue ?? 0) * 1000),
      currency: (data.Data.Currency || 'KWD') as Currency,
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
