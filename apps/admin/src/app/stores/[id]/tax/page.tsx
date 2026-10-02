'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../../../../lib/api';
import { textFieldValue } from '../../../../lib/form-text';
import { TaxGeneralSettings } from './_components/TaxGeneralSettings';
import { TaxTimeZoneCard } from './_components/TaxTimeZoneCard';
import { TaxRatesTable } from './_components/TaxRatesTable';
import { TaxRateFormModal } from './_components/TaxRateFormModal';
import { TaxInfoBox } from './_components/TaxInfoBox';
import {
  DEFAULT_FORM,
  type RateFilter,
  type RateFormData,
  type TaxRate,
  type TaxSettings,
  type TaxTemplate,
} from './_components/types';

export default function TaxSettingsPage() {
  // Not feature-gated (issue 2358, ruling TAX-1a): tax collection is a legal
  // obligation gated on `taxEnabled` alone, so the on/off switch and the rate
  // list must work on every plan — including a store that lapsed to `free`.
  const params = useParams();
  const storeId = params.id as string;
  const tPage = useT('tax.page');

  const [settings, setSettings] = useState<TaxSettings>({
    taxEnabled: false,
    taxIncludedInPrice: false,
  });
  // Every active rate, whatever the list filter shows — the combined figure
  // in the info box must be what the charge applies.
  const [activeRates, setActiveRates] = useState<TaxRate[]>([]);
  const [rates, setRates] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingRate, setEditingRate] = useState<TaxRate | null>(null);
  const [formData, setFormData] = useState<RateFormData>(DEFAULT_FORM);
  const [filter, setFilter] = useState<RateFilter>('all');

  const fetchSettings = useCallback(async () => {
    const { data } = await apiGet<{ settings: TaxSettings }>(
      `/api/v1/stores/${storeId}/tax/settings`
    );
    if (data) {
      setSettings(
        data.settings
          ? {
              taxEnabled: data.settings.taxEnabled,
              taxIncludedInPrice: data.settings.taxIncludedInPrice,
            }
          : { taxEnabled: false, taxIncludedInPrice: false }
      );
    }
  }, [storeId]);

  const fetchRates = useCallback(async () => {
    const qs = new URLSearchParams();
    if (filter !== 'all') {
      qs.set('includeInactive', 'true');
    }

    const { data } = await apiGet<{ rates: TaxRate[] }>(
      `/api/v1/stores/${storeId}/tax/rates?${qs}`
    );
    if (data) {
      let allRates = data.rates || [];

      if (filter === 'active') {
        allRates = allRates.filter((r: TaxRate) => r.isActive);
      } else if (filter === 'inactive') {
        allRates = allRates.filter((r: TaxRate) => !r.isActive);
      }

      setRates(allRates);
      setActiveRates((data.rates || []).filter((r: TaxRate) => r.isActive));
    }
  }, [storeId, filter]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchSettings(), fetchRates()]);
    setLoading(false);
  }, [fetchSettings, fetchRates]);

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, filter]);

  const handleSaveSettings = async (newSettings: Partial<TaxSettings>) => {
    setSavingSettings(true);
    try {
      const { data } = await apiPut<{ settings: TaxSettings }>(
        `/api/v1/stores/${storeId}/tax/settings`,
        newSettings
      );
      if (data) {
        setSettings(data.settings);
      }
    } catch (err) {
      console.error('Failed to save tax settings:', err);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleOpenModal = (rate?: TaxRate) => {
    if (rate) {
      setEditingRate(rate);
      setFormData({
        name: rate.name,
        nameAr: rate.nameAr || '',
        rate: rate.rate.toString(),
        isActive: rate.isActive,
      });
    } else {
      setEditingRate(null);
      setFormData(DEFAULT_FORM);
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingRate(null);
    setFormData(DEFAULT_FORM);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      // Reused by the PUT (edit) branch below — an emptied optional field
      // must send null to actually clear it, not undefined.
      const intent = editingRate ? 'update' : 'create';
      const body = {
        name: formData.name,
        nameAr: textFieldValue(formData.nameAr, intent),
        rate: parseFloat(formData.rate),
        isActive: formData.isActive,
      };

      const endpoint = editingRate
        ? `/api/v1/stores/${storeId}/tax/rates/${editingRate.id}`
        : `/api/v1/stores/${storeId}/tax/rates`;

      const { error } = editingRate ? await apiPut(endpoint, body) : await apiPost(endpoint, body);

      if (!error) {
        handleCloseModal();
        fetchRates();
      }
    } catch (err) {
      console.error('Failed to save tax rate:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rate: TaxRate) => {
    try {
      await apiPatch(`/api/v1/stores/${storeId}/tax/rates/${rate.id}/toggle`);
      fetchRates();
    } catch (err) {
      console.error('Failed to toggle tax rate:', err);
    }
  };

  const handleDelete = async (rate: TaxRate) => {
    try {
      await apiDelete(`/api/v1/stores/${storeId}/tax/rates/${rate.id}`);
      fetchRates();
    } catch (err) {
      console.error('Failed to delete tax rate:', err);
    }
  };

  const applyTaxTemplate = (template: TaxTemplate) => {
    setFormData(prev => ({
      ...prev,
      name: template.name,
      nameAr: template.nameAr,
      rate: template.rate.toString(),
    }));
  };

  const updateForm = (patch: Partial<RateFormData>) => setFormData(prev => ({ ...prev, ...patch }));

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      <div className="space-y-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : (
          <>
            <TaxGeneralSettings
              settings={settings}
              savingSettings={savingSettings}
              onSettingsChange={setSettings}
              onSaveSettings={handleSaveSettings}
            />
            <TaxTimeZoneCard storeId={storeId} />
            <TaxRatesTable
              rates={rates}
              filter={filter}
              taxEnabled={settings.taxEnabled}
              onFilterChange={setFilter}
              onAdd={() => handleOpenModal()}
              onEdit={rate => handleOpenModal(rate)}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
            <TaxInfoBox taxEnabled={settings.taxEnabled} activeRates={activeRates} />
          </>
        )}

        {showModal && (
          <TaxRateFormModal
            editingRate={editingRate}
            formData={formData}
            saving={saving}
            onFormChange={updateForm}
            onApplyTemplate={applyTaxTemplate}
            onClose={handleCloseModal}
            onSubmit={handleSubmit}
          />
        )}
      </div>
    </AdminLayout>
  );
}
