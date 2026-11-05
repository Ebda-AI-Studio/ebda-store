/**
 * Outage isolation (SP6a, Review Focus 5), unit level: one circuit per
 * (store, provider); only OUTAGE errors count; COD / InstaPay are never
 * breakered; an open circuit fails fast without calling the provider; recovery
 * goes through half-open. The persisted health write is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ updateMany: vi.fn().mockResolvedValue({ count: 1 }) }));
vi.mock('@ebda/database', () => ({
  prisma: { paymentConfig: { updateMany: (...a: unknown[]) => h.updateMany(...a) } },
  withStore: (_s: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeWriter: async () => ({
    paymentConfig: { updateMany: (...a: unknown[]) => h.updateMany(...a) },
  }),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  callThroughBreaker,
  isOutageError,
  isProviderAvailable,
  providerHealth,
  resetProviderHealthForTests,
} from '@api/services/payment-providers/provider-health';
import { PaymentProviderError } from '@api/services/payment-providers/types';
import { ProviderRejectedError } from '@api/services/payment-providers/refund-outcome';
import { AppError } from '@api/middleware/error-handler';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const timeout = () => new PaymentProviderError('PROVIDER_TIMEOUT', 'slow');
const fail = async (store: string, provider: string, err: unknown = timeout()) =>
  callThroughBreaker(store, provider, async () => {
    throw err;
  }).catch(e => e);

beforeEach(() => {
  resetProviderHealthForTests();
  h.updateMany.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('provider health circuit', () => {
  it('three outages open the circuit for THAT store and provider only', async () => {
    for (let i = 0; i < 3; i += 1) await fail(A, 'paymob');
    expect(isProviderAvailable(A, 'paymob')).toBe(false);
    expect(providerHealth(A, 'paymob')).toBe('down');
    // another store, another provider, and the manual methods are untouched
    expect(isProviderAvailable(B, 'paymob')).toBe(true);
    expect(isProviderAvailable(A, 'kashier')).toBe(true);
    expect(isProviderAvailable(A, 'cod')).toBe(true);
    expect(isProviderAvailable(A, 'instapay')).toBe(true);
  });

  it('fails fast with PROVIDER_UNAVAILABLE and never calls the provider while open', async () => {
    for (let i = 0; i < 3; i += 1) await fail(A, 'kashier');
    const op = vi.fn().mockResolvedValue('ok');
    const err = await callThroughBreaker(A, 'kashier', op).catch(e => e);
    expect(err).toBeInstanceOf(PaymentProviderError);
    expect(err.code).toBe('PROVIDER_UNAVAILABLE');
    expect(op).not.toHaveBeenCalled();
  });

  it('a rejection (the provider ANSWERED no) is not an outage and never opens the circuit', async () => {
    for (let i = 0; i < 10; i += 1) {
      await fail(A, 'kashier', new PaymentProviderError('PROVIDER_REJECTED', 'bad amount'));
      await fail(A, 'kashier', new ProviderRejectedError('invalid email', 400));
      await fail(A, 'kashier', new AppError(422, 'VALIDATION_ERROR', 'no'));
    }
    expect(isProviderAvailable(A, 'kashier')).toBe(true);
    expect(providerHealth(A, 'kashier')).toBe('healthy');
  });

  it('classifies errors: timeouts, unreachable, 5xx and unknown throws are outages', () => {
    expect(isOutageError(timeout())).toBe(true);
    expect(isOutageError(new PaymentProviderError('PROVIDER_UNAVAILABLE', 'x'))).toBe(true);
    expect(isOutageError(new AppError(502, 'BAD_GATEWAY', 'x'))).toBe(true);
    expect(isOutageError(new Error('ECONNRESET'))).toBe(true);
    expect(isOutageError(new PaymentProviderError('AMOUNT_INVALID', 'x'))).toBe(false);
  });

  it('half-open after the cool-down: one success closes it again', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i += 1) await fail(A, 'kashier');
    expect(isProviderAvailable(A, 'kashier')).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(isProviderAvailable(A, 'kashier')).toBe(true); // probe allowed
    await callThroughBreaker(A, 'kashier', async () => 'ok');
    expect(providerHealth(A, 'kashier')).toBe('healthy');
  });

  it('a failed probe re-opens it', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i += 1) await fail(A, 'kashier');
    vi.advanceTimersByTime(61_000);
    await fail(A, 'kashier');
    expect(isProviderAvailable(A, 'kashier')).toBe(false);
  });

  it('COD and InstaPay are never breakered, whatever they throw', async () => {
    for (let i = 0; i < 10; i += 1) await fail(A, 'cod', new Error('boom'));
    expect(await callThroughBreaker(A, 'instapay', async () => 'fine')).toBe('fine');
    expect(isProviderAvailable(A, 'cod')).toBe(true);
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('surfaces health to the merchant: persisted per store+provider, only when it changes', async () => {
    await fail(A, 'paymob'); // degraded
    await vi.waitFor(() => expect(h.updateMany).toHaveBeenCalledTimes(1));
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { storeId: A, provider: 'paymob' },
        data: expect.objectContaining({ healthStatus: 'degraded' }),
      })
    );
    await fail(A, 'paymob'); // still degraded: no new write
    await fail(A, 'paymob'); // down
    await vi.waitFor(() => expect(h.updateMany).toHaveBeenCalledTimes(2));
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ healthStatus: 'down' }) })
    );
  });
});
