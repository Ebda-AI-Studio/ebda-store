/**
 * Telling "the provider refused" from "we don't know what the provider did"
 * (#1359).
 *
 * PaymentService.refund releases its claim — and lets the merchant retry — only
 * for a failure that proves nothing was sent. Every provider used to throw the
 * same bare Error for a 400 and for a timeout, so a timeout (the case where the
 * refund most likely DID go out) was released and retried: a second real
 * refund. The providers now say which it was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProviderRejectedError,
  providerRequestError,
  markRefundMayHaveExecuted,
  refundMayHaveExecuted,
} from '@api/services/payment-providers/refund-outcome';
import { TapPaymentProvider } from '@api/services/payment-providers/tap.provider';
import { UPaymentsProvider } from '@api/services/payment-providers/upayments.provider';
import { MyFatoorahPaymentProvider } from '@api/services/payment-providers/myfatoorah.provider';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const config = {
  apiKey: 'sk_test',
  secretKey: 'sk_secret',
  baseUrl: 'https://provider.test',
  isTestMode: true,
  webhookSecret: 'whsec',
};

const answer = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('providerRequestError', () => {
  it.each([
    [400, false, true],
    [404, false, true],
    [422, false, true],
    [200, true, true], // HTTP fine, body says no — the provider decided
    [408, false, false], // the server gave up on the request, it did not decide
    [500, false, false],
    [502, false, false],
    [504, false, false],
  ])('status %s (responseOk=%s) → rejected=%s', (status, ok, rejected) => {
    const err = providerRequestError('x', status, ok);
    expect(err instanceof ProviderRejectedError).toBe(rejected);
    expect(err.message).toBe('x');
  });
});

describe('refundMayHaveExecuted', () => {
  it('is false unless PaymentService marked the error', () => {
    const plain = new Error('boom');
    expect(refundMayHaveExecuted(plain)).toBe(false);
    expect(refundMayHaveExecuted(markRefundMayHaveExecuted(plain))).toBe(true);
    expect(refundMayHaveExecuted(null)).toBe(false);
    expect(refundMayHaveExecuted('string')).toBe(false);
  });
});

describe('provider refund failures are classified', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('Tap: an explicit 4xx is a rejection', async () => {
    const tap = new TapPaymentProvider();
    tap.initialize(config);
    mockFetch.mockResolvedValueOnce(answer(400, { errors: [{ description: 'Invalid amount' }] }));

    await expect(tap.refund({ transactionId: 'chg_1', amount: 1000 })).rejects.toBeInstanceOf(
      ProviderRejectedError
    );
  });

  it('Tap: a 5xx may have executed — NOT a rejection', async () => {
    const tap = new TapPaymentProvider();
    tap.initialize(config);
    mockFetch.mockResolvedValueOnce(answer(502, { errors: [{ description: 'Bad gateway' }] }));

    const err = await tap.refund({ transactionId: 'chg_1', amount: 1000 }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProviderRejectedError);
  });

  it('Tap: a timeout may have executed — NOT a rejection', async () => {
    const tap = new TapPaymentProvider();
    tap.initialize(config);
    mockFetch.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));

    const err = await tap.refund({ transactionId: 'chg_1', amount: 1000 }).catch(e => e);
    expect(err).not.toBeInstanceOf(ProviderRejectedError);
  });

  it('UPayments: HTTP 200 whose body says error is a rejection', async () => {
    const up = new UPaymentsProvider();
    up.initialize(config);
    mockFetch.mockResolvedValueOnce(
      answer(200, { status: 'error', message: 'Refund not allowed' })
    );

    await expect(up.refund({ transactionId: 'inv_1', amount: 1000 })).rejects.toBeInstanceOf(
      ProviderRejectedError
    );
  });

  it('MyFatoorah: a failure BEFORE MakeRefund means nothing was sent', async () => {
    const mf = new MyFatoorahPaymentProvider();
    mf.initialize(config);
    // The GetPaymentStatus pre-read times out; MakeRefund is never called.
    mockFetch.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));

    await expect(mf.refund({ transactionId: 'inv_1', amount: 1000 })).rejects.toBeInstanceOf(
      ProviderRejectedError
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
