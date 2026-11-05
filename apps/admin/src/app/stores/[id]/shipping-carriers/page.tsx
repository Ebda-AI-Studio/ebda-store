'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet } from '../../../../lib/api';
import { useFeatures } from '../../../../hooks/useFeatures';
import { useT } from '@/i18n/useT';
import { BRAND, providerRequestMailto, providersOfKind } from '@ebda/shared';
import { ShippingTabs } from '../shipping/_components/ShippingTabs';
import { ShippingCarriersEmptyState } from './_components/ShippingCarriersEmptyState';
import { CarrierConnectCard } from './_components/CarrierConnectCard';
import { ManualCarrierCard } from './_components/ManualCarrierCard';
import { ShipmentsTable } from './_components/ShipmentsTable';
import type { CarrierConfigRow, Shipment, ShipmentsData } from './_components/types';

import { useRequireFeature } from '../../../../hooks/useRequireFeature';

// Carriers are schema-driven from the provider catalog; manual delivery keeps its info card.
const CARRIERS = providersOfKind('shipping').filter(p => !p.manual);

export default function ShippingCarriersPage() {
  const { gate } = useRequireFeature('shipping_carriers');

  const params = useParams();
  const storeId = params.id as string;
  const { isEnabled } = useFeatures();
  const tPage = useT('shipping.carriers.page');
  const tHub = useT('shippingHub');
  const tConnect = useT('shipping.carriers.connect');

  const featureEnabled = isEnabled('shipping_carriers');

  // Carrier configs state
  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState<CarrierConfigRow[]>([]);

  // Shipments state
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [shipmentsTotal, setShipmentsTotal] = useState(0);
  const [shipmentsPage, setShipmentsPage] = useState(1);
  const shipmentsLimit = 10;
  const [carrierFilter, setCarrierFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  // ─── Data Fetching ──────────────────────────────────────────────────────────

  const fetchConfigs = useCallback(async () => {
    const { data } = await apiGet<{ configs: CarrierConfigRow[] }>(
      `/api/v1/stores/${storeId}/shipping-carriers/configs`
    );
    if (data?.configs) setConfigs(data.configs);
  }, [storeId]);

  const fetchShipments = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(shipmentsPage), limit: String(shipmentsLimit) });
    if (carrierFilter !== 'all') qs.set('carrier', carrierFilter);
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    const { data } = await apiGet<ShipmentsData>(`/api/v1/stores/${storeId}/shipments?${qs}`);
    if (data) {
      setShipments(
        (data.shipments || []).map(row => ({
          id: row.id,
          orderNumber: row.order?.orderNumber ?? '',
          carrierCode: row.carrier,
          trackingNumber: row.trackingNumber,
          status: row.status,
          createdAt: row.createdAt,
        }))
      );
      setShipmentsTotal(data.meta?.total ?? 0);
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

  const shipmentsPages = Math.max(1, Math.ceil(shipmentsTotal / shipmentsLimit));

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (gate) return gate;

  return (
    <AdminLayout title={tHub('title')} subtitle={tPage('subtitle')}>
      <ShippingTabs />
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : !featureEnabled ? (
        <ShippingCarriersEmptyState />
      ) : (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
            {tPage('intro')}
          </div>

          {CARRIERS.map(entry => (
            <CarrierConnectCard
              key={entry.code}
              entry={entry}
              config={configs.find(c => c.carrier === entry.code)}
              storeId={storeId}
              onChanged={async () => {
                await fetchConfigs();
              }}
            />
          ))}

          <ManualCarrierCard storeId={storeId} />

          <p className="text-sm text-muted-foreground">
            <a
              href={providerRequestMailto(BRAND.supportEmail, 'shipping')}
              className="text-primary underline"
            >
              {tConnect('requestCarrier')}
            </a>
          </p>

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
