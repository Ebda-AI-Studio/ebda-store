import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { UPaymentsProvider } from '../upayments.provider';
import type { CreatePaymentRequest, RefundRequest } from '../types';

const WEBHOOK_SECRET = 'upayments-webhook-secret';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('UPaymentsProvider', () => {
  let provider: UPaymentsProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new UPaymentsProvider();
    provider.initialize({
      apiKey: 'api-key-123',
      secretKey: 'secret-pass',
      merchantId: 'MERCH-1',
      baseUrl: 'https://unused.example.com',
      isTestMode: true,
      webhookSecret: WEBHOOK_SECRET,
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  const baseRequest: CreatePaymentRequest = {
    orderId: 'order-1',
    orderNumber: 'ORD-2001',
    amount: 20000, // fils -> 20 KWD
    currency: 'KWD',
    customer: { name: 'Noura Al-Fahad', email: 'noura@example.com', phone: '+96550009999' },
    items: [
      { name: 'T-Shirt', quantity: 2, unitPrice: 5000 },
      { name: 'Mug', quantity: 1, unitPrice: 10000 },
    ],
    callbackUrl: 'https://store.example.com/checkout/success',
    errorUrl: 'https://store.example.com/checkout/error',
    webhookUrl: 'https://api.example.com/webhooks/upayments',
  };

  describe('createPayment', () => {
    it('builds the create-payment request and returns a normalized payment response', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          message: 'ok',
          data: {
            link: 'https://sandboxapi.upayments.com/pay/inv_1',
            invoice_id: 'inv_1',
            order_id: 'ORD-2001',
          },
        })
      );

      const result = await provider.createPayment(baseRequest);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://sandboxapi.upayments.com/api/v1/create-payment');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer api-key-123');

      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toMatchObject({
        merchant_id: 'MERCH-1',
        username: 'api-key-123',
        password: 'secret-pass',
        api_key: 'api-key-123',
        order_id: 'ORD-2001',
        total_price: 20,
        currency_code: 'KWD',
        success_url: baseRequest.callbackUrl,
        error_url: baseRequest.errorUrl,
        test_mode: 1,
        customer_name: 'Noura Al-Fahad',
        customer_email: 'noura@example.com',
        customer_mobile: '+96550009999',
        payment_gateway: 'knet',
        payment_methods: ['knet', 'cc'],
        reference: { id: 'order-1' },
        product_title: 'Order #ORD-2001',
      });
      expect(sentBody.product_price).toEqual([
        { name: 'T-Shirt', qty: 2, price: 5 },
        { name: 'Mug', qty: 1, price: 10 },
      ]);
      expect(sentBody.notifications).toEqual({
        emails: ['noura@example.com'],
        mobiles: ['+96550009999'],
      });

      expect(result).toEqual({
        success: true,
        provider: 'upayments',
        transactionId: 'inv_1',
        invoiceId: 'inv_1',
        paymentUrl: 'https://sandboxapi.upayments.com/pay/inv_1',
        metadata: { orderId: 'ORD-2001' },
      });
    });

    it('marks the response unsuccessful when UPayments returns a non-success status', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: 'declined',
          message: 'ok',
          data: { link: 'https://x/pay/inv_2', invoice_id: 'inv_2', order_id: 'ORD-2002' },
        })
      );

      const result = await provider.createPayment(baseRequest);
      expect(result.success).toBe(false);
    });

    it('throws when UPayments reports an error envelope', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ status: 'error', message: 'Invalid merchant credentials' }, true)
      );

      await expect(provider.createPayment(baseRequest)).rejects.toThrow(
        'Invalid merchant credentials'
      );
    });
  });

  describe('getPaymentStatus', () => {
    it('maps a paid status to completed', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          data: {
            invoice_id: 'inv_1',
            order_id: 'ORD-2001',
            payment_status: 'Paid',
            amount: 20,
            currency: 'KWD',
            customer_name: 'Noura Al-Fahad',
            customer_email: 'noura@example.com',
            customer_phone: '+96550009999',
            payment_type: 'knet',
            transaction_id: 'txn_1',
            paid_at: '2026-07-15T10:00:00.000Z',
          },
        })
      );

      const result = await provider.getPaymentStatus('inv_1');

      expect(result.success).toBe(true);
      expect(result.provider).toBe('upayments');
      expect(result.transactionId).toBe('inv_1');
      expect(result.invoiceId).toBe('inv_1');
      expect(result.status).toBe('completed');
      expect(result.amount).toBe(20000);
      expect(result.currency).toBe('KWD');
      expect(result.paymentMethod).toBe('knet');
      expect(result.paidAt).toEqual(new Date('2026-07-15T10:00:00.000Z'));
      expect(result.metadata).toEqual({ orderId: 'ORD-2001', transactionId: 'txn_1' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://sandboxapi.upayments.com/api/v1/get-payment-status/inv_1');
      expect(init.method).toBe('GET');
    });

    it('maps a failed status and leaves paidAt undefined', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          data: {
            invoice_id: 'inv_9',
            order_id: 'ORD-9',
            payment_status: 'Failed',
            amount: 1,
            currency: 'KWD',
            customer_name: 'X',
            customer_email: 'x@example.com',
            customer_phone: '',
            payment_type: 'cc',
            transaction_id: 'txn_9',
            paid_at: null,
          },
        })
      );

      const result = await provider.getPaymentStatus('inv_9');
      expect(result.status).toBe('failed');
      expect(result.paidAt).toBeUndefined();
    });
  });

  describe('refund', () => {
    it('issues a refund and returns a normalized completed response', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          message: 'ok',
          data: { refund_id: 'rfd_1', amount: 5, status: 'success' },
        })
      );

      const request: RefundRequest = {
        transactionId: 'inv_1',
        amount: 5000,
        reason: 'customer request',
      };
      const result = await provider.refund(request);

      expect(result).toEqual({
        success: true,
        provider: 'upayments',
        refundId: 'rfd_1',
        transactionId: 'inv_1',
        amount: 5000,
        status: 'completed',
      });

      const [, init] = fetchMock.mock.calls[0];
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody).toEqual({
        invoice_id: 'inv_1',
        reason: 'customer request',
        amount: 5,
      });
    });

    it('returns a pending status when UPayments has not settled the refund yet', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          message: 'queued',
          data: { refund_id: 'rfd_2', amount: 5, status: 'queued' },
        })
      );

      const result = await provider.refund({ transactionId: 'inv_2' });
      expect(result.status).toBe('pending');
    });
  });

  describe('verifyWebhook', () => {
    function sign(payload: unknown): string {
      const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return crypto.createHmac('sha256', WEBHOOK_SECRET).update(payloadString).digest('hex');
    }

    it('returns true for a validly signed payload', () => {
      const payload = { event: 'payment', invoice_id: 'inv_1' };
      expect(provider.verifyWebhook(payload, sign(payload))).toBe(true);
    });

    it('returns false for a same-length but incorrect signature', () => {
      const payload = { event: 'payment', invoice_id: 'inv_1' };
      const tampered = sign(payload).split('').reverse().join('');
      expect(provider.verifyWebhook(payload, tampered)).toBe(false);
    });

    it('returns false — and does not throw — for a malformed/wrong-length signature', () => {
      const payload = { event: 'payment', invoice_id: 'inv_1' };
      expect(() => provider.verifyWebhook(payload, 'short')).not.toThrow();
      expect(provider.verifyWebhook(payload, 'short')).toBe(false);
      expect(() => provider.verifyWebhook(payload, '')).not.toThrow();
      expect(provider.verifyWebhook(payload, '')).toBe(false);
    });

    it('returns false when no webhookSecret is configured', () => {
      const noSecretProvider = new UPaymentsProvider();
      noSecretProvider.initialize({
        apiKey: 'x',
        baseUrl: 'https://unused.example.com',
        isTestMode: true,
      });
      expect(noSecretProvider.verifyWebhook({ a: 1 }, 'anything')).toBe(false);
    });
  });

  describe('parseWebhook', () => {
    it('normalizes a paid webhook payload', () => {
      const payload = {
        event: 'invoice.paid',
        invoice_id: 'inv_1',
        order_id: 'ORD-2001',
        payment_status: 'Paid',
        amount: 20,
        currency: 'KWD',
        payment_type: 'knet',
        paid_at: '2026-07-15T10:00:00.000Z',
      };

      const result = provider.parseWebhook(payload);

      expect(result).toMatchObject({
        provider: 'upayments',
        event: 'invoice.paid',
        transactionId: 'inv_1',
        invoiceId: 'inv_1',
        status: 'completed',
        amount: 20000,
        currency: 'KWD',
        paymentMethod: 'knet',
      });
      expect(result.paidAt).toEqual(new Date('2026-07-15T10:00:00.000Z'));
      expect(result.rawPayload).toBe(payload);
    });

    it('normalizes a failed webhook payload with no paidAt', () => {
      const payload = {
        event: 'invoice.failed',
        invoice_id: 'inv_2',
        order_id: 'ORD-2002',
        payment_status: 'Failed',
        amount: 1,
        currency: 'KWD',
        payment_type: 'cc',
        paid_at: null,
      };

      const result = provider.parseWebhook(payload);
      expect(result.status).toBe('failed');
      expect(result.paidAt).toBeUndefined();
    });
  });

  describe('getPaymentMethods', () => {
    it('excludes KNET for non-KWD currencies', async () => {
      const methods = await provider.getPaymentMethods(1000, 'USD');
      expect(methods.some(m => m.code === 'knet')).toBe(false);
    });

    it('includes KNET for KWD', async () => {
      const methods = await provider.getPaymentMethods(1000, 'KWD');
      expect(methods.some(m => m.code === 'knet')).toBe(true);
    });
  });
});
