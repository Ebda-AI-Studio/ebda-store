'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../../../../lib/api';

interface TaxSettings {
  taxEnabled: boolean;
  taxIncludedInPrice: boolean;
  defaultTaxRate: number | null;
}

interface TaxRate {
  id: string;
  name: string;
  nameAr: string | null;
  rate: number;
  country: string | null;
  state: string | null;
  priority: number;
  isCompound: boolean;
  isActive: boolean;
  createdAt: string;
}

interface RateFormData {
  name: string;
  nameAr: string;
  rate: string;
  country: string;
  state: string;
  priority: string;
  isCompound: boolean;
  isActive: boolean;
}

const DEFAULT_FORM: RateFormData = {
  name: '',
  nameAr: '',
  rate: '',
  country: '',
  state: '',
  priority: '0',
  isCompound: false,
  isActive: true,
};

const COMMON_TAX_TYPES = [
  { name: 'VAT', nameAr: 'ضريبة القيمة المضافة', rate: 5 },
  { name: 'GST', nameAr: 'ضريبة السلع والخدمات', rate: 5 },
  { name: 'Sales Tax', nameAr: 'ضريبة المبيعات', rate: 10 },
  { name: 'Luxury Tax', nameAr: 'ضريبة السلع الفاخرة', rate: 15 },
];

