// @vitest-environment jsdom
/**
 * #1318 — completing a return used to show ONE generic "failed, try again"
 * toast for every refusal. That included the one refusal where trying again is
 * the dangerous move: the refund reached the provider and only the completion
 * failed. The merchant now sees why, in their language, and the
 * money-may-have-moved cases stay on screen until dismissed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

const toast = { error: vi.fn(), success: vi.fn(), addToast: vi.fn() };
vi.mock('@force/ui', () => ({ useToast: () => toast }));

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../../../../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
}));

import { useReturns } from './useReturns';

function setup() {
  const requestRefundMethod = vi.fn().mockResolvedValue('original');
  const { result } = renderHook(() =>
    useReturns({
      storeId: 'store-1',
      requestRejectReason: vi.fn().mockResolvedValue(null),
      requestRefundMethod,
    })
  );
  return { result, requestRefundMethod };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ data: null, error: null });
});
afterEach(() => cleanup());

describe('useReturns.complete — refusals say why', () => {
  it('asks for the method FOR this return', async () => {
    apiPost.mockResolvedValue({ data: {}, error: null });
    const { result, requestRefundMethod } = setup();

    await act(() => result.current.complete('ret-9'));

    expect(requestRefundMethod).toHaveBeenCalledWith('ret-9');
  });

  it.each(['PROVIDER_REFUND_INDETERMINATE', 'REFUND_ALREADY_ISSUED'])(
    '%s: the money may have moved — a specific message that stays until dismissed',
    async code => {
      apiPost.mockResolvedValue({ data: null, error: { code, message: 'x', status: 502 } });
      const { result } = setup();

      await act(() => result.current.complete('ret-1'));

      expect(toast.addToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: `completeErrors.${code}`, duration: 0 })
      );
      expect(toast.error).not.toHaveBeenCalled();
    }
  );

  it.each([
    'RETURN_ALREADY_COMPLETING',
    'PARTIAL_REFUND_EXCEEDS_PAYMENT',
    'PARTIAL_REFUND_NOTHING_TO_REFUND',
    'PAYMENT_FULLY_REFUNDED',
    'NO_COMPLETED_PAYMENT',
  ])('%s gets its own message', async code => {
    apiPost.mockResolvedValue({ data: null, error: { code, message: 'x', status: 409 } });
    const { result } = setup();

    await act(() => result.current.complete('ret-1'));

    expect(toast.error).toHaveBeenCalledWith('completeErrorTitle', `completeErrors.${code}`);
  });

  it('an unknown failure falls back to the generic message (control)', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { code: 'SOMETHING_ELSE', message: 'x', status: 500 },
    });
    const { result } = setup();

    await act(() => result.current.complete('ret-1'));

    expect(toast.error).toHaveBeenCalledWith('completeErrorTitle', 'completeErrorBody');
  });
});
