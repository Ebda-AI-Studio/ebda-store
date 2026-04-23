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
