'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut, apiPost } from '../../../../lib/api';
import { useFeatures } from '../../../../hooks/useFeatures';
import { useT } from '@/i18n/useT';
import { ShippingCarriersEmptyState } from './_components/ShippingCarriersEmptyState';
import { ICarryCarrierCard } from './_components/ICarryCarrierCard';
import { AramexCarrierCard } from './_components/AramexCarrierCard';
import { ShipmentsTable } from './_components/ShipmentsTable';
import { type PickupAddress } from './_components/PickupAddressForm';
import {
  DEFAULT_CONFIGS,
  type AramexConfig,
  type CarrierConfigApiRow,
  type CarrierConfigs,
  type CarrierKey,
  type ICarryConfig,
  type Shipment,
  type ShipmentsData,
  type TestStatus,
} from './_components/types';

import { useRequireFeature } from '../../../../hooks/useRequireFeature';
const CARRIER_NAME_KEYS: Record<CarrierKey, string> = {
  icarry: 'carrierNames.icarry',
  aramex: 'carrierNames.aramex',
};

export default function ShippingCarriersPage() {
  // Hide this page when the super_admin disabled the shipping_carriers feature for
  // this store. The hook redirects to the store dashboard if disabled.
  useRequireFeature('shipping_carriers');

  const params = useParams();
  const storeId = params.id as string;
  const { isEnabled } = useFeatures();
  const { success: toastSuccess, error: showError } = useToast();
  const tPage = useT('shipping.carriers.page');
  const tShipments = useT('shipping.carriers.shipments');
  const tToast = useT('shipping.carriers.toast');

  const featureEnabled = isEnabled('shipping_carriers');

  // Carrier configs state
  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState<CarrierConfigs>(DEFAULT_CONFIGS);

  // Save/test state
  const [savingCarrier, setSavingCarrier] = useState<CarrierKey | null>(null);
  const [testingCarrier, setTestingCarrier] = useState<CarrierKey | null>(null);
  const [settingDefault, setSettingDefault] = useState<CarrierKey | null>(null);
  const [testStatus, setTestStatus] = useState<Record<CarrierKey, TestStatus>>({
    icarry: 'idle',
    aramex: 'idle',
  });

  // Shipments state
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [shipmentsTotal, setShipmentsTotal] = useState(0);
  const [shipmentsPage, setShipmentsPage] = useState(1);
  const shipmentsLimit = 10;
  const [carrierFilter, setCarrierFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  // ─── Data Fetching ──────────────────────────────────────────────────────────

  const fetchConfigs = useCallback(async () => {
    const { data } = await apiGet<{ configs: CarrierConfigApiRow[] }>(
      `/api/v1/stores/${storeId}/shipping-carriers/configs`
    );
    if (data?.configs) {
      const merged: CarrierConfigs = { ...DEFAULT_CONFIGS };
      for (const cfg of data.configs) {
        const code = cfg.carrierCode as CarrierKey;
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

  // ─── Helpers ────────────────────────────────────────────────────────────────

  const carrierLabel = useCallback(
    (carrier: CarrierKey): string => tShipments(CARRIER_NAME_KEYS[carrier]),
    [tShipments]
  );

  // ─── Save Carrier Config ────────────────────────────────────────────────────

  const handleSaveCarrier = async (carrier: CarrierKey) => {
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
        toastSuccess(
          tToast('savedTitle'),
          tToast('savedDescription', { carrier: carrierLabel(carrier) })
        );
      } else {
        showError(tToast('errorTitle'), error.message || tToast('saveFailed'));
      }
    } catch (err) {
      console.error('Failed to save carrier config:', err);
      showError(tToast('errorTitle'), tToast('saveFailedRetry'));
    } finally {
      setSavingCarrier(null);
    }
  };

  // ─── Test Connection ────────────────────────────────────────────────────────

  const handleTestConnection = async (carrier: CarrierKey) => {
    setTestingCarrier(carrier);
    setTestStatus(prev => ({ ...prev, [carrier]: 'testing' }));
    try {
      const { error } = await apiPost(
        `/api/v1/stores/${storeId}/shipping-carriers/test/${carrier}`
      );
      if (!error) {
        setTestStatus(prev => ({ ...prev, [carrier]: 'success' }));
        toastSuccess(
          tToast('connectionOkTitle'),
          tToast('connectionOkDescription', { carrier: carrierLabel(carrier) })
        );
      } else {
        setTestStatus(prev => ({ ...prev, [carrier]: 'error' }));
        showError(tToast('connectionFailedTitle'), error.message || tToast('testFailed'));
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setTestStatus(prev => ({ ...prev, [carrier]: 'error' }));
      showError(tToast('errorTitle'), tToast('testFailedRetry'));
    } finally {
      setTestingCarrier(null);
    }
  };

  // ─── Set Default ────────────────────────────────────────────────────────────

  const handleSetDefault = async (carrier: CarrierKey) => {
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
        toastSuccess(
          tToast('defaultSetTitle'),
          tToast('defaultSetDescription', { carrier: carrierLabel(carrier) })
        );
      } else {
        showError(tToast('errorTitle'), error.message || tToast('defaultSetFailed'));
      }
    } catch (err) {
      console.error('Set default error:', err);
      showError(tToast('errorTitle'), tToast('defaultSetFailed'));
    } finally {
      setSettingDefault(null);
    }
  };

  // ─── Config Patchers ────────────────────────────────────────────────────────

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
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : !featureEnabled ? (
        <ShippingCarriersEmptyState />
      ) : (
        <div className="space-y-6">
          <ICarryCarrierCard
            config={configs.icarry}
            saving={savingCarrier === 'icarry'}
            testing={testingCarrier === 'icarry'}
            settingDefault={settingDefault === 'icarry'}
            testStatus={testStatus.icarry}
            onConfigChange={updateICarry}
            onPickupChange={updateICarryPickup}
            onSave={() => handleSaveCarrier('icarry')}
            onTest={() => handleTestConnection('icarry')}
            onSetDefault={() => handleSetDefault('icarry')}
          />

          <AramexCarrierCard
            config={configs.aramex}
            saving={savingCarrier === 'aramex'}
            testing={testingCarrier === 'aramex'}
            settingDefault={settingDefault === 'aramex'}
            testStatus={testStatus.aramex}
            onConfigChange={updateAramex}
            onPickupChange={updateAramexPickup}
            onSave={() => handleSaveCarrier('aramex')}
            onTest={() => handleTestConnection('aramex')}
            onSetDefault={() => handleSetDefault('aramex')}
          />

          <ShipmentsTable
            shipments={shipments}
            total={shipmentsTotal}
            page={shipmentsPage}
            pages={shipmentsPages}
            carrierFilter={carrierFilter}
            statusFilter={statusFilter}
            onCarrierFilterChange={value => {
              setCarrierFilter(value);
              setShipmentsPage(1);
            }}
            onStatusFilterChange={value => {
              setStatusFilter(value);
              setShipmentsPage(1);
            }}
            onPageChange={updater => setShipmentsPage(prev => updater(prev))}
          />
        </div>
      )}
    </AdminLayout>
  );
}
