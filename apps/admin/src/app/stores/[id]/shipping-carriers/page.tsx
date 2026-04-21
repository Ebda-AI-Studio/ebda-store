'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut, apiPost } from '../../../../lib/api';
import { useFeatures } from '../../../../hooks/useFeatures';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PickupAddress {
  area: string;
  block: string;
  street: string;
  building: string;
}

interface ICarryConfig {
  enabled: boolean;
  isDefault: boolean;
  apiKey: string;
  merchantId: string;
  pickup: PickupAddress;
}

interface AramexConfig {
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

interface CarrierConfigs {
  icarry: ICarryConfig;
  aramex: AramexConfig;
}

interface Shipment {
  id: string;
  orderNumber: string;
  carrierCode: string;
  trackingNumber: string | null;
  status: string;
  createdAt: string;
}

interface ShipmentsData {
  shipments: Shipment[];
  total: number;
  page: number;
  limit: number;
}

const DEFAULT_PICKUP: PickupAddress = { area: '', block: '', street: '', building: '' };

const DEFAULT_CONFIGS: CarrierConfigs = {
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

// ─── Status Badge ─────────────────────────────────────────────────────────────

function ShipmentStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    created: 'bg-muted text-foreground',
    picked_up: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    in_transit: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
    out_for_delivery: 'bg-orange-100 text-primary',
    delivered: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    returned: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
    cancelled: 'bg-muted text-muted-foreground',
  };
  const labels: Record<string, string> = {
    created: 'Created',
    picked_up: 'Picked Up',
    in_transit: 'In Transit',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered',
    failed: 'Failed',
    returned: 'Returned',
    cancelled: 'Cancelled',
  };
  const cls = colors[status] || 'bg-muted text-foreground';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${cls}`}>
      {labels[status] || status}
    </span>
  );
}

// ─── Toggle ───────────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 ${
        checked ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

// ─── Connection Status ────────────────────────────────────────────────────────

function ConnectionStatus({ status }: { status: 'idle' | 'testing' | 'success' | 'error' }) {
  if (status === 'idle') return null;
  if (status === 'testing')
    return (
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span className="animate-spin inline-block h-3 w-3 border-2 border-current border-t-transparent rounded-full" />
        Testing…
      </span>
    );
  if (status === 'success')
    return (
      <span className="flex items-center gap-1.5 text-sm text-green-600">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        Connected
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-sm text-red-600">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M6 18L18 6M6 6l12 12"
        />
      </svg>
      Failed
    </span>
  );
}

// ─── Pickup Address Form ──────────────────────────────────────────────────────

function PickupAddressForm({
  value,
  onChange,
}: {
  value: PickupAddress;
  onChange: (patch: Partial<PickupAddress>) => void;
}) {
  return (
    <div className="border border-border rounded-lg p-4 mt-4">
      <h4 className="text-sm font-medium text-foreground mb-3">Pickup Address</h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Area</label>
          <input
            type="text"
            value={value.area}
            onChange={e => onChange({ area: e.target.value })}
            placeholder="e.g. Salmiya"
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Block</label>
          <input
            type="text"
            value={value.block}
            onChange={e => onChange({ block: e.target.value })}
            placeholder="e.g. 12"
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Street</label>
          <input
            type="text"
            value={value.street}
            onChange={e => onChange({ street: e.target.value })}
            placeholder="e.g. Gulf Road"
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Building</label>
          <input
            type="text"
            value={value.building}
            onChange={e => onChange({ building: e.target.value })}
            placeholder="e.g. Al Hamra"
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ShippingCarriersPage() {
  const params = useParams();
  const storeId = params.id as string;
  const { isEnabled } = useFeatures();
  const { success: toastSuccess, error: showError } = useToast();

  const featureEnabled = isEnabled('shipping_carriers');

  // Carrier configs state
  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState<CarrierConfigs>(DEFAULT_CONFIGS);

  // Save/test state
  const [savingCarrier, setSavingCarrier] = useState<string | null>(null);
  const [testingCarrier, setTestingCarrier] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<
    Record<string, 'idle' | 'testing' | 'success' | 'error'>
  >({ icarry: 'idle', aramex: 'idle' });

  // Shipments state
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [shipmentsTotal, setShipmentsTotal] = useState(0);
  const [shipmentsPage, setShipmentsPage] = useState(1);
  const shipmentsLimit = 10;
  const [carrierFilter, setCarrierFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  // ─── Data Fetching ──────────────────────────────────────────────────────────

  const fetchConfigs = useCallback(async () => {
    const { data } = await apiGet<{ configs: any[] }>(
      `/api/v1/stores/${storeId}/shipping-carriers/configs`
    );
    if (data?.configs) {
      const merged: CarrierConfigs = { ...DEFAULT_CONFIGS };
      for (const cfg of data.configs) {
        const code = cfg.carrierCode as keyof CarrierConfigs;
        if (code === 'icarry') {
          merged.icarry = {
            enabled: cfg.enabled ?? false,
            isDefault: cfg.isDefault ?? false,
            apiKey: cfg.credentials?.apiKey ? '••••' + cfg.credentials.apiKey.slice(-4) : '',
            merchantId: cfg.credentials?.merchantId ?? '',
            pickup: {
              area: cfg.settings?.pickupArea ?? '',
              block: cfg.settings?.pickupBlock ?? '',
              street: cfg.settings?.pickupStreet ?? '',
              building: cfg.settings?.pickupBuilding ?? '',
            },
          };
        } else if (code === 'aramex') {
          merged.aramex = {
            enabled: cfg.enabled ?? false,
            isDefault: cfg.isDefault ?? false,
            accountNumber: cfg.credentials?.accountNumber ?? '',
            accountPin: cfg.credentials?.accountPin
              ? '••••' + cfg.credentials.accountPin.slice(-4)
              : '',
            accountEntity: cfg.credentials?.accountEntity ?? '',
            accountCountryCode: cfg.credentials?.accountCountryCode ?? 'KW',
            username: cfg.credentials?.username ?? '',
            password: cfg.credentials?.password ? '••••' : '',
            pickup: {
              area: cfg.settings?.pickupArea ?? '',
              block: cfg.settings?.pickupBlock ?? '',
              street: cfg.settings?.pickupStreet ?? '',
              building: cfg.settings?.pickupBuilding ?? '',
            },
          };
        }
      }
      setConfigs(merged);
    }
  }, [storeId]);

  const fetchShipments = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(shipmentsPage), limit: String(shipmentsLimit) });
    if (carrierFilter !== 'all') qs.set('carrier', carrierFilter);
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    const { data } = await apiGet<ShipmentsData>(`/api/v1/stores/${storeId}/shipments?${qs}`);
    if (data) {
      setShipments(data.shipments || []);
      setShipmentsTotal(data.total || 0);
    }
  }, [storeId, shipmentsPage, shipmentsLimit, carrierFilter, statusFilter]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchConfigs(), fetchShipments()]);
    setLoading(false);
  }, [fetchConfigs, fetchShipments]);

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    if (!loading) fetchShipments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipmentsPage, carrierFilter, statusFilter]);

  // ─── Save Carrier Config ────────────────────────────────────────────────────

  const handleSaveCarrier = async (carrier: 'icarry' | 'aramex') => {
    setSavingCarrier(carrier);
    try {
      const cfg = configs[carrier];
      const body =
        carrier === 'icarry'
          ? {
              enabled: cfg.enabled,
              credentials: {
                apiKey: (cfg as ICarryConfig).apiKey,
                merchantId: (cfg as ICarryConfig).merchantId,
              },
              settings: {
                pickupArea: cfg.pickup.area,
                pickupBlock: cfg.pickup.block,
                pickupStreet: cfg.pickup.street,
                pickupBuilding: cfg.pickup.building,
              },
            }
          : {
              enabled: cfg.enabled,
              credentials: {
                accountNumber: (cfg as AramexConfig).accountNumber,
                accountPin: (cfg as AramexConfig).accountPin,
                accountEntity: (cfg as AramexConfig).accountEntity,
                accountCountryCode: (cfg as AramexConfig).accountCountryCode,
                username: (cfg as AramexConfig).username,
                password: (cfg as AramexConfig).password,
              },
              settings: {
                pickupArea: cfg.pickup.area,
                pickupBlock: cfg.pickup.block,
                pickupStreet: cfg.pickup.street,
                pickupBuilding: cfg.pickup.building,
              },
            };

      const { error } = await apiPut(
        `/api/v1/stores/${storeId}/shipping-carriers/configs/${carrier}`,
        body
      );
      if (!error) {
        toastSuccess('Saved', `${carrierLabel(carrier)} settings saved.`);
      } else {
        showError('Error', error.message || 'Failed to save settings.');
      }
    } catch (err) {
      console.error('Failed to save carrier config:', err);
      showError('Error', 'Failed to save settings. Please try again.');
    } finally {
      setSavingCarrier(null);
    }
  };

  // ─── Test Connection ────────────────────────────────────────────────────────

  const handleTestConnection = async (carrier: 'icarry' | 'aramex') => {
    setTestingCarrier(carrier);
    setTestStatus(prev => ({ ...prev, [carrier]: 'testing' }));
    try {
      const { error } = await apiPost(
        `/api/v1/stores/${storeId}/shipping-carriers/test/${carrier}`
      );
      if (!error) {
        setTestStatus(prev => ({ ...prev, [carrier]: 'success' }));
        toastSuccess('Connection OK', `${carrierLabel(carrier)} connection test passed.`);
      } else {
        setTestStatus(prev => ({ ...prev, [carrier]: 'error' }));
        showError('Connection Failed', error.message || 'Test failed.');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setTestStatus(prev => ({ ...prev, [carrier]: 'error' }));
      showError('Error', 'Test connection failed.');
    } finally {
      setTestingCarrier(null);
    }
  };

  // ─── Set Default ────────────────────────────────────────────────────────────

  const handleSetDefault = async (carrier: 'icarry' | 'aramex') => {
    setSettingDefault(carrier);
    try {
      const { error } = await apiPost(
        `/api/v1/stores/${storeId}/shipping-carriers/default/${carrier}`
      );
      if (!error) {
        setConfigs(prev => ({
          icarry: { ...prev.icarry, isDefault: carrier === 'icarry' },
          aramex: { ...prev.aramex, isDefault: carrier === 'aramex' },
        }));
        toastSuccess('Default Set', `${carrierLabel(carrier)} is now the default carrier.`);
      } else {
        showError('Error', error.message || 'Failed to set default carrier.');
      }
    } catch (err) {
      console.error('Set default error:', err);
      showError('Error', 'Failed to set default carrier.');
    } finally {
      setSettingDefault(null);
    }
  };

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function carrierLabel(carrier: string): string {
    return carrier === 'icarry' ? 'iCarry' : 'Aramex';
  }

  function updateICarry(patch: Partial<ICarryConfig>) {
    setConfigs(prev => ({ ...prev, icarry: { ...prev.icarry, ...patch } }));
  }

  function updateAramex(patch: Partial<AramexConfig>) {
    setConfigs(prev => ({ ...prev, aramex: { ...prev.aramex, ...patch } }));
  }

  function updateICarryPickup(patch: Partial<PickupAddress>) {
    setConfigs(prev => ({
      ...prev,
      icarry: { ...prev.icarry, pickup: { ...prev.icarry.pickup, ...patch } },
    }));
  }

  function updateAramexPickup(patch: Partial<PickupAddress>) {
    setConfigs(prev => ({
      ...prev,
      aramex: { ...prev.aramex, pickup: { ...prev.aramex.pickup, ...patch } },
    }));
  }

  const shipmentsPages = Math.max(1, Math.ceil(shipmentsTotal / shipmentsLimit));

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <AdminLayout
      title="Shipping Carriers"
      subtitle="Configure iCarry and Aramex delivery integrations"
    >
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : !featureEnabled ? (
        // ── Empty state ──────────────────────────────────────────────────────
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 bg-cyan-100 rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-cyan-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">
            Shipping Carriers not enabled
          </h2>
          <p className="text-muted-foreground max-w-md">
            Enable the Shipping Carriers feature in your store features to configure iCarry and
            Aramex delivery integrations.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── iCarry ──────────────────────────────────────────────────────── */}
          <div className="bg-card rounded-xl border border-border p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-cyan-100 rounded-xl flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-cyan-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"
                    />
                  </svg>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-foreground">iCarry</h2>
                    {configs.icarry.isDefault && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-primary">
                        Default
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Kuwait delivery via iCarry</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">
                  {configs.icarry.enabled ? 'Enabled' : 'Disabled'}
                </span>
                <Toggle
                  checked={configs.icarry.enabled}
                  onChange={val => updateICarry({ enabled: val })}
                />
              </div>
            </div>

            {/* iCarry credentials */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  API Key
                </label>
                <input
                  type="password"
                  value={configs.icarry.apiKey}
                  onChange={e => updateICarry({ apiKey: e.target.value })}
                  placeholder="iCarry API key"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Merchant ID
                </label>
                <input
                  type="text"
                  value={configs.icarry.merchantId}
                  onChange={e => updateICarry({ merchantId: e.target.value })}
                  placeholder="e.g. MERCH-001"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                />
              </div>
            </div>

            <PickupAddressForm value={configs.icarry.pickup} onChange={updateICarryPickup} />

            <div className="flex items-center gap-3 mt-4 flex-wrap">
              <button
                onClick={() => handleSaveCarrier('icarry')}
                disabled={savingCarrier === 'icarry'}
                className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
              >
                {savingCarrier === 'icarry' && (
                  <span className="animate-spin inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                )}
                Save
              </button>
              <button
                onClick={() => handleTestConnection('icarry')}
                disabled={testingCarrier === 'icarry'}
                className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
              >
                Test Connection
              </button>
              {!configs.icarry.isDefault && (
                <button
                  onClick={() => handleSetDefault('icarry')}
                  disabled={settingDefault === 'icarry'}
                  className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
                >
                  {settingDefault === 'icarry' && (
                    <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                  )}
                  Set as Default
                </button>
              )}
              <ConnectionStatus status={testStatus.icarry} />
            </div>
          </div>

          {/* ── Aramex ──────────────────────────────────────────────────────── */}
          <div className="bg-card rounded-xl border border-border p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-red-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                    />
                  </svg>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-foreground">Aramex</h2>
                    {configs.aramex.isDefault && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-primary">
                        Default
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">International delivery via Aramex</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">
                  {configs.aramex.enabled ? 'Enabled' : 'Disabled'}
                </span>
                <Toggle
                  checked={configs.aramex.enabled}
                  onChange={val => updateAramex({ enabled: val })}
                />
              </div>
            </div>

            {/* Aramex credentials */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Account Number
                </label>
                <input
                  type="text"
                  value={configs.aramex.accountNumber}
                  onChange={e => updateAramex({ accountNumber: e.target.value })}
                  placeholder="Aramex account number"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">PIN</label>
                <input
                  type="password"
                  value={configs.aramex.accountPin}
                  onChange={e => updateAramex({ accountPin: e.target.value })}
                  placeholder="Account PIN"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Entity
                </label>
                <input
                  type="text"
                  value={configs.aramex.accountEntity}
                  onChange={e => updateAramex({ accountEntity: e.target.value })}
                  placeholder="e.g. KWI"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Country Code
                </label>
                <input
                  type="text"
                  value={configs.aramex.accountCountryCode}
                  onChange={e => updateAramex({ accountCountryCode: e.target.value })}
                  placeholder="e.g. KW"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Username
                </label>
                <input
                  type="text"
                  value={configs.aramex.username}
                  onChange={e => updateAramex({ username: e.target.value })}
                  placeholder="Aramex account username"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Password
                </label>
                <input
                  type="password"
                  value={configs.aramex.password}
                  onChange={e => updateAramex({ password: e.target.value })}
                  placeholder="Aramex account password"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                />
              </div>
            </div>

            <PickupAddressForm value={configs.aramex.pickup} onChange={updateAramexPickup} />

            <div className="flex items-center gap-3 mt-4 flex-wrap">
              <button
                onClick={() => handleSaveCarrier('aramex')}
                disabled={savingCarrier === 'aramex'}
                className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
              >
                {savingCarrier === 'aramex' && (
                  <span className="animate-spin inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                )}
                Save
              </button>
              <button
                onClick={() => handleTestConnection('aramex')}
                disabled={testingCarrier === 'aramex'}
                className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
              >
                Test Connection
              </button>
              {!configs.aramex.isDefault && (
                <button
                  onClick={() => handleSetDefault('aramex')}
                  disabled={settingDefault === 'aramex'}
                  className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
                >
                  {settingDefault === 'aramex' && (
                    <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                  )}
                  Set as Default
                </button>
              )}
              <ConnectionStatus status={testStatus.aramex} />
            </div>
          </div>

          {/* ── Active Shipments ─────────────────────────────────────────────── */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Active Shipments</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {shipmentsTotal} total shipment{shipmentsTotal !== 1 ? 's' : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={carrierFilter}
                  onChange={e => {
                    setCarrierFilter(e.target.value);
                    setShipmentsPage(1);
                  }}
                  aria-label="Filter by carrier"
                  className="px-3 py-1.5 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                >
                  <option value="all">All carriers</option>
                  <option value="icarry">iCarry</option>
                  <option value="aramex">Aramex</option>
                </select>
                <select
                  value={statusFilter}
                  onChange={e => {
                    setStatusFilter(e.target.value);
                    setShipmentsPage(1);
                  }}
                  aria-label="Filter by status"
                  className="px-3 py-1.5 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
                >
                  <option value="all">All statuses</option>
                  <option value="created">Created</option>
                  <option value="picked_up">Picked Up</option>
                  <option value="in_transit">In Transit</option>
                  <option value="out_for_delivery">Out for Delivery</option>
                  <option value="delivered">Delivered</option>
                  <option value="failed">Failed</option>
                  <option value="returned">Returned</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            </div>

            {shipments.length === 0 ? (
              <div className="p-12 text-center">
                <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg
                    className="w-6 h-6 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"
                    />
                  </svg>
                </div>
                <p className="text-muted-foreground text-sm">No shipments found</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full" aria-label="Shipping carriers">
                    <thead>
                      <tr className="bg-muted border-b border-border">
                        <th
                          scope="col"
                          className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                        >
                          Order #
                        </th>
                        <th
                          scope="col"
                          className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                        >
                          Carrier
                        </th>
                        <th
                          scope="col"
                          className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                        >
                          Tracking #
                        </th>
                        <th
                          scope="col"
                          className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                        >
                          Status
                        </th>
                        <th
                          scope="col"
                          className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                        >
                          Created
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {shipments.map(shipment => (
                        <tr key={shipment.id} className="hover:bg-muted">
                          <td className="px-6 py-3 text-sm font-medium text-foreground">
                            {shipment.orderNumber}
                          </td>
                          <td className="px-6 py-3 text-sm text-foreground capitalize">
                            {carrierLabel(shipment.carrierCode)}
                          </td>
                          <td className="px-6 py-3 text-sm text-muted-foreground font-mono">
                            {shipment.trackingNumber || '—'}
                          </td>
                          <td className="px-6 py-3">
                            <ShipmentStatusBadge status={shipment.status} />
                          </td>
                          <td className="px-6 py-3 text-sm text-muted-foreground whitespace-nowrap">
                            {new Date(shipment.createdAt).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {shipmentsPages > 1 && (
                  <div className="flex items-center justify-between px-6 py-4 border-t border-border">
                    <p className="text-sm text-muted-foreground">
                      Page {shipmentsPage} of {shipmentsPages} ({shipmentsTotal} total)
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShipmentsPage(p => Math.max(1, p - 1))}
                        disabled={shipmentsPage === 1}
                        className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Previous
                      </button>
                      <button
                        onClick={() => setShipmentsPage(p => Math.min(shipmentsPages, p + 1))}
                        disabled={shipmentsPage === shipmentsPages}
                        className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
