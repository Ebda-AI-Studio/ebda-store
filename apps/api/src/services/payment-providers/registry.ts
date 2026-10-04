/**
 * Registry of v2 provider adapters. The factory (`payment.factory.ts`) stays the
 * one place that resolves a provider for a store; v2 adapters register here and
 * the factory asks this registry first. COD and InstaPay (no network) are built
 * in; 6b registers Paymob / Kashier / Fawry the same way.
 */
import { codProvider } from './cod.provider';
import { instapayProvider } from './instapay.provider';
import type { PaymentProvider, PaymentProviderV2 } from './types';

const adapters = new Map<PaymentProvider, PaymentProviderV2>();

export function registerProviderV2(adapter: PaymentProviderV2): void {
  adapters.set(adapter.name, adapter);
}

export function getProviderV2(name: string): PaymentProviderV2 | undefined {
  return adapters.get(name as PaymentProvider);
}

export function listProvidersV2(): PaymentProviderV2[] {
  return [...adapters.values()];
}

/** Providers with no gateway behind them: nothing for a circuit breaker to protect, never an outage. */
export const MANUAL_PROVIDERS: ReadonlySet<string> = new Set(['cod', 'instapay']);

registerProviderV2(codProvider);
registerProviderV2(instapayProvider);
