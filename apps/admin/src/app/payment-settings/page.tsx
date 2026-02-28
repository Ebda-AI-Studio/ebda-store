'use client';

import { useState, useEffect } from 'react';
import { AdminLayout } from '../../components/AdminLayout';
import { useAuth } from '../../lib/auth';
import { getApiUrl } from '../../lib/api';

interface PaymentConfig {
  id: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
  displayName: string | null;
  displayNameAr: string | null;
  apiKey: string | null;
  secretKey: string | null;
  merchantId: string | null;
  webhookSecret: string | null;
  testMode: boolean;
  supportedMethods: string[];
  supportedCurrencies: string[];
  fixedFee: number;
  percentageFee: number;
  healthStatus: 'healthy' | 'degraded' | 'down' | 'unknown';
  lastHealthCheck: string | null;
}

const PROVIDER_INFO: Record<string, { name: string; nameAr: string; logo: string; color: string }> =
  {
    tap: {
      name: 'Tap Payments',
      nameAr: 'تاب للمدفوعات',
      logo: '/providers/tap.svg',
      color: '#00D4AA',
    },
    myfatoorah: {
      name: 'MyFatoorah',
      nameAr: 'ماي فاتورة',
      logo: '/providers/myfatoorah.svg',
      color: '#00A651',
    },
    hesabe: {
      name: 'Hesabe',
      nameAr: 'حسابي',
      logo: '/providers/hesabe.svg',
      color: '#E31837',
    },
    upayments: {
      name: 'UPayments',
      nameAr: 'يو بيمنتس',
      logo: '/providers/upayments.svg',
      color: '#1E88E5',
    },
  };

const PAYMENT_METHODS = [
  { id: 'knet', name: 'KNET', nameAr: 'كي نت' },
  { id: 'visa', name: 'Visa', nameAr: 'فيزا' },
  { id: 'mastercard', name: 'Mastercard', nameAr: 'ماستركارد' },
  { id: 'amex', name: 'American Express', nameAr: 'أمريكان إكسبريس' },
  { id: 'apple_pay', name: 'Apple Pay', nameAr: 'آبل باي' },
  { id: 'google_pay', name: 'Google Pay', nameAr: 'جوجل باي' },
  { id: 'samsung_pay', name: 'Samsung Pay', nameAr: 'سامسونج باي' },
];

