/**
 * Registry of v2 provider adapters. The factory (`payment.factory.ts`) stays the
 * one place that resolves a provider for a store; v2 adapters register here and
 * the factory builds each online provider from this registry (through the v1
 * bridge, `v2-bridge.ts`). COD and InstaPay (no network) are built in, and so are the
 * three Egyptian gateways: Paymob, Kashier, Fawry.
 */
import { codProvider } from './cod.provider';
import { fawryProvider } from './fawry.provider';
import { geideaProvider } from './geidea.provider';
import { instapayProvider } from './instapay.provider';
import { kashierProvider } from './kashier.provider';
import { paymobProvider } from './paymob.provider';
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
registerProviderV2(paymobProvider);
registerProviderV2(kashierProvider);
registerProviderV2(fawryProvider);
registerProviderV2(geideaProvider);