export default function TaxSettingsPage() {
  const params = useParams();
  const storeId = params.id as string;

  const [settings, setSettings] = useState<TaxSettings>({
    taxEnabled: false,
    taxIncludedInPrice: false,
    defaultTaxRate: null,
  });
  const [rates, setRates] = useState<TaxRate[]>([]);
  const [_storeName, setStoreName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingRate, setEditingRate] = useState<TaxRate | null>(null);
  const [formData, setFormData] = useState<RateFormData>(DEFAULT_FORM);
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const fetchStoreName = useCallback(async () => {
    const { data } = await apiGet<{ store: { name: string } }>(`/api/v1/stores/${storeId}`);
    if (data) {
      setStoreName(data.store?.name || '');
    }
  }, [storeId]);

  const fetchSettings = useCallback(async () => {
    const { data } = await apiGet<{ settings: TaxSettings }>(
      `/api/v1/stores/${storeId}/tax/settings`
    );
    if (data) {
      setSettings(
        data.settings || {
          taxEnabled: false,
          taxIncludedInPrice: false,
          defaultTaxRate: null,
        }
      );
    }
  }, [storeId]);

  const fetchRates = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter !== 'all') {
      params.set('includeInactive', 'true');
    }

    const { data } = await apiGet<{ rates: TaxRate[] }>(
      `/api/v1/stores/${storeId}/tax/rates?${params}`
    );
    if (data) {
      let allRates = data.rates || [];

      if (filter === 'active') {
        allRates = allRates.filter((r: TaxRate) => r.isActive);
      } else if (filter === 'inactive') {
        allRates = allRates.filter((r: TaxRate) => !r.isActive);
      }

      setRates(allRates);
    }
  }, [storeId, filter]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchStoreName(), fetchSettings(), fetchRates()]);
    setLoading(false);
  }, [fetchStoreName, fetchSettings, fetchRates]);

  useEffect(() => {
    fetchAll();
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
        country: rate.country || '',
        state: rate.state || '',
        priority: rate.priority.toString(),
        isCompound: rate.isCompound,
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
      const body = {
        name: formData.name,
        nameAr: formData.nameAr || undefined,
        rate: parseFloat(formData.rate),
        country: formData.country || undefined,
        state: formData.state || undefined,
        priority: parseInt(formData.priority) || 0,
        isCompound: formData.isCompound,
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

  const applyTaxTemplate = (template: (typeof COMMON_TAX_TYPES)[0]) => {
    setFormData(prev => ({
      ...prev,
      name: template.name,
      nameAr: template.nameAr,
      rate: template.rate.toString(),
    }));
  };

  return (
    <AdminLayout
      title="Tax Configuration"
      subtitle="Configure tax rates and settings for your store"
    >
      <div className="space-y-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
          </div>
        ) : (
          <>
            {/* Tax Settings Card */}
            <div className="bg-card rounded-xl border border-border p-6 mb-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">General Settings</h2>
              <div className="space-y-6">
                {/* Enable Tax */}
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-foreground">Enable Tax Collection</h3>
                    <p className="text-sm text-muted-foreground">
                      When enabled, taxes will be calculated and added to orders
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.taxEnabled}
                      onChange={e => {
                        const newSettings = { ...settings, taxEnabled: e.target.checked };
                        setSettings(newSettings);
                        handleSaveSettings({ taxEnabled: e.target.checked });
                      }}
                      className="sr-only peer"
                      disabled={savingSettings}
                    />
                    <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500"></div>
                  </label>
                </div>

                {/* Tax Included in Price */}
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-foreground">Prices Include Tax</h3>
                    <p className="text-sm text-muted-foreground">
                      Product prices already include tax (tax will be calculated backwards)
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.taxIncludedInPrice}
                      onChange={e => {
                        const newSettings = { ...settings, taxIncludedInPrice: e.target.checked };
                        setSettings(newSettings);
                        handleSaveSettings({ taxIncludedInPrice: e.target.checked });
                      }}
                      className="sr-only peer"
                      disabled={savingSettings || !settings.taxEnabled}
                    />
                    <div
                      className={`w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500 ${!settings.taxEnabled ? 'opacity-50' : ''}`}
                    ></div>
                  </label>
                </div>

                {/* Default Tax Rate */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Default Tax Rate (%)
                  </label>
                  <p className="text-sm text-muted-foreground mb-2">
                    Used when no specific tax rate rules apply
                  </p>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={settings.defaultTaxRate ?? ''}
                      onChange={e => {
                        const value = e.target.value ? parseFloat(e.target.value) : null;
                        setSettings({ ...settings, defaultTaxRate: value });
                      }}
                      onBlur={() => handleSaveSettings({ defaultTaxRate: settings.defaultTaxRate })}
                      placeholder="e.g., 5.00"
                      className="w-32 px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      disabled={!settings.taxEnabled}
                    />
                    <span className="text-muted-foreground">%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Tax Rates Section */}
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="flex items-center justify-between p-6 border-b border-border">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Tax Rates</h2>
                  <p className="text-sm text-muted-foreground">
                    Create specific tax rates for different regions or categories
                  </p>
                </div>
                <button
                  onClick={() => handleOpenModal()}
                  className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors flex items-center gap-2"
                  disabled={!settings.taxEnabled}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                  Add Rate
                </button>
              </div>

              {/* Filters */}
              <div className="flex gap-2 p-4 bg-muted border-b border-border">
                {(['all', 'active', 'inactive'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      filter === f
                        ? 'bg-orange-500 text-white'
                        : 'bg-card text-foreground hover:bg-muted border border-border'
                    }`}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>

              {/* Rates List */}
              {rates.length === 0 ? (
                <div className="p-12 text-center">
                  <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg
                      className="w-8 h-8 text-muted-foreground"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">No Tax Rates</h3>
                  <p className="text-muted-foreground mb-6">
                    {settings.taxEnabled
                      ? 'Create tax rates for specific regions or product categories'
                      : 'Enable tax collection to start adding tax rates'}
                  </p>
                  {settings.taxEnabled && (
                    <button
                      onClick={() => handleOpenModal()}
                      className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors"
                    >
                      Create First Rate
                    </button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-muted border-b border-border">
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Name
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Rate
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Region
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Priority
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Type
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Status
                        </th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rates.map(rate => (
                        <tr key={rate.id} className="hover:bg-muted">
                          <td className="px-6 py-4">
                            <div>
                              <div className="font-medium text-foreground">{rate.name}</div>
                              {rate.nameAr && (
                                <div className="text-sm text-muted-foreground font-arabic">
                                  {rate.nameAr}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="font-medium text-foreground">{rate.rate}%</span>
                          </td>
                          <td className="px-6 py-4">
                            {rate.country || rate.state ? (
                              <div className="text-sm text-muted-foreground">
                                {rate.country && <span className="uppercase">{rate.country}</span>}
                                {rate.country && rate.state && <span> / </span>}
                                {rate.state && <span>{rate.state}</span>}
                              </div>
                            ) : (
                              <span className="text-sm text-muted-foreground">All regions</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-sm text-muted-foreground">{rate.priority}</span>
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`px-2 py-1 rounded text-xs font-medium ${
                                rate.isCompound
                                  ? 'bg-purple-100 text-purple-700'
                                  : 'bg-blue-100 text-blue-700'
                              }`}
                            >
                              {rate.isCompound ? 'Compound' : 'Standard'}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <button
                              onClick={() => handleToggle(rate)}
                              className={`px-2 py-1 rounded-full text-xs font-medium ${
                                rate.isActive
                                  ? 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]'
                                  : 'bg-muted text-muted-foreground'
                              }`}
                            >
                              {rate.isActive ? 'Active' : 'Inactive'}
                            </button>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => handleOpenModal(rate)}
                                className="p-2 text-muted-foreground hover:text-orange-500 transition-colors"
                                title="Edit"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                  />
                                </svg>
                              </button>
                              <button
                                onClick={() => handleDelete(rate)}
                                className="p-2 text-muted-foreground hover:text-destructive transition-colors"
                                title="Delete"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                  />
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Info Box */}
            <div className="mt-6 bg-blue-50 border border-blue-200 rounded-xl p-4">
              <div className="flex gap-3">
                <svg
                  className="w-5 h-5 text-blue-500 mt-0.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <div>
                  <h3 className="text-sm font-medium text-blue-900">About Tax Calculation</h3>
                  <p className="text-sm text-blue-700 mt-1">
                    Tax rates are applied based on priority (highest first).{' '}
                    <strong>Compound taxes</strong> are calculated on top of the subtotal plus any
                    previously calculated taxes. <strong>Standard taxes</strong> are calculated only
                    on the original subtotal.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Modal */}
        {showModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-card rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between p-6 border-b border-border">
                <h2 className="text-xl font-semibold text-foreground">
                  {editingRate ? 'Edit Tax Rate' : 'New Tax Rate'}
                </h2>
                <button
                  onClick={handleCloseModal}
                  className="p-2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>

              <form onSubmit={handleSubmit} className="p-6 space-y-6">
                {/* Quick Templates */}
                {!editingRate && (
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-2">
                      Quick Templates
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {COMMON_TAX_TYPES.map(template => (
                        <button
                          key={template.name}
                          type="button"
                          onClick={() => applyTaxTemplate(template)}
                          className="px-3 py-1.5 bg-muted text-foreground rounded-lg text-sm hover:bg-muted/80 transition-colors"
                        >
                          {template.name} ({template.rate}%)
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Rate Name */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-2">
                      Tax Name <span className="text-destructive">*</span>
                    </label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={e => setFormData({ ...formData, name: e.target.value })}
                      placeholder="e.g., VAT"
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-2">
                      Tax Name (Arabic)
                    </label>
                    <input
                      type="text"
                      value={formData.nameAr}
                      onChange={e => setFormData({ ...formData, nameAr: e.target.value })}
                      placeholder="e.g., ضريبة القيمة المضافة"
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      dir="rtl"
                    />
                  </div>
                </div>

                {/* Rate */}
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-2">
                    Tax Rate (%) <span className="text-destructive">*</span>
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={formData.rate}
                      onChange={e => setFormData({ ...formData, rate: e.target.value })}
                      placeholder="5.00"
                      className="w-32 px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      required
                    />
                    <span className="text-muted-foreground">%</span>
                  </div>
                </div>

                {/* Region */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-2">
                      Country Code
                    </label>
                    <input
                      type="text"
                      value={formData.country}
                      onChange={e =>
                        setFormData({ ...formData, country: e.target.value.toUpperCase() })
                      }
                      placeholder="e.g., KW"
                      maxLength={2}
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 uppercase"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Leave empty for all countries
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-2">
                      State/Region
                    </label>
                    <input
                      type="text"
                      value={formData.state}
                      onChange={e => setFormData({ ...formData, state: e.target.value })}
                      placeholder="e.g., Capital"
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    />
                    <p className="text-xs text-muted-foreground mt-1">Leave empty for all states</p>
                  </div>
                </div>

                {/* Priority */}
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-2">
                    Priority
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={formData.priority}
                    onChange={e => setFormData({ ...formData, priority: e.target.value })}
                    placeholder="0"
                    className="w-24 px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Higher priority rates are applied first
                  </p>
                </div>

                {/* Toggles */}
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.isCompound}
                        onChange={e => setFormData({ ...formData, isCompound: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-500"></div>
                    </label>
                    <div>
                      <span className="text-sm text-foreground font-medium">Compound Tax</span>
                      <p className="text-xs text-muted-foreground">
                        Calculate on subtotal + previous taxes
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.isActive}
                        onChange={e => setFormData({ ...formData, isActive: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500"></div>
                    </label>
                    <span className="text-sm text-foreground">Active</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
                  <button
                    type="button"
                    onClick={handleCloseModal}
                    className="px-4 py-2 text-foreground border border-border rounded-lg hover:bg-muted transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {saving && (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    )}
                    {editingRate ? 'Update Rate' : 'Create Rate'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
