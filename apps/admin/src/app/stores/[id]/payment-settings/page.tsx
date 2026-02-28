'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { getApiUrl } from '../../../../lib/api';

interface StorePaymentConfig {
  id?: string;
  provider: string;
  isEnabled: boolean;
  apiKey: string | null;
  secretKey: string | null;
  webhookSecret: string | null;
  merchantId: string | null;
  testMode: boolean;
}

const API_URL = getApiUrl();

const PROVIDERS = [
  { id: 'tap', name: 'Tap Payments', nameAr: 'تاب للمدفوعات', color: '#00D4AA' },
  { id: 'myfatoorah', name: 'MyFatoorah', nameAr: 'ماي فاتورة', color: '#00A651' },
  { id: 'hesabe', name: 'Hesabe', nameAr: 'حسابي', color: '#E31837' },
  { id: 'upayments', name: 'UPayments', nameAr: 'يو بيمنتس', color: '#1E88E5' },
];

const emptyConfig = (provider: string): StorePaymentConfig => ({
  provider,
  isEnabled: false,
  apiKey: '',
  secretKey: '',
  webhookSecret: '',
  merchantId: '',
  testMode: true,
});

export default function StorePaymentSettingsPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [configs, setConfigs] = useState<StorePaymentConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-provider form state: { [provider]: formData }
  const [forms, setForms] = useState<Record<string, StorePaymentConfig>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveMessages, setSaveMessages] = useState<
    Record<string, { type: 'success' | 'error'; text: string }>
  >({});

  // Track which providers are expanded
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const fetchConfigs = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`${API_URL}/api/v1/payment-settings/store/${storeId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const loaded: StorePaymentConfig[] =
          data.data?.storeConfigs ||
          data.data?.configs ||
          (Array.isArray(data.data) ? data.data : []);
        setConfigs(loaded);

        // Initialize form state from loaded configs
        const initialForms: Record<string, StorePaymentConfig> = {};
        PROVIDERS.forEach(p => {
          const existing = loaded.find(c => c.provider === p.id);
          initialForms[p.id] = existing ? { ...existing } : emptyConfig(p.id);
        });
        setForms(initialForms);
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(errData.error?.message || 'Failed to load payment settings');
      }
    } catch {
      setError('Unable to connect to the server. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  function updateForm(provider: string, field: keyof StorePaymentConfig, value: string | boolean) {
    setForms(prev => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value },
    }));
    // Clear save message on change
    if (saveMessages[provider]) {
      setSaveMessages(prev => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
    }
  }

  async function handleToggle(provider: string, enabled: boolean) {
    // Optimistic update
    setForms(prev => ({
      ...prev,
      [provider]: { ...prev[provider], isEnabled: enabled },
    }));
    await handleSave(provider, { isEnabled: enabled });
  }

  async function handleSave(provider: string, overrides?: Partial<StorePaymentConfig>) {
    setSaving(provider);
    setSaveMessages(prev => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });

    const formData = { ...forms[provider], ...overrides };
    const existingConfig = configs.find(c => c.provider === provider);
    const isNew = !existingConfig?.id;

    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`${API_URL}/api/v1/payment-settings/store/${storeId}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          // Omit empty strings — treat as null
          apiKey: formData.apiKey || null,
          secretKey: formData.secretKey || null,
          webhookSecret: formData.webhookSecret || null,
          merchantId: formData.merchantId || null,
        }),
      });

      if (res.ok) {
        setSaveMessages(prev => ({
          ...prev,
          [provider]: { type: 'success', text: 'Saved successfully' },
        }));
        await fetchConfigs();
      } else {
        const errData = await res.json().catch(() => ({}));
        setSaveMessages(prev => ({
          ...prev,
          [provider]: { type: 'error', text: errData.error?.message || 'Failed to save' },
        }));
        // Revert optimistic toggle
        if (overrides?.isEnabled !== undefined) {
          setForms(prev => ({
            ...prev,
            [provider]: { ...prev[provider], isEnabled: !overrides.isEnabled },
          }));
        }
      }
    } catch {
      setSaveMessages(prev => ({
        ...prev,
        [provider]: { type: 'error', text: 'Unable to connect to the server' },
      }));
    } finally {
      setSaving(null);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title="Payment Settings" subtitle="Configure payment providers for this store">
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-200" />
          ))}
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Payment Settings"
      subtitle="Configure payment providers for this store"
      actions={
        <Link href={`/stores/${storeId}/settings`}>
          <button className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 font-medium">
            Back to Settings
          </button>
        </Link>
      }
    >
      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button className="ml-4 font-medium underline" onClick={fetchConfigs}>
            Retry
          </button>
        </div>
      )}

      <div className="space-y-4">
        {PROVIDERS.map(provider => {
          const form = forms[provider.id] ?? emptyConfig(provider.id);
          const isExpanded = expanded[provider.id] ?? false;
          const isSavingThis = saving === provider.id;
          const message = saveMessages[provider.id];

          return (
            <div
              key={provider.id}
              className={`rounded-xl border bg-white shadow-sm overflow-hidden transition-all ${
                form.isEnabled ? 'border-l-4' : ''
              }`}
              style={form.isEnabled ? { borderLeftColor: provider.color } : undefined}
            >
              {/* Provider header */}
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-white text-sm font-bold"
                    style={{ backgroundColor: provider.color }}
                  >
                    {provider.id[0].toUpperCase()}
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{provider.name}</h3>
                    <p className="text-xs text-gray-500">{provider.nameAr}</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {/* Enabled toggle */}
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-500">
                      {form.isEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <label className="relative inline-flex cursor-pointer items-center">
                      <input
                        type="checkbox"
                        checked={form.isEnabled}
                        onChange={e => handleToggle(provider.id, e.target.checked)}
                        disabled={isSavingThis}
                        className="sr-only peer"
                      />
                      <div className="peer h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-500 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-400/30 peer-disabled:opacity-50" />
                    </label>
                  </div>

                  {/* Expand/collapse button */}
                  <button
                    onClick={() => setExpanded(prev => ({ ...prev, [provider.id]: !isExpanded }))}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Configure
                    <svg
                      className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Config form (expanded) */}
              {isExpanded && (
                <div className="border-t bg-gray-50 p-6 space-y-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        API Key
                      </label>
                      <input
                        type="password"
                        value={form.apiKey || ''}
                        onChange={e => updateForm(provider.id, 'apiKey', e.target.value)}
                        placeholder="Enter API key"
                        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Secret Key
                      </label>
                      <input
                        type="password"
                        value={form.secretKey || ''}
                        onChange={e => updateForm(provider.id, 'secretKey', e.target.value)}
                        placeholder="Enter secret key"
                        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Webhook Secret
                      </label>
                      <input
                        type="password"
                        value={form.webhookSecret || ''}
                        onChange={e => updateForm(provider.id, 'webhookSecret', e.target.value)}
                        placeholder="Enter webhook secret"
                        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Merchant ID
                      </label>
                      <input
                        type="text"
                        value={form.merchantId || ''}
                        onChange={e => updateForm(provider.id, 'merchantId', e.target.value)}
                        placeholder="Enter merchant ID (if applicable)"
                        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>

                  {/* Test mode toggle */}
                  <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <label className="relative inline-flex cursor-pointer items-center">
                      <input
                        type="checkbox"
                        checked={form.testMode}
                        onChange={e => updateForm(provider.id, 'testMode', e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-amber-500 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none" />
                    </label>
                    <div>
                      <p className="text-sm font-medium text-amber-800">
                        Test Mode {form.testMode ? 'On' : 'Off'}
                      </p>
                      <p className="text-xs text-amber-700">
                        {form.testMode
                          ? 'Using test credentials — no real payments processed'
                          : 'Live mode — real payments will be processed'}
                      </p>
                    </div>
                  </div>

                  {/* Save message */}
                  {message && (
                    <div
                      className={`rounded-lg p-3 text-sm ${
                        message.type === 'success'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-red-50 text-red-700'
                      }`}
                    >
                      {message.text}
                    </div>
                  )}

                  <div className="flex justify-end">
                    <button
                      onClick={() => handleSave(provider.id)}
                      disabled={isSavingThis}
                      className="px-6 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
                    >
                      {isSavingThis ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AdminLayout>
  );
}
