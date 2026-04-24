'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../../../../lib/api';
import { ShippingZonesTable, type ShippingZone } from './_components/ShippingZonesTable';
import { ShippingZoneFormModal, type ZoneFormData } from './_components/ShippingZoneFormModal';
import { ShippingEmptyState } from './_components/ShippingEmptyState';

const KUWAIT_GOVERNORATES = [
  { en: 'Capital', ar: 'العاصمة' },
  { en: 'Hawalli', ar: 'حولي' },
  { en: 'Farwaniya', ar: 'الفروانية' },
  { en: 'Mubarak Al-Kabeer', ar: 'مبارك الكبير' },
  { en: 'Ahmadi', ar: 'الأحمدي' },
  { en: 'Jahra', ar: 'الجهراء' },
];

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
        <div className="flex gap-2 mb-6">
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
