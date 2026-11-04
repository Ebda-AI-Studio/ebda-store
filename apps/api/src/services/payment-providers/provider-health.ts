/**
 * Outage isolation (SP6a, Review Focus 5): one failing provider disables ONE
 * method, and checkout still works.
 *
 * A circuit breaker per (store, provider), built on the platform's existing
 * `circuit-breaker.service`. Only OUTAGE errors count (a timeout, an unreachable
 * gateway, an unexpected throw); a provider that REJECTS a request (bad amount,
 * declined card) is healthy and never trips it. While a circuit is open that
 * method is reported unavailable to checkout (COD and the other methods are
 * untouched) and `/payments/create` for it answers 503 straight away, so the
 * customer is not made to wait out a timeout. After the cool-down one probe goes
 * through (half open); success closes the circuit.
 *
 * Health is surfaced to the merchant through `payment_configs.health_status`
 * (healthy / degraded / down), written fire-and-forget in its own short
 * transaction AFTER the provider call, never inside a request transaction.
 * COD and InstaPay have no provider behind them and are never breakered.
 */
import { storeWriter } from '../../lib/repo-factory';
import { withStore } from '@ebda/database';
import logger from '../../lib/logger';
import { circuitBreaker } from '../circuit-breaker.service';
import { AppError } from '../../middleware/error-handler';
import { ProviderRejectedError } from './refund-outcome';
import { MANUAL_PROVIDERS } from './registry';
import { PaymentProviderError } from './types';

type Health = 'healthy' | 'degraded' | 'down';

const FAILURE_THRESHOLD = 3;
const COOL_DOWN_MS = 60_000;

export const circuitName = (storeId: string, provider: string) => `payment:${storeId}:${provider}`;

function ensureCircuit(storeId: string, provider: string): string {
  const name = circuitName(storeId, provider);
  if (!circuitBreaker.getState(name)) {
    circuitBreaker.register(name, {
      failureThreshold: FAILURE_THRESHOLD,
      successThreshold: 1,
      timeout: COOL_DOWN_MS,
      resetTimeout: 5 * 60_000,
    });
  }
  return name;
}

/** Is this method callable right now for this store? (Manual methods always are.) */
export function isProviderAvailable(storeId: string, provider: string): boolean {
  if (MANUAL_PROVIDERS.has(provider)) return true;
  return circuitBreaker.canRequest(ensureCircuit(storeId, provider));
}

/** Health of the in-process circuit, for the merchant surfaces. */
export function providerHealth(storeId: string, provider: string): Health {
  if (MANUAL_PROVIDERS.has(provider)) return 'healthy';
  const s = circuitBreaker.getState(circuitName(storeId, provider));
  if (!s) return 'healthy';
  if (s.state === 'OPEN') return 'down';
  if (s.state === 'HALF_OPEN' || s.failures > 0) return 'degraded';
  return 'healthy';
}

/** Does this error say the PROVIDER is unhealthy (as opposed to the request being wrong)? */
export function isOutageError(err: unknown): boolean {
  if (err instanceof PaymentProviderError) return err.isOutage;
  // The provider ANSWERED and said no (a validation error, a 4xx): it is healthy.
  if (err instanceof ProviderRejectedError) return false;
  if (err instanceof AppError && err.statusCode < 500) return false;
  // Anything else (a raw fetch failure, a 5xx, an abort, a gateway client that
  // threw) is the provider failing.
  return true;
}

/**
 * Run one provider call behind the (store, provider) circuit. An open circuit
 * fails fast with `PROVIDER_UNAVAILABLE` (no call is made). Health is recorded
 * after the call, outside any transaction.
 */
export async function callThroughBreaker<T>(
  storeId: string,
  provider: string,
  op: () => Promise<T>
): Promise<T> {
  if (MANUAL_PROVIDERS.has(provider)) return op();
  const name = ensureCircuit(storeId, provider);
  if (!circuitBreaker.canRequest(name)) {
    throw new PaymentProviderError(
      'PROVIDER_UNAVAILABLE',
      `${provider} is temporarily unavailable for this store`
    );
  }
  try {
    const result = await op();
    circuitBreaker.recordSuccess(name);
    await persistHealth(storeId, provider);
    return result;
  } catch (err) {
    if (isOutageError(err)) {
      circuitBreaker.recordFailure(name);
      await persistHealth(storeId, provider);
    }
    throw err;
  }
}

let lastWritten = new Map<string, Health>();

/**
 * Write the health the merchant sees. Only on a change (so almost always a no-op);
 * never throws; always its own short transaction, AFTER the provider call and
 * awaited, so it cannot be cut off with the request (a Worker drops un-awaited work).
 */
async function persistHealth(storeId: string, provider: string): Promise<void> {
  const health = providerHealth(storeId, provider);
  const key = circuitName(storeId, provider);
  if (lastWritten.get(key) === health) return;
  lastWritten.set(key, health);
  try {
    // withStore: the store's short transaction on Postgres, no Postgres at all for a store on its Durable Object
    await withStore(storeId, async () =>
      (await storeWriter(storeId)).paymentConfig.updateMany({
        where: { storeId, provider: provider as never },
        data: { healthStatus: health, lastHealthCheck: new Date() },
      })
    );
  } catch (err) {
    lastWritten.delete(key);
    logger.warn({ err, storeId, provider }, '[PAYMENT] could not persist provider health');
  }
}

/** Test seam: forget in-process circuit and health state. */
export function resetProviderHealthForTests(): void {
  for (const name of Object.keys(circuitBreaker.getAllStates())) {
    if (name.startsWith('payment:')) circuitBreaker.reset(name);
  }
  lastWritten = new Map();
}
