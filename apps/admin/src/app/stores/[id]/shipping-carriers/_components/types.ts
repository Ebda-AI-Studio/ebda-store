/**
 * Shared types and defaults for the shipping-carriers page. Kept in
 * _components so the page.tsx and its subcomponents import from the same
 * module, avoiding duplicate type declarations.
 */

import type { CredentialMode } from '@ebda/shared';
import type { PickupAddress } from './PickupAddressForm';

export type CarrierKey = 'bosta' | 'shipblu' | 'mylerz' | 'aramex' | 'manual';

/** One saved-credential hint: secrets only say they are set (+ last 4), non-secrets echo the value. */
export type CredentialHint = { set: true; last4?: string; value?: string };

/** The carrier's non-secret settings (pickup address, weight, size, Aramex product). */
export type CarrierSettings = Record<string, string | number | boolean | undefined>;

/**
 * A row of `GET /stores/:id/shipping-carriers/configs`. Credentials are never returned
 * (write-only): only `credentialHints` say which are saved.
 */
export interface CarrierConfigRow {
  id?: string;
  carrier: string;
  enabled: boolean;
  isDefault: boolean;
  /** true = the sandbox credentials are the active ones. */
  testMode?: boolean;
  /** The active credential mode. */
  mode?: CredentialMode;
  settings?: CarrierSettings | null;
  credentialHints?: Partial<Record<CredentialMode, Record<string, CredentialHint>>> | null;
  connectionTest?: { ok: boolean; code: string; mode: CredentialMode; at: string } | null;
  connectionTestCurrent?: boolean;
}

// The pickup address is stored in the carrier's non-secret `settings` (same keys for every carrier).
export const pickupFromSettings = (settings: CarrierSettings | undefined): PickupAddress => ({
  name: String(settings?.pickupName ?? ''),
  phone: String(settings?.pickupPhone ?? ''),
  line1: String(settings?.pickupLine1 ?? ''),
  city: String(settings?.pickupCity ?? 'Cairo'),
  area: String(settings?.pickupArea ?? ''),
});

export const pickupToSettings = (p: PickupAddress) => ({
  pickupName: p.name,
  pickupPhone: p.phone,
  pickupLine1: p.line1,
  pickupCity: p.city,
  pickupArea: p.area,
});

export interface Shipment {
  id: string;
  orderNumber: string;
  carrierCode: string;
  trackingNumber: string | null;
  status: string;
  createdAt: string;
}

/** A row of `GET /stores/:id/shipments` as the API sends it. */
export interface ShipmentApiRow {
  id: string;
  carrier: string;
  trackingNumber: string | null;
  status: string;
  createdAt: string;
  order?: { orderNumber?: string };
}

export interface ShipmentsData {
  shipments: ShipmentApiRow[];
  meta?: { total: number; page: number; limit: number; totalPages: number };
}
