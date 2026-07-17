import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { HesabePaymentProvider } from '../hesabe.provider';
import type { CreatePaymentRequest, RefundRequest } from '../types';

// Hesabe's `secretKey` config is parsed as "ivKey:encryptionKey" and used for
// AES-256-CBC encrypt/decrypt of every request/response body. aes-256-cbc
// requires a 32-byte key and a 16-byte IV.
const IV_KEY = '1234567890123456'; // 16 bytes
const ENC_KEY = '12345678901234567890123456789012'; // 32 bytes
const WEBHOOK_SECRET = 'hesabe-webhook-secret';

function hesabeEncrypt(data: object): string {
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    Buffer.from(ENC_KEY, 'utf8'),
    Buffer.from(IV_KEY, 'utf8')
  );
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

function hesabeDecrypt(data: string): unknown {
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(ENC_KEY, 'utf8'),
    Buffer.from(IV_KEY, 'utf8')
  );
  let decrypted = decipher.update(data, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('HesabePaymentProvider', () => {
  let provider: HesabePaymentProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new HesabePaymentProvider();
    provider.initialize({
      apiKey: 'access-code-123',
      secretKey: `${IV_KEY}:${ENC_KEY}`,
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
    orderNumber: 'ORD-1001',
    amount: 15500, // fils -> 15.5 KWD
    currency: 'KWD',
    customer: { name: 'Aziz Al-Sabah', email: 'aziz@example.com', phone: '+96550001234' },
    callbackUrl: 'https://store.example.com/checkout/success',
    errorUrl: 'https://store.example.com/checkout/error',
    webhookUrl: 'https://api.example.com/webhooks/hesabe',
    metadata: { source: 'web' },
  };

  describe('createPayment', () => {
    it('builds the encrypted checkout request and returns a normalized payment response', async () => {
      const decryptedResponse = {
        token: 'tok_abc',
        paymentId: 'pay_123',
        checkoutUrl: 'https://sandbox.hesabe.com/pay/pay_123',
      };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: true,
          code: '000',
          message: 'ok',
          response: { data: hesabeEncrypt(decryptedResponse) },
        })
      );

      const result = await provider.createPayment(baseRequest);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://sandbox.hesabe.com/checkout');
      expect(init.method).toBe('POST');
      expect(init.headers.accessCode).toBe('access-code-123');

      // Decrypt what the provider actually sent to assert the built request shape.
      const sentEnvelope = JSON.parse(init.body as string) as { data: string };
      const sentBody = hesabeDecrypt(sentEnvelope.data) as Record<string, unknown>;
      expect(sentBody).toMatchObject({
        merchantCode: 'MERCH-1',
        amount: 15.5,
        paymentType: 0,
        responseUrl: baseRequest.callbackUrl,
        failureUrl: baseRequest.errorUrl,
        orderReferenceNumber: 'ORD-1001',
        variable1: 'order-1',
        variable2: 'aziz@example.com',
        variable3: 'Aziz Al-Sabah',
        variable4: '+96550001234',
      });

      expect(result).toEqual({
        success: true,
        provider: 'hesabe',
        transactionId: 'pay_123',
        paymentUrl: 'https://sandbox.hesabe.com/pay/pay_123',
        metadata: { token: 'tok_abc' },
      });
    });

    it('throws when Hesabe reports a failed request envelope', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ status: false, code: '400', message: 'Invalid merchant code', response: {} })
      );

      await expect(provider.createPayment(baseRequest)).rejects.toThrow('Invalid merchant code');
    });
  });

  describe('getPaymentStatus', () => {
    it('maps a CAPTURED result to completed', async () => {
      const decrypted = {
        status: true,
        response: {
          resultCode: 'CAPTURED',
          paymentId: 'pay_123',
          orderReferenceNumber: 'ORD-1001',
          amount: 15.5,
          variable1: 'order-1',
          variable2: 'aziz@example.com',
          variable3: 'Aziz Al-Sabah',
          variable4: '',
          variable5: '{}',
          paymentType: 'KNET',
        },
      };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: true,
          code: '000',
          message: 'ok',
          response: { data: hesabeEncrypt(decrypted) },
        })
      );

      const result = await provider.getPaymentStatus('pay_123');

      expect(result.success).toBe(true);
      expect(result.provider).toBe('hesabe');
      expect(result.transactionId).toBe('pay_123');
      expect(result.status).toBe('completed');
      expect(result.amount).toBe(15500);
      expect(result.currency).toBe('KWD');
      expect(result.paymentMethod).toBe('KNET');
      expect(result.paidAt).toBeInstanceOf(Date);
    });

    it('maps NOT_CAPTURED to failed with no paidAt', async () => {
      const decrypted = {
        status: true,
        response: {
          resultCode: 'NOT_CAPTURED',
          paymentId: 'pay_999',
          orderReferenceNumber: 'ORD-2',
          amount: 5,
          variable1: '',
          variable2: '',
          variable3: '',
          variable4: '',
          variable5: '',
          paymentType: 'VISA',
        },
      };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: true,
          code: '000',
          message: 'ok',
          response: { data: hesabeEncrypt(decrypted) },
        })
      );

      const result = await provider.getPaymentStatus('pay_999');

      expect(result.status).toBe('failed');
      expect(result.paidAt).toBeUndefined();
    });
  });

  describe('refund', () => {
    it('issues a refund and returns a normalized completed response', async () => {
      const decrypted = { status: true, refundId: 'rfd_1', amount: 5 };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: true,
          code: '000',
          message: 'ok',
          response: { data: hesabeEncrypt(decrypted) },
        })
      );

      const request: RefundRequest = {
        transactionId: 'pay_123',
        amount: 5000,
        reason: 'customer request',
      };
      const result = await provider.refund(request);

      expect(result).toEqual({
        success: true,
        provider: 'hesabe',
        refundId: 'rfd_1',
        transactionId: 'pay_123',
        amount: 5000,
        status: 'completed',
      });
    });

    it('returns a failed status when Hesabe reports refund failure', async () => {
      const decrypted = { status: false, refundId: 'rfd_2', amount: 0 };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: true,
          code: '000',
          message: 'ok',
          response: { data: hesabeEncrypt(decrypted) },
        })
      );

      const result = await provider.refund({ transactionId: 'pay_999' });

      expect(result.success).toBe(false);
      expect(result.status).toBe('failed');
    });
  });

  describe('verifyWebhook', () => {
    function sign(payload: unknown): string {
      const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return crypto.createHmac('sha256', WEBHOOK_SECRET).update(payloadString).digest('hex');
    }

    it('returns true for a validly signed payload', () => {
      const payload = { event: 'payment', paymentId: 'pay_1' };
      expect(provider.verifyWebhook(payload, sign(payload))).toBe(true);
    });

    it('returns false for a same-length but incorrect signature', () => {
      const payload = { event: 'payment', paymentId: 'pay_1' };
      const tampered = sign(payload).split('').reverse().join('');
      expect(provider.verifyWebhook(payload, tampered)).toBe(false);
    });

    it('returns false — and does not throw — for a malformed/wrong-length signature', () => {
      const payload = { event: 'payment', paymentId: 'pay_1' };
      expect(() => provider.verifyWebhook(payload, 'short')).not.toThrow();
      expect(provider.verifyWebhook(payload, 'short')).toBe(false);
      expect(() => provider.verifyWebhook(payload, '')).not.toThrow();
      expect(provider.verifyWebhook(payload, '')).toBe(false);
    });

    it('returns false when no webhookSecret is configured', () => {
      const noSecretProvider = new HesabePaymentProvider();
      noSecretProvider.initialize({
        apiKey: 'x',
        secretKey: `${IV_KEY}:${ENC_KEY}`,
        baseUrl: 'https://unused.example.com',
        isTestMode: true,
      });
      expect(noSecretProvider.verifyWebhook({ a: 1 }, 'anything')).toBe(false);
    });
  });

  describe('parseWebhook', () => {
    it('normalizes a CAPTURED webhook payload', () => {
      const decrypted = {
        paymentId: 'pay_1',
        resultCode: 'CAPTURED',
        amount: 10,
        paymentType: 'VISA',
        orderReferenceNumber: 'ORD-1',
      };
      const payload = { data: hesabeEncrypt(decrypted) };

      const result = provider.parseWebhook(payload);

      expect(result).toMatchObject({
        provider: 'hesabe',
        event: 'payment',
        transactionId: 'pay_1',
        status: 'completed',
        amount: 10000,
        currency: 'KWD',
        paymentMethod: 'VISA',
      });
      expect(result.paidAt).toBeInstanceOf(Date);
      expect(result.rawPayload).toBe(payload);
    });

    it('normalizes a NOT_CAPTURED webhook to failed with no paidAt', () => {
      const decrypted = {
        paymentId: 'pay_2',
        resultCode: 'NOT_CAPTURED',
        amount: 5,
        paymentType: 'KNET',
        orderReferenceNumber: 'ORD-2',
      };
      const result = provider.parseWebhook({ data: hesabeEncrypt(decrypted) });

      expect(result.status).toBe('failed');
      expect(result.paidAt).toBeUndefined();
    });
  });

  describe('getPaymentMethods', () => {
    it('returns Hesabe payment methods including KNET', async () => {
      const methods = await provider.getPaymentMethods(1000, 'KWD');
      expect(methods.some(m => m.code === 'knet')).toBe(true);
      expect(methods.length).toBeGreaterThan(0);
    });
  });
});
