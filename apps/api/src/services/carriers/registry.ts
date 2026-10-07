/**
 * The carrier adapters, by catalog code. Kept out of `shipping-carrier.service.ts` so the connect
 * service (Test connection) and the booking service share one table without importing each other.
 */
import { aramexCarrier } from './aramex.carrier';
import { bostaCarrier } from './bosta.carrier';
import { manualCarrier } from './manual.carrier';
import { mylerzCarrier } from './mylerz.carrier';
import { shipbluCarrier } from './shipblu.carrier';
import type { CarrierCode, ShippingCarrierProvider } from './types';

export const CARRIER_REGISTRY: Record<CarrierCode, ShippingCarrierProvider> = {
  bosta: bostaCarrier,
  shipblu: shipbluCarrier,
  mylerz: mylerzCarrier,
  aramex: aramexCarrier,
  manual: manualCarrier,
};

export function getCarrierAdapter(code: string): ShippingCarrierProvider | undefined {
  return (CARRIER_REGISTRY as Record<string, ShippingCarrierProvider>)[code];
}