export default function PaymentSettingsPage() {
  const { token } = useAuth();
  const [configs, setConfigs] = useState<PaymentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [formData, setFormData] = useState<Partial<PaymentConfig>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const API_URL = getApiUrl();

  useEffect(() => {
    fetchConfigs();
  }, []);

  const fetchConfigs = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/api/v1/payment-settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (data.success) {
        setConfigs(data.data.configs);
      } else {
        setError(data.error?.message || 'Failed to load payment settings');
      }
    } catch (err) {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (provider: string) => {
    const config = configs.find(c => c.provider === provider);
    if (config) {
      setFormData({ ...config });
      setEditingProvider(provider);
    } else {
      // New provider
      setFormData({
        provider,
        isEnabled: false,
        testMode: true,
        supportedMethods: ['knet', 'visa', 'mastercard'],
        supportedCurrencies: ['KWD'],
        fixedFee: 0,
        percentageFee: 0,
      });
      setEditingProvider(provider);
    }
  };

  const handleSave = async () => {
    if (!editingProvider) return;

    setSaving(true);
    try {
      const existingConfig = configs.find(c => c.provider === editingProvider);
      const method = existingConfig ? 'PUT' : 'POST';
      const url = existingConfig
        ? `${API_URL}/api/v1/payment-settings/${editingProvider}`
        : `${API_URL}/api/v1/payment-settings`;

      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });

      const data = await response.json();
      if (data.success) {
        await fetchConfigs();
        setEditingProvider(null);
        setFormData({});
      } else {
        setError(data.error?.message || 'Failed to save settings');
      }
    } catch (err) {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (provider: string, enabled: boolean) => {
    try {
      const response = await fetch(`${API_URL}/api/v1/payment-settings/${provider}/toggle`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled }),
      });

      const data = await response.json();
      if (data.success) {
        await fetchConfigs();
      }
    } catch (err) {
      setError('Failed to toggle provider');
    }
  };

  const handleSetDefault = async (provider: string) => {
    try {
      const response = await fetch(`${API_URL}/api/v1/payment-settings/${provider}/set-default`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await response.json();
      if (data.success) {
        await fetchConfigs();
      }
    } catch (err) {
      setError('Failed to set default provider');
    }
  };

  const handleTest = async (provider: string) => {
    setTesting(provider);
    try {
      const response = await fetch(`${API_URL}/api/v1/payment-settings/${provider}/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await response.json();
      if (data.success) {
        await fetchConfigs();
      }
    } catch (err) {
      setError('Failed to test connection');
    } finally {
      setTesting(null);
    }
  };

  const getHealthBadge = (status: string) => {
    const colors: Record<string, string> = {
      healthy: 'bg-green-100 text-green-800',
      degraded: 'bg-yellow-100 text-yellow-800',
      down: 'bg-red-100 text-red-800',
      unknown: 'bg-gray-100 text-gray-800',
    };
    return (
      <span
        className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status] || colors.unknown}`}
      >
        {status}
      </span>
    );
  };

  if (loading) {
    return (
      <AdminLayout title="Payment Settings">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Payment Settings">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Payment Settings</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure Kuwait payment providers for your platform
          </p>
        </div>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-600">{error}</p>
            <button onClick={() => setError(null)} className="text-red-500 underline text-sm mt-1">
              Dismiss
            </button>
          </div>
        )}

        {/* Provider Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {Object.entries(PROVIDER_INFO).map(([provider, info]) => {
            const config = configs.find(c => c.provider === provider);
            const isConfigured = !!config;

            return (
              <div
                key={provider}
                className={`bg-white rounded-xl shadow-sm border-2 transition-all ${
                  config?.isDefault ? 'border-indigo-500' : 'border-gray-200'
                }`}
              >
                {/* Card Header */}
                <div
                  className="p-4 border-b flex items-center justify-between"
                  style={{ borderLeftColor: info.color, borderLeftWidth: 4 }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
                      style={{ backgroundColor: info.color }}
                    >
                      {provider[0].toUpperCase()}
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">{info.name}</h3>
                      <p className="text-sm text-gray-500">{info.nameAr}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {config?.isDefault && (
                      <span className="px-2 py-1 bg-indigo-100 text-indigo-800 text-xs font-medium rounded-full">
                        Default
                      </span>
                    )}
                    {isConfigured && getHealthBadge(config!.healthStatus)}
                  </div>
                </div>

                {/* Card Body */}
                <div className="p-4">
                  {isConfigured ? (
                    <>
                      <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                        <div>
                          <span className="text-gray-500">Status:</span>
                          <span
                            className={`ml-2 font-medium ${
                              config!.isEnabled ? 'text-green-600' : 'text-gray-400'
                            }`}
                          >
                            {config!.isEnabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Mode:</span>
                          <span
                            className={`ml-2 font-medium ${
                              config!.testMode ? 'text-yellow-600' : 'text-green-600'
                            }`}
                          >
                            {config!.testMode ? 'Test' : 'Live'}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">API Key:</span>
                          <span className="ml-2 font-mono text-xs">
                            {config!.apiKey
                              ? `${config!.apiKey.substring(0, 4)}${'*'.repeat(Math.max(0, config!.apiKey.length - 8))}${config!.apiKey.length > 8 ? config!.apiKey.substring(config!.apiKey.length - 4) : ''}`
                              : 'Not set'}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Fee:</span>
                          <span className="ml-2">
                            {config!.fixedFee > 0 && `${config!.fixedFee / 1000} KWD`}
                            {config!.fixedFee > 0 && config!.percentageFee > 0 && ' + '}
                            {config!.percentageFee > 0 && `${config!.percentageFee}%`}
                            {config!.fixedFee === 0 && config!.percentageFee === 0 && 'None'}
                          </span>
                        </div>
                      </div>

                      <div className="mb-4">
                        <span className="text-sm text-gray-500">Payment Methods:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {config!.supportedMethods.map(method => (
                            <span
                              key={method}
                              className="px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded"
                            >
                              {PAYMENT_METHODS.find(m => m.id === method)?.name || method}
                            </span>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-center py-4 text-gray-500">
                      <p>Not configured</p>
                      <p className="text-sm">Click Configure to set up this provider</p>
                    </div>
                  )}
                </div>

                {/* Card Footer */}
                <div className="p-4 bg-gray-50 border-t flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {isConfigured && (
                      <>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={config!.isEnabled}
                            onChange={e => handleToggle(provider, e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                        </label>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {isConfigured && !config!.isDefault && (
                      <button
                        onClick={() => handleSetDefault(provider)}
                        className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
                      >
                        Set Default
                      </button>
                    )}
                    {isConfigured && (
                      <button
                        onClick={() => handleTest(provider)}
                        disabled={testing === provider}
                        className="px-3 py-1.5 text-sm text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                      >
                        {testing === provider ? 'Testing...' : 'Test'}
                      </button>
                    )}
                    <button
                      onClick={() => handleEdit(provider)}
                      className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700"
                    >
                      {isConfigured ? 'Edit' : 'Configure'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Edit Modal */}
        {editingProvider && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
              <div className="p-6 border-b">
                <h2 className="text-xl font-bold text-gray-900">
                  Configure {PROVIDER_INFO[editingProvider]?.name}
                </h2>
              </div>

              <div className="p-6 space-y-6">
                {/* API Credentials */}
                <div>
                  <h3 className="font-medium text-gray-900 mb-3">API Credentials</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        API Key
                      </label>
                      <input
                        type="password"
                        value={formData.apiKey || ''}
                        onChange={e => setFormData({ ...formData, apiKey: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
                        placeholder="Enter API key"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Secret Key
                      </label>
                      <input
                        type="password"
                        value={formData.secretKey || ''}
                        onChange={e => setFormData({ ...formData, secretKey: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
                        placeholder="Enter secret key"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Merchant ID
                      </label>
                      <input
                        type="text"
                        value={formData.merchantId || ''}
                        onChange={e => setFormData({ ...formData, merchantId: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
                        placeholder="Enter merchant ID"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Webhook Secret
                      </label>
                      <input
                        type="password"
                        value={formData.webhookSecret || ''}
                        onChange={e => setFormData({ ...formData, webhookSecret: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
                        placeholder="Enter webhook secret"
                      />
                    </div>
                  </div>
                </div>

                {/* Display Names */}
                <div>
                  <h3 className="font-medium text-gray-900 mb-3">Display Names</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Name (English)
                      </label>
                      <input
                        type="text"
                        value={formData.displayName || ''}
                        onChange={e => setFormData({ ...formData, displayName: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
                        placeholder={PROVIDER_INFO[editingProvider]?.name}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Name (Arabic)
                      </label>
                      <input
                        type="text"
                        value={formData.displayNameAr || ''}
                        onChange={e => setFormData({ ...formData, displayNameAr: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
                        placeholder={PROVIDER_INFO[editingProvider]?.nameAr}
                        dir="rtl"
                      />
                    </div>
                  </div>
                </div>

                {/* Settings */}
                <div>
                  <h3 className="font-medium text-gray-900 mb-3">Settings</h3>
                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={formData.testMode ?? true}
                        onChange={e => setFormData({ ...formData, testMode: e.target.checked })}
                        className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                      />
                      <span className="text-sm text-gray-700">Test Mode</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={formData.isEnabled ?? false}
                        onChange={e => setFormData({ ...formData, isEnabled: e.target.checked })}
                        className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                      />
                      <span className="text-sm text-gray-700">Enable Provider</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={formData.isDefault ?? false}
                        onChange={e => setFormData({ ...formData, isDefault: e.target.checked })}
                        className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                      />
                      <span className="text-sm text-gray-700">Set as Default</span>
                    </label>
                  </div>
                </div>

                {/* Payment Methods */}
                <div>
                  <h3 className="font-medium text-gray-900 mb-3">Supported Payment Methods</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {PAYMENT_METHODS.map(method => (
                      <label key={method.id} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={formData.supportedMethods?.includes(method.id) ?? false}
                          onChange={e => {
                            const methods = formData.supportedMethods || [];
                            if (e.target.checked) {
                              setFormData({
                                ...formData,
                                supportedMethods: [...methods, method.id],
                              });
                            } else {
                              setFormData({
                                ...formData,
                                supportedMethods: methods.filter(m => m !== method.id),
                              });
                            }
                          }}
                          className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                        />
                        <span className="text-sm text-gray-700">{method.name}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Fees */}
                <div>
                  <h3 className="font-medium text-gray-900 mb-3">Transaction Fees</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Fixed Fee (KWD)
                      </label>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        value={(formData.fixedFee || 0) / 1000}
                        onChange={e =>
                          setFormData({
                            ...formData,
                            fixedFee: Math.round(parseFloat(e.target.value) * 1000),
                          })
                        }
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
                        placeholder="0.000"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Percentage Fee (%)
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max="100"
                        value={formData.percentageFee || 0}
                        onChange={e =>
                          setFormData({ ...formData, percentageFee: parseFloat(e.target.value) })
                        }
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500"
                        placeholder="0.0"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-6 border-t bg-gray-50 flex justify-end gap-3">
                <button
                  onClick={() => {
                    setEditingProvider(null);
                    setFormData({});
                  }}
                  className="px-4 py-2 text-gray-700 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Configuration'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
