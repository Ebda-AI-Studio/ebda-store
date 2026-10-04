import { describe, it, expect, vi } from 'vitest';
import { handlePaymentCreateResult } from './paymentResult';

function actions() {
  const calls: string[] = [];
  return {
    calls,
    a: {
      clearSavedCheckout: vi.fn(() => calls.push('clear')),
      goToCodSuccess: vi.fn(() => calls.push('cod')),
      goToInstapay: vi.fn(() => calls.push('instapay')),
      goToReferenceCode: vi.fn((code: string) => calls.push(`ref:${code}`)),
      goToGateway: vi.fn((url: string) => calls.push(`gateway:${url}`)),
    },
  };
}

// #1990 — the saved checkout form was cleared before the payment result was
// checked, so a failed payment destroyed what the customer had typed.
describe('handlePaymentCreateResult', () => {
  it('keeps the saved form when payment creation fails, and throws the API code', () => {
    const { a } = actions();
    let thrown: (Error & { rawMessage?: string }) | undefined;
    try {
      handlePaymentCreateResult(
        { success: false, error: { code: 'PAYMENT_PROVIDER_ERROR', message: 'timeout' } },
        a
      );
    } catch (e) {
      thrown = e as Error & { rawMessage?: string };
    }
    expect(thrown?.message).toBe('PAYMENT_PROVIDER_ERROR');
    expect(thrown?.rawMessage).toBe('timeout');
    expect(a.clearSavedCheckout).not.toHaveBeenCalled();
    expect(a.goToCodSuccess).not.toHaveBeenCalled();
    expect(a.goToGateway).not.toHaveBeenCalled();
  });

  it('keeps the saved form on a success response with no way forward', () => {
    const { a } = actions();
    expect(() => handlePaymentCreateResult({ success: true, data: {} }, a)).toThrow(
      'PAYMENT_FAILED'
    );
    expect(a.clearSavedCheckout).not.toHaveBeenCalled();
  });

  it('clears the saved form, then goes to the COD success page', () => {
    const { a, calls } = actions();
    handlePaymentCreateResult({ success: true, data: { cod: true } }, a);
    expect(calls).toEqual(['clear', 'cod']);
  });

  it('clears the saved form, then redirects to the gateway', () => {
    const { a, calls } = actions();
    handlePaymentCreateResult({ success: true, data: { paymentUrl: 'https://pay.test/x' } }, a);
    expect(calls).toEqual(['clear', 'gateway:https://pay.test/x']);
  });

  // SP6a — InstaPay is a manual transfer: no gateway URL, the success page shows the details.
  it('clears the saved form, then goes to the InstaPay instructions', () => {
    const { a, calls } = actions();
    handlePaymentCreateResult(
      { success: true, data: { instapay: { handle: 'amelia@instapay', amountMinor: 12345 } } },
      a
    );
    expect(calls).toEqual(['clear', 'instapay']);
    expect(a.goToGateway).not.toHaveBeenCalled();
  });

  // SP6b — Fawry reference code: no URL to redirect to; the success page shows the code.
  it('clears the saved form, then shows the Fawry reference code (no redirect)', () => {
    const { a, calls } = actions();
    handlePaymentCreateResult(
      {
        success: true,
        data: { paymentUrl: '', instruction: { kind: 'reference-code', code: '931000123' } },
      },
      a
    );
    expect(calls).toEqual(['clear', 'ref:931000123']);
    expect(a.goToGateway).not.toHaveBeenCalled();
  });
});
