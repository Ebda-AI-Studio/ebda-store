'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { KUWAIT_GOVERNORATES } from '@force/shared';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../../../../lib/api';
import { ShippingZonesTable, type ShippingZone } from './_components/ShippingZonesTable';
import { ShippingZoneFormModal, type ZoneFormData } from './_components/ShippingZoneFormModal';
import { ShippingEmptyState } from './_components/ShippingEmptyState';
import { useFeatures } from '../../../../hooks/useFeatures';
import { AreaRateEditor } from './_components/AreaRateEditor';

const DEFAULT_FORM: ZoneFormData = {
  name: '',
  nameAr: '',
  areas: '',
  areasAr: '',
  deliveryFee: '',
  freeShippingThreshold: '',
  estimatedDaysMin: '',
  estimatedDaysMax: '',
  isActive: true,
};

export default function ShippingSettingsPage() {
  const params = useParams();
  const storeId = params.id as string;
  const tPage = useT('shipping.page');
  const tToolbar = useT('shipping.toolbar');
  const tFilters = useT('shipping.filters');
  const { isEnabled } = useFeatures();
  const carriersEnabled = isEnabled('shipping_carriers');

  const [zones, setZones] = useState<ShippingZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingZone, setEditingZone] = useState<ShippingZone | null>(null);
  const [formData, setFormData] = useState<ZoneFormData>(DEFAULT_FORM);
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const fetchZones = useCallback(async () => {
    try {
      setLoading(true);
      const query = new URLSearchParams();
      if (filter === 'active') query.set('isActive', 'true');
      if (filter === 'inactive') query.set('isActive', 'false');

      const { data } = await apiGet<{ zones: ShippingZone[] }>(
        `/api/v1/stores/${storeId}/shipping?${query}`
      );
      if (data) {
        setZones(data.zones || []);
      }
    } catch (err) {
      console.error('Failed to fetch shipping zones:', err);
    } finally {
      setLoading(false);
    }
  }, [storeId, filter]);

  useEffect(() => {
    fetchZones();
  }, [fetchZones]);

  const handleOpenModal = (zone?: ShippingZone) => {
    if (zone) {
      setEditingZone(zone);
      setFormData({
        name: zone.name,
        nameAr: zone.nameAr || '',
        areas: zone.areas.join(', '),
        areasAr: zone.areasAr?.join(', ') || '',
        deliveryFee: (zone.deliveryFee / 1000).toFixed(3),
        freeShippingThreshold: zone.freeShippingThreshold
          ? (zone.freeShippingThreshold / 1000).toFixed(3)
          : '',
        estimatedDaysMin: zone.estimatedDaysMin?.toString() || '',
        estimatedDaysMax: zone.estimatedDaysMax?.toString() || '',
        isActive: zone.isActive,
      });
    } else {
      setEditingZone(null);
      setFormData(DEFAULT_FORM);
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingZone(null);
    setFormData(DEFAULT_FORM);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const areas = formData.areas
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);
      const areasAr = formData.areasAr
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);

      const body = {
        name: formData.name,
        nameAr: formData.nameAr || undefined,
        areas,
        areasAr: areasAr.length > 0 ? areasAr : undefined,
        deliveryFee: Math.round(parseFloat(formData.deliveryFee || '0') * 1000),
        freeShippingThreshold: formData.freeShippingThreshold
          ? Math.round(parseFloat(formData.freeShippingThreshold) * 1000)
          : undefined,
        estimatedDaysMin: formData.estimatedDaysMin
          ? parseInt(formData.estimatedDaysMin)
          : undefined,
        estimatedDaysMax: formData.estimatedDaysMax
          ? parseInt(formData.estimatedDaysMax)
          : undefined,
        isActive: formData.isActive,
      };

      const endpoint = editingZone
        ? `/api/v1/stores/${storeId}/shipping/${editingZone.id}`
        : `/api/v1/stores/${storeId}/shipping`;

      const { error } = editingZone ? await apiPut(endpoint, body) : await apiPost(endpoint, body);

      if (!error) {
        handleCloseModal();
        fetchZones();
      }
    } catch (err) {
      console.error('Failed to save shipping zone:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (zone: ShippingZone) => {
    try {
      await apiPatch(`/api/v1/stores/${storeId}/shipping/${zone.id}/toggle`);
      fetchZones();
    } catch (err) {
      console.error('Failed to toggle shipping zone:', err);
    }
  };

  const handleDelete = async (zone: ShippingZone) => {
    try {
      await apiDelete(`/api/v1/stores/${storeId}/shipping/${zone.id}`);
      fetchZones();
    } catch (err) {
      console.error('Failed to delete shipping zone:', err);
    }
  };

  const addGovernorateAreas = () => {
    const areas = KUWAIT_GOVERNORATES.map(g => g.en).join(', ');
    const areasAr = KUWAIT_GOVERNORATES.map(g => g.ar).join(', ');
    setFormData(prev => ({
      ...prev,
      areas: prev.areas ? `${prev.areas}, ${areas}` : areas,
      areasAr: prev.areasAr ? `${prev.areasAr}, ${areasAr}` : areasAr,
    }));
  };

  const filterLabels: Record<typeof filter, string> = {
    all: tFilters('all'),
    active: tFilters('active'),
    inactive: tFilters('inactive'),
  };

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <button
          type="button"
          onClick={() => handleOpenModal()}
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {tToolbar('addZone')}
        </button>
      }
    >
      <div className="space-y-6">
        <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          {tPage('intro')}
        </div>

        {/* Shipping Carriers callout — visible only when the feature is enabled.
            The carriers page lives at /stores/[id]/shipping-carriers and is
            intentionally separate (carrier credentials + shipment tracking).
            This banner bridges discoverability since both pages share the
            "Shipping" sidebar group. */}
        {carriersEnabled && (
          <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0 w-8 h-8 bg-cyan-100 rounded-full flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-cyan-600"
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
              <div>
                <p className="text-sm font-medium text-cyan-900">Shipping Carriers enabled</p>
                <p className="text-xs text-cyan-700">
                  Configure iCarry &amp; Aramex credentials, test connections, and view shipments.
                </p>
              </div>
            </div>
            <Link
              href={`/stores/${storeId}/shipping-carriers`}
              className="flex-shrink-0 px-3 py-1.5 text-sm font-medium text-cyan-700 border border-cyan-300 rounded-lg hover:bg-cyan-100 transition-colors"
            >
              Manage carriers →
            </Link>
          </div>
        )}

        {/* ── Area rates editor (primary / recommended) ─────────────────── */}
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Delivery areas &amp; fees{' '}
              <span className="font-arabic font-normal text-muted-foreground">
                / مناطق التوصيل والرسوم
              </span>
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Set per-area delivery fees for every Kuwait district.
            </p>
          </div>
          <AreaRateEditor storeId={storeId} />
        </section>

        {/* ── Legacy shipping zones (kept for backward compat) ───────────── */}
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">{tPage('title')}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">{tPage('subtitle')}</p>
          </div>

          <div className="flex gap-2">
            {(['all', 'active', 'inactive'] as const).map(f => (
              <button
                type="button"
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  filter === f
                    ? 'bg-primary text-white'
                    : 'bg-muted text-foreground hover:bg-muted/80'
                }`}
              >
                {filterLabels[f]}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : zones.length === 0 ? (
            <ShippingEmptyState onCreate={() => handleOpenModal()} />
          ) : (
            <ShippingZonesTable
              zones={zones}
              onEdit={handleOpenModal}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          )}
        </section>

        {showModal && (
          <ShippingZoneFormModal
            editingZone={editingZone}
            formData={formData}
            saving={saving}
            onChange={setFormData}
            onClose={handleCloseModal}
            onSubmit={handleSubmit}
            onAddAllGovernorates={addGovernorateAreas}
          />
        )}
      </div>
    </AdminLayout>
  );
}
