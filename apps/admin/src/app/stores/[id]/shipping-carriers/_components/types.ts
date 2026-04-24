/**
 * Shared types and defaults for the shipping-carriers page. Kept in
 * _components so the page.tsx and its subcomponents import from the same
 * module, avoiding duplicate type declarations.
 */

import { DEFAULT_PICKUP, type PickupAddress } from './PickupAddressForm';

export type CarrierKey = 'icarry' | 'aramex';

export interface ICarryConfig {
  enabled: boolean;
  isDefault: boolean;
  apiKey: string;
  merchantId: string;
  pickup: PickupAddress;
}

export interface AramexConfig {
  enabled: boolean;
  isDefault: boolean;
  accountNumber: string;
  accountPin: string;
  accountEntity: string;
  accountCountryCode: string;
  username: string;
  password: string;
  pickup: PickupAddress;
}

export interface CarrierConfigs {
  icarry: ICarryConfig;
  aramex: AramexConfig;
}

export interface Shipment {
  id: string;
  orderNumber: string;
  carrierCode: string;
  trackingNumber: string | null;
  status: string;
  createdAt: string;
}

export interface ShipmentsData {
  shipments: Shipment[];
  total: number;
  page: number;
  limit: number;
}

export type TestStatus = 'idle' | 'testing' | 'success' | 'error';

/**
 * Raw carrier-config row as returned by the API. Credentials and settings
 * are free-form JSON blobs whose exact shape differs per carrier, so we
 * narrow them at the page level when merging into DEFAULT_CONFIGS.
 */
export interface CarrierConfigApiRow {
  carrierCode: string;
  enabled?: boolean;
  isDefault?: boolean;
  credentials?: Record<string, string | undefined>;
  settings?: Record<string, string | undefined>;
}

/**
 * Color palette for the shipment status pill. Handed to the shared
 * OrderStatusBadge via `colorMap`. Maps the carrier-agnostic status strings
 * (created / picked_up / in_transit / out_for_delivery / delivered / failed
 * / returned / cancelled) to theme-token color combos.
 */
export const SHIPMENT_COLORS = {
  created: { className: 'bg-muted text-foreground' },
  picked_up: { className: 'bg-info/10 text-info dark:bg-info/30 dark:text-info' },
  in_transit: { className: 'bg-warning/10 text-warning dark:bg-warning/30 dark:text-warning' },
  out_for_delivery: { className: 'bg-primary/10 text-primary' },
  delivered: { className: 'bg-success/10 text-success dark:bg-success/30 dark:text-success' },
  failed: {
    className: 'bg-destructive/10 text-destructive dark:bg-destructive/30 dark:text-destructive',
  },
  returned: { className: 'bg-info/10 text-info dark:bg-info/30 dark:text-info' },
  cancelled: { className: 'bg-muted text-muted-foreground' },
} as const;

export const DEFAULT_CONFIGS: CarrierConfigs = {
  icarry: {
    enabled: false,
    isDefault: false,
    apiKey: '',
    merchantId: '',
    pickup: { ...DEFAULT_PICKUP },
  },
  aramex: {
    enabled: false,
    isDefault: false,
    accountNumber: '',
    accountPin: '',
    accountEntity: '',
    accountCountryCode: 'KW',
    username: '',
    password: '',
    pickup: { ...DEFAULT_PICKUP },
  },
};
