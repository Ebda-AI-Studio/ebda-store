/**
 * Payment Provider Unit Tests
 * Tests payment factory and Tap provider implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TapPaymentProvider } from '@api/services/payment-providers/tap.provider';
import type {
  CreatePaymentRequest,
  PaymentProviderConfig,
  Currency,
} from '@api/services/payment-providers/types';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('TapPaymentProvider', () => {
  let provider: TapPaymentProvider;
  const mockConfig: PaymentProviderConfig = {
    apiKey: 'sk_test_12345',
    secretKey: 'sk_secret_12345',
    baseUrl: 'https://api.tap.company/v2',
    isTestMode: true,
    webhookSecret: 'whsec_test_12345',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new TapPaymentProvider();
    provider.initialize(mockConfig);
  });

  describe('initialize', () => {
    it('should set provider name correctly', () => {
      expect(provider.name).toBe('tap');
    });
  });

  describe('createPayment', () => {
    const mockRequest: CreatePaymentRequest = {
      orderId: 'order-123',
      orderNumber: 'ORD-001',
      amount: 5000, // 5 KWD in fils
      currency: 'KWD' as Currency,
      customer: {
        id: 'cust-123',
        name: 'Ahmad Test',
        email: 'ahmad@test.com',
        phone: '+96512345678',
      },
      items: [{ name: 'Test Product', quantity: 1, unitPrice: 5000 }],
      callbackUrl: 'https://mystore.com/checkout/success',
      webhookUrl: 'https://api.mystore.com/webhooks/payment',
    };

    it('should create payment successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'chg_test_123',
          status: 'INITIATED',
          transaction: {
            url: 'https://checkout.tap.company/v2/checkout/chg_test_123',
            created: new Date().toISOString(),
            expiry: { period: 30, type: 'MINUTE' },
          },
          customer: { id: 'cus_tap_123' },
          source: { id: 'src_all', payment_method: 'KNET' },
        }),
      });

      const result = await provider.createPayment(mockRequest);

      expect(result.success).toBe(true);
      expect(result.provider).toBe('tap');
      expect(result.transactionId).toBe('chg_test_123');
      expect(result.paymentUrl).toContain('checkout.tap.company');
    });

    it('should convert fils to KWD for Tap API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'chg_test_123',
          status: 'INITIATED',
          transaction: { url: 'https://checkout.tap.company/v2/checkout/chg_test_123' },
          customer: { id: 'cus_tap_123' },
        }),
      });

      await provider.createPayment(mockRequest);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      // 5000 fils = 5 KWD
      expect(requestBody.amount).toBe(5);
    });

    it('should include customer details in request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'chg_test_123',
          status: 'INITIATED',
          transaction: { url: 'https://checkout.tap.company/v2/checkout/chg_test_123' },
          customer: { id: 'cus_tap_123' },
        }),
      });

      await provider.createPayment(mockRequest);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      expect(requestBody.customer.first_name).toBe('Ahmad');
      expect(requestBody.customer.last_name).toBe('Test');
      expect(requestBody.customer.email).toBe('ahmad@test.com');
    });

    it('should throw error on API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          errors: [{ description: 'Invalid API key' }],
        }),
      });

      await expect(provider.createPayment(mockRequest)).rejects.toThrow('Invalid API key');
    });

    it('should set proper authorization header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'chg_test_123',
          status: 'INITIATED',
          transaction: { url: 'https://checkout.tap.company/v2/checkout/chg_test_123' },
          customer: { id: 'cus_tap_123' },
        }),
      });

      await provider.createPayment(mockRequest);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[1].headers.Authorization).toBe(`Bearer ${mockConfig.apiKey}`);
    });
  });

  describe('getPaymentStatus', () => {
    it('should return completed status for CAPTURED charge', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'chg_test_123',
          status: 'CAPTURED',
          amount: 5,
          currency: 'KWD',
          source: { payment_method: 'KNET' },
        }),
      });

      const result = await provider.getPaymentStatus('chg_test_123');

      expect(result.success).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.amount).toBe(5000); // Converted back to fils
    });

    it('should return failed status for FAILED charge', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'chg_test_123',
          status: 'FAILED',
          amount: 5,
          currency: 'KWD',
        }),
      });

      const result = await provider.getPaymentStatus('chg_test_123');

      expect(result.status).toBe('failed');
    });

    it('should return cancelled status for CANCELLED charge', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'chg_test_123',
          status: 'CANCELLED',
          amount: 5,
          currency: 'KWD',
        }),
      });

      const result = await provider.getPaymentStatus('chg_test_123');

      expect(result.status).toBe('cancelled');
    });

    it('should return expired status for TIMEDOUT charge', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'chg_test_123',
          status: 'TIMEDOUT',
          amount: 5,
          currency: 'KWD',
        }),
      });

      const result = await provider.getPaymentStatus('chg_test_123');

      expect(result.status).toBe('expired');
    });
  });

  describe('refund', () => {
    it('should process full refund successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ref_test_123',
          status: 'CAPTURED',
          amount: 5,
          currency: 'KWD',
          charge_id: 'chg_test_123',
          reason: 'requested_by_customer',
        }),
      });

      const result = await provider.refund({
        transactionId: 'chg_test_123',
        reason: 'Customer request',
      });

      expect(result.success).toBe(true);
      expect(result.refundId).toBe('ref_test_123');
      expect(result.status).toBe('completed');
    });

    it('should process partial refund with amount', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ref_test_123',
          status: 'PENDING',
          amount: 2.5,
          currency: 'KWD',
          charge_id: 'chg_test_123',
        }),
      });

      const result = await provider.refund({
        transactionId: 'chg_test_123',
        amount: 2500, // 2.5 KWD in fils
        reason: 'Partial refund',
      });

      expect(result.success).toBe(true);
      expect(result.amount).toBe(2500);
      expect(result.status).toBe('pending');
    });
  });

  describe('verifyWebhook', () => {
    it('should return false if no webhook secret configured', () => {
      const providerWithoutSecret = new TapPaymentProvider();
      providerWithoutSecret.initialize({ ...mockConfig, webhookSecret: undefined });

      const result = providerWithoutSecret.verifyWebhook({ data: 'test' }, 'signature');

      expect(result).toBe(false);
    });

    it('should verify valid signature', () => {
      const crypto = require('crypto');
      const payload = JSON.stringify({ id: 'chg_test_123', status: 'CAPTURED' });
      const expectedSignature = crypto
        .createHmac('sha256', mockConfig.webhookSecret!)
        .update(payload)
        .digest('hex');

      const result = provider.verifyWebhook(payload, expectedSignature);

      expect(result).toBe(true);
    });

    it('should reject invalid signature', () => {
      const payload = JSON.stringify({ id: 'chg_test_123', status: 'CAPTURED' });

      const result = provider.verifyWebhook(payload, 'invalid_signature');

      expect(result).toBe(false);
    });
  });

  describe('parseWebhook', () => {
    it('should parse webhook payload correctly', () => {
      const payload = {
        id: 'chg_test_123',
        object: 'charge',
        status: 'CAPTURED',
        amount: 5,
        currency: 'KWD',
        source: { payment_method: 'KNET' },
      };

      const result = provider.parseWebhook(payload);

      expect(result.provider).toBe('tap');
      expect(result.transactionId).toBe('chg_test_123');
      expect(result.status).toBe('completed');
      expect(result.amount).toBe(5000); // Converted to fils
      expect(result.paymentMethod).toBe('KNET');
    });

    it('should handle failed status in webhook', () => {
      const payload = {
        id: 'chg_test_123',
        object: 'charge',
        status: 'FAILED',
        amount: 5,
        currency: 'KWD',
      };

      const result = provider.parseWebhook(payload);

      expect(result.status).toBe('failed');
    });
  });

  describe('getPaymentMethods', () => {
    it('should return all methods for KWD currency', async () => {
      const methods = await provider.getPaymentMethods(5000, 'KWD');

      expect(methods).toContainEqual(expect.objectContaining({ code: 'knet' }));
      expect(methods).toContainEqual(expect.objectContaining({ code: 'visa' }));
      expect(methods).toContainEqual(expect.objectContaining({ code: 'apple_pay' }));
    });

    it('should exclude KNET for non-KWD currencies', async () => {
      const methods = await provider.getPaymentMethods(5000, 'USD');

      expect(methods).not.toContainEqual(expect.objectContaining({ code: 'knet' }));
      expect(methods).toContainEqual(expect.objectContaining({ code: 'visa' }));
    });

    it('should include Arabic names', async () => {
      const methods = await provider.getPaymentMethods(5000, 'KWD');
      const knetMethod = methods.find((m: { code: string }) => m.code === 'knet');

      expect(knetMethod?.nameAr).toBe('كي نت');
    });
  });
});
