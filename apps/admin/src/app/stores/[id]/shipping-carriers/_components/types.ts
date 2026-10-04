/**
 * Shared types and defaults for the shipping-carriers page. Kept in
 * _components so the page.tsx and its subcomponents import from the same
 * module, avoiding duplicate type declarations.
 */

import { DEFAULT_PICKUP, type PickupAddress } from './PickupAddressForm';

export type CarrierKey = 'icarry' | 'aramex' | 'bosta';

export interface ICarryConfig {
  enabled: boolean;
  isDefault: boolean;
  apiKey: string;
  merchantId: string;
  pickup: PickupAddress;
}

export interface BostaConfig {
  enabled: boolean;
  isDefault: boolean;
  apiKey: string;
  businessLocationId: string;
  sandbox: boolean;
  pickup: PickupAddress;
}

export interface AramexConfig {
  enabled: boolean;
  isDefault: boolean;
  /** Use Aramex's test environment. */
  sandbox: boolean;
  /** The merchant has Aramex's written confirmation that COD is collected in EGP. */
  codEgpConfirmed: boolean;
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
  bosta: BostaConfig;
}

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

export type TestStatus = 'idle' | 'testing' | 'success' | 'error';

/**
 * Raw carrier-config row as returned by the API. Credentials and settings
 * are free-form JSON blobs whose exact shape differs per carrier, so we
 * narrow them at the page level when merging into DEFAULT_CONFIGS.
 */
export interface CarrierConfigApiRow {
  carrier: string;
  enabled?: boolean;
  isDefault?: boolean;
  credentials?: Record<string, string | undefined>;
  settings?: Record<string, string | boolean | undefined>;
}

/**
 * Color palette for the shipment status pill. Handed to the shared
 * OrderStatusBadge via `colorMap`. Maps the carrier-agnostic status strings
 * (created / picked_up / in_transit / out_for_delivery / delivered / failed
 * / returned / cancelled) to theme-token color combos.
 */
export const SHIPMENT_COLORS = {
  created: { className: 'bg-muted text-foreground' },
  picked_up: { className: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink' },
  in_transit: {
    className: 'bg-warning/10 text-warning-ink dark:bg-warning/30 dark:text-warning-ink',
  },
  out_for_delivery: { className: 'bg-primary/10 text-primary-ink' },
  delivered: {
    className: 'bg-success/10 text-success-ink dark:bg-success/30 dark:text-success-ink',
  },
  failed: {
    className:
      'bg-destructive/10 text-destructive-ink dark:bg-destructive/30 dark:text-destructive-ink',
  },
  returned: { className: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink' },
  cancelled: { className: 'bg-muted text-muted-foreground' },
  creating: { className: 'bg-muted text-foreground' },
  creation_failed: {
    className:
      'bg-destructive/10 text-destructive-ink dark:bg-destructive/30 dark:text-destructive-ink',
  },
} as const;

export const DEFAULT_CONFIGS: CarrierConfigs = {
  icarry: {
    enabled: false,
    isDefault: false,
    apiKey: '',
    merchantId: '',
    pickup: { ...DEFAULT_PICKUP },
  },
  bosta: {
    enabled: false,
    isDefault: false,
    apiKey: '',
    businessLocationId: '',
    sandbox: false,
    pickup: { ...DEFAULT_PICKUP },
  },
  aramex: {
    enabled: false,
    isDefault: false,
    sandbox: false,
    codEgpConfirmed: false,
    accountNumber: '',
    accountPin: '',
    accountEntity: '',
    accountCountryCode: 'EG',
    username: '',
    password: '',
    pickup: { ...DEFAULT_PICKUP },
  },
};
