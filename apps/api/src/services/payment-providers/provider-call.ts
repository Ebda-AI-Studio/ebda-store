/**
 * Shared plumbing for provider adapters (v2).
 *
 * Every outbound provider call goes through `callProvider`: it bounds the call
 * with a timeout (an `AbortSignal` the adapter hands to `fetch`) and maps every
 * failure to a `PaymentProviderError`, so the circuit breaker and the checkout
 * can tell an outage (timeout / unreachable) from a rejected request.
 */
import { PaymentProviderError, type Currency } from './types';

/** Default per-call budget. Well under the 30 s tenant-transaction limit, and no call runs inside one anyway. */
export const PROVIDER_CALL_TIMEOUT_MS = 10_000;

export async function callProvider<T>(
  op: string,
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = PROVIDER_CALL_TIMEOUT_MS
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new PaymentProviderError('PROVIDER_TIMEOUT', `${op} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } catch (err) {
    if (err instanceof PaymentProviderError) throw err;
    throw new PaymentProviderError(
      'PROVIDER_UNAVAILABLE',
      `${op} failed: ${err instanceof Error ? err.message : 'unknown error'}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Money must be a positive safe integer in piastres, and EGP is the only currency the Egypt adapters take. */
export function assertChargeable(req: { amountMinor: number; currency: string }): void {
  if (!Number.isSafeInteger(req.amountMinor) || req.amountMinor <= 0) {
    throw new PaymentProviderError(
      'AMOUNT_INVALID',
      `amountMinor must be a positive integer number of piastres (got ${String(req.amountMinor)})`
    );
  }
  if (req.currency !== 'EGP') {
    throw new PaymentProviderError('CURRENCY_UNSUPPORTED', `Unsupported currency ${req.currency}`);
  }
}

export function assertRefundAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new PaymentProviderError(
      'AMOUNT_INVALID',
      `refund amountMinor must be a positive integer number of piastres (got ${String(amountMinor)})`
    );
  }
}

export const EGP: Currency = 'EGP';
