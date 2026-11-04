'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../../../../lib/api';
import { textFieldValue } from '../../../../lib/form-text';
import { useLatestRequest } from '../../../../hooks/useLatestRequest';
import { useConfirm } from '../../../../hooks/useConfirm';
import { TaxGeneralSettings } from './_components/TaxGeneralSettings';
import { TaxSteps } from './_components/TaxSteps';
import { TaxRatesTable } from './_components/TaxRatesTable';
import { TaxRateFormModal } from './_components/TaxRateFormModal';
import { TaxInfoBox } from './_components/TaxInfoBox';
import { TaxVerificationCard } from './_components/TaxVerificationCard';
import { EtaConnectionCard } from './_components/EtaConnectionCard';
import { useFeatures } from '@/hooks/useFeatures';
import { TAX_NOT_VERIFIED_CODE, type TaxProfileStatusValue } from '@ebda/shared';
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
  // obligation, not a plan feature, so the on/off switch and the rate list must
  // work on every plan — including a store that lapsed to `free`. Switching VAT
  // ON additionally needs a VERIFIED VAT registration (ruling TAX-2).
  const params = useParams();
  const storeId = params.id as string;
  const tPage = useT('tax.page');
  const tEnable = useT('tax.settings.enable');
  const tSteps = useT('tax.steps');
  const askConfirm = useConfirm();
  const { error: toastError } = useToast();
  const { isEnabled, isLoading: featuresLoading } = useFeatures();

  const [settings, setSettings] = useState<TaxSettings>({
    taxEnabled: false,
    taxIncludedInPrice: false,
  });
  // Every active rate, whatever the list filter shows — the combined figure
  // in the info box must be what the charge applies.
  const [activeRates, setActiveRates] = useState<TaxRate[]>([]);
  const [rates, setRates] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(true);
  // VAT gate (ruling TAX-2): the enable toggle only unlocks once the profile is verified.
  const [vatStatus, setVatStatus] = useState<TaxProfileStatusValue | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const lastVatStatus = useRef<TaxProfileStatusValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingRate, setEditingRate] = useState<TaxRate | null>(null);
  const [formData, setFormData] = useState<RateFormData>(DEFAULT_FORM);
  const [filter, setFilter] = useState<RateFilter>('all');
  // Bumped after a rate mutation: an effect owns the refetch, so it reads the CURRENT filter
  // instead of the one captured when the handler's closure rendered (issue 2443).
  const [refreshKey, setRefreshKey] = useState(0);
  // Latest-request-wins: a slower response for the previous filter must not repaint its rows.
  const beginRequest = useLatestRequest();

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
    const isLatest = beginRequest();
    const qs = new URLSearchParams();
    if (filter !== 'all') {
      qs.set('includeInactive', 'true');
    }

    const { data } = await apiGet<{ rates: TaxRate[] }>(
      `/api/v1/stores/${storeId}/tax/rates?${qs}`
    );
    if (!isLatest()) return;
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
  }, [storeId, filter, beginRequest]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchSettings(), fetchRates()]);
    setLoading(false);
  }, [fetchSettings, fetchRates]);

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, filter]);

  useEffect(() => {
    if (refreshKey > 0) fetchRates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const handleSaveSettings = async (newSettings: Partial<TaxSettings>) => {
    setSavingSettings(true);
    setSettingsError(null);
    try {
      const { data, error } = await apiPut<{ settings: TaxSettings }>(
        `/api/v1/stores/${storeId}/tax/settings`,
        newSettings
      );
      if (data) {
        setSettings(data.settings);
      } else if (error) {
        // The optimistic toggle must not stay lit when the server refused it.
        setSettingsError(
          error.code === TAX_NOT_VERIFIED_CODE
            ? error.message || tEnable('notVerifiedFallback')
            : error.message
        );
        await fetchSettings();
      }
    } catch (err) {
      console.error('Failed to save tax settings:', err);
      await fetchSettings();
    } finally {
      setSavingSettings(false);
    }
  };

  const handleVatStatus = useCallback(
    (status: TaxProfileStatusValue) => {
      setVatStatus(status);
      // A revoke switches VAT off server-side: re-read so the toggle matches.
      if (lastVatStatus.current !== null && lastVatStatus.current !== status) fetchSettings();
      lastVatStatus.current = status;
    },
    [fetchSettings]
  );

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
        setRefreshKey(k => k + 1);
      } else {
        toastError(tPage('rateSaveFailed'), error.message || '');
      }
    } catch (err) {
      console.error('Failed to save tax rate:', err);
      toastError(tPage('rateSaveFailed'), '');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rate: TaxRate) => {
    try {
      const { error } = await apiPatch(`/api/v1/stores/${storeId}/tax/rates/${rate.id}/toggle`);
      if (error) toastError(tPage('rateToggleFailed'), error.message || '');
      setRefreshKey(k => k + 1);
    } catch (err) {
      console.error('Failed to toggle tax rate:', err);
      toastError(tPage('rateToggleFailed'), '');
    }
  };

  const handleDelete = async (rate: TaxRate) => {
    const ok = await askConfirm({
      object: tPage('rateDeleteObject', { name: rate.nameAr || rate.name }),
      consequence: tPage('rateDeleteConsequence'),
      confirmLabel: tPage('rateDeleteLabel'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const { error } = await apiDelete(`/api/v1/stores/${storeId}/tax/rates/${rate.id}`);
      if (error) toastError(tPage('rateDeleteFailed'), error.message || '');
      setRefreshKey(k => k + 1);
    } catch (err) {
      console.error('Failed to delete tax rate:', err);
      toastError(tPage('rateDeleteFailed'), '');
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

  const etaStep = !featuresLoading && isEnabled('eta_ereceipt');
  const taxSteps = [
    {
      id: 'register',
      label: tSteps('register'),
      done: vatStatus === 'verified',
      href: '#tax-register',
    },
    ...(etaStep ? [{ id: 'eta', label: tSteps('eta'), done: false, href: '#tax-eta' }] : []),
    { id: 'rates', label: tSteps('rates'), done: activeRates.length > 0, href: '#tax-rates' },
  ];

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
            <TaxSteps steps={taxSteps} />
            <div id="tax-register" className="scroll-mt-24">
              <TaxVerificationCard storeId={storeId} onStatusChange={handleVatStatus} />
            </div>
            {!featuresLoading && isEnabled('eta_ereceipt') && vatStatus === 'verified' ? (
              <div id="tax-eta" className="scroll-mt-24">
                <EtaConnectionCard storeId={storeId} />
              </div>
            ) : null}
            <TaxGeneralSettings
              vatVerified={vatStatus === 'verified'}
              errorMessage={settingsError}
              settings={settings}
              savingSettings={savingSettings}
              onSettingsChange={setSettings}
              onSaveSettings={handleSaveSettings}
            />
            <p className="text-sm text-muted-foreground">
              {tPage('timeZoneMoved')}{' '}
              <Link
                href={`/stores/${storeId}/language`}
                className="font-medium text-primary-ink underline underline-offset-2"
              >
                {tPage('timeZoneLink')}
              </Link>
            </p>
            <div id="tax-rates" className="scroll-mt-24">
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
            </div>
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
