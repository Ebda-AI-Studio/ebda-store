'use client';

import { useState, useEffect } from 'react';
import { Button, Input, Textarea, Select } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { useAuth } from '../../lib/auth';
import { apiGet, apiPut, getApiUrl } from '../../lib/api';

interface Store {
  id: string;
  name: string;
  slug: string;
  domain?: string;
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;
  settings?: Record<string, unknown>;
}

const currencies = [
  { value: 'USD', label: 'US Dollar (USD)' },
  { value: 'EUR', label: 'Euro (EUR)' },
  { value: 'GBP', label: 'British Pound (GBP)' },
  { value: 'KWD', label: 'Kuwaiti Dinar (KWD)' },
  { value: 'AED', label: 'UAE Dirham (AED)' },
];

const timezones = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'Asia/Kuwait', label: 'Kuwait Time (AST)' },
  { value: 'Asia/Dubai', label: 'Gulf Standard Time (GST)' },
];

export default function SettingsPage() {
  const { token } = useAuth();
  const [activeTab, setActiveTab] = useState('general');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);

  // Payment settings state
  const [taxRate, setTaxRate] = useState('10');
  const [taxCalculation, setTaxCalculation] = useState('inclusive');
  const [codEnabled, setCodEnabled] = useState(true);
  const [paymentSaveMessage, setPaymentSaveMessage] = useState<string | null>(null);

  const [settings, setSettings] = useState({
    storeName: '',
    storeEmail: '',
    storePhone: '',
    storeAddress: '',
    currency: 'KWD',
    timezone: 'Asia/Kuwait',
    orderNotifications: true,
    customerNotifications: true,
    inventoryAlerts: true,
    marketingEmails: false,
    freeShippingThreshold: '',
    flatRateShipping: '',
    expressShipping: '',
  });

  // Load store data
  useEffect(() => {
    async function loadStore() {
      try {
        // Get the first store for this admin
        const { data: storesData } = await apiGet<{ stores: Store[] }>('/api/v1/admin/stores');
        if (!storesData?.stores?.length) {
          setIsLoading(false);
          return;
        }

        const store = storesData.stores[0];
        setStoreId(store.id);

        // Fetch full store details
        const response = await fetch(`${getApiUrl()}/api/v1/stores/${store.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const result = await response.json();

        if (result.success && result.data?.store) {
          const s = result.data.store;
          const storeSettings = s.settings || {};

          setSettings({
            storeName: s.name || '',
            storeEmail: s.email || '',
            storePhone: s.phone || '',
            storeAddress: s.address || '',
            currency: (storeSettings.currency as string) || 'KWD',
            timezone: (storeSettings.timezone as string) || 'Asia/Kuwait',
            orderNotifications: storeSettings.orderNotifications !== false,
            customerNotifications: storeSettings.customerNotifications !== false,
            inventoryAlerts: storeSettings.inventoryAlerts !== false,
            marketingEmails: storeSettings.marketingEmails === true,
            freeShippingThreshold: String(storeSettings.freeShippingThreshold || ''),
            flatRateShipping: String(storeSettings.flatRateShipping || ''),
            expressShipping: String(storeSettings.expressShipping || ''),
          });

          // Load payment settings
          if (storeSettings.taxRate !== undefined) {
            setTaxRate(String(storeSettings.taxRate));
          }
          if (storeSettings.taxCalculation !== undefined) {
            setTaxCalculation(storeSettings.taxCalculation as string);
          }
          if (storeSettings.codEnabled !== undefined) {
            setCodEnabled(storeSettings.codEnabled as boolean);
          }
        }
      } catch {
        // Will show with default values
      } finally {
        setIsLoading(false);
      }
    }

    if (token) loadStore();
  }, [token]);

  const updateSetting = (key: string, value: string | boolean) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    if (!storeId) {
      setSaveMessage('No store found. Please create a store first.');
      return;
    }

    setIsSaving(true);
    setSaveMessage(null);

    try {
      // Update store name
      const { error: nameError } = await apiPut(`/api/v1/stores/${storeId}`, {
        name: settings.storeName,
        settings: {
          currency: settings.currency,
          timezone: settings.timezone,
          orderNotifications: settings.orderNotifications,
          customerNotifications: settings.customerNotifications,
          inventoryAlerts: settings.inventoryAlerts,
          marketingEmails: settings.marketingEmails,
          freeShippingThreshold: settings.freeShippingThreshold || undefined,
          flatRateShipping: settings.flatRateShipping || undefined,
          expressShipping: settings.expressShipping || undefined,
        },
      });

      if (nameError) {
        setSaveMessage(`Failed to save: ${nameError.message}`);
        return;
      }

      // Update contact info
      const { error: contactError } = await apiPut(`/api/v1/stores/${storeId}/contact`, {
        email: settings.storeEmail || undefined,
        phone: settings.storePhone || undefined,
        address: settings.storeAddress || undefined,
      });

      if (contactError) {
        setSaveMessage(`Settings saved but contact update failed: ${contactError.message}`);
        return;
      }

      setSaveMessage('Settings saved successfully.');
    } catch {
      setSaveMessage('Failed to save settings. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handlePaymentSave = async () => {
    if (!storeId) {
      setPaymentSaveMessage('No store found.');
      return;
    }

    setIsSaving(true);
    setPaymentSaveMessage(null);

    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}`, {
        settings: {
          taxRate: taxRate || undefined,
          taxCalculation,
          codEnabled,
        },
      });

      if (error) {
        setPaymentSaveMessage(`Failed to save: ${error.message}`);
      } else {
        setPaymentSaveMessage('Payment settings saved.');
      }
    } catch {
      setPaymentSaveMessage('Failed to save payment settings. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCodToggle = async (enabled: boolean) => {
    setCodEnabled(enabled);

    if (!storeId) return;

    try {
      await apiPut(`/api/v1/stores/${storeId}`, {
        settings: { codEnabled: enabled },
      });
    } catch {
      // Revert on failure
      setCodEnabled(!enabled);
      setPaymentSaveMessage('Failed to update Cash on Delivery setting. Please try again.');
    }
  };

  const tabs = [
    {
      id: 'general',
      label: 'General',
      icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    },
    {
      id: 'shipping',
      label: 'Shipping',
      icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
    },
    {
      id: 'payments',
      label: 'Payments',
      icon: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
    },
  ];

  if (isLoading) {
    return (
      <AdminLayout title="Settings" subtitle="Manage your store configuration">
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Settings" subtitle="Manage your store configuration">
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Tabs */}
        <div className="lg:w-64">
          <nav className="space-y-1">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  activeTab === tab.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d={tab.icon}
                  />
                </svg>
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1">
          {activeTab === 'general' && (
            <div className="space-y-6">
              <div className="rounded-xl border bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Store Information</h2>
                <div className="space-y-4">
                  <Input
                    label="Store Name"
                    value={settings.storeName}
                    onChange={e => updateSetting('storeName', e.target.value)}
                  />
                  <Input
                    label="Support Email"
                    type="email"
                    value={settings.storeEmail}
                    onChange={e => updateSetting('storeEmail', e.target.value)}
                  />
                  <Input
                    label="Phone Number"
                    type="tel"
                    value={settings.storePhone}
                    onChange={e => updateSetting('storePhone', e.target.value)}
                  />
                  <Textarea
                    label="Business Address"
                    value={settings.storeAddress}
                    onChange={e => updateSetting('storeAddress', e.target.value)}
                    rows={3}
                  />
                </div>
              </div>

              <div className="rounded-xl border bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Regional Settings</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Select
                    label="Currency"
                    value={settings.currency}
                    onChange={e => updateSetting('currency', e.target.value)}
                    options={currencies}
                  />
                  <Select
                    label="Timezone"
                    value={settings.timezone}
                    onChange={e => updateSetting('timezone', e.target.value)}
                    options={timezones}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Email Notifications</h2>
              <div className="space-y-4">
                {[
                  {
                    key: 'orderNotifications',
                    label: 'Order Notifications',
                    description: 'Receive emails for new orders',
                  },
                  {
                    key: 'customerNotifications',
                    label: 'Customer Notifications',
                    description: 'Get notified when new customers register',
                  },
                  {
                    key: 'inventoryAlerts',
                    label: 'Inventory Alerts',
                    description: 'Alerts when products are low in stock',
                  },
                  {
                    key: 'marketingEmails',
                    label: 'Marketing Emails',
                    description: 'Receive tips and product updates',
                  },
                ].map(item => (
                  <div
                    key={item.key}
                    className="flex items-center justify-between rounded-lg border p-4"
                  >
                    <div>
                      <p className="font-medium text-gray-900">{item.label}</p>
                      <p className="text-sm text-gray-500">{item.description}</p>
                    </div>
                    <label className="relative inline-flex cursor-pointer items-center">
                      <input
                        type="checkbox"
                        checked={settings[item.key as keyof typeof settings] as boolean}
                        onChange={e => updateSetting(item.key, e.target.checked)}
                        className="peer sr-only"
                      />
                      <div className="peer h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/20"></div>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'shipping' && (
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Shipping Options</h2>
              <div className="space-y-4">
                <Input
                  label="Free Shipping Threshold (KWD)"
                  type="number"
                  step="0.001"
                  value={settings.freeShippingThreshold}
                  onChange={e => updateSetting('freeShippingThreshold', e.target.value)}
                />
                <Input
                  label="Flat Rate Shipping (KWD)"
                  type="number"
                  step="0.001"
                  value={settings.flatRateShipping}
                  onChange={e => updateSetting('flatRateShipping', e.target.value)}
                />
                <Input
                  label="Express Shipping (KWD)"
                  type="number"
                  step="0.001"
                  value={settings.expressShipping}
                  onChange={e => updateSetting('expressShipping', e.target.value)}
                />
              </div>
            </div>
          )}

          {activeTab === 'payments' && (
            <div className="space-y-6">
              <div className="rounded-xl border bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Payment Providers</h2>
                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
                        <span className="text-lg font-bold text-blue-600">K</span>
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">KNET</p>
                        <p className="text-sm text-gray-500">
                          Kuwait&apos;s primary debit card network
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        storeId
                          ? (window.location.href = `/stores/${storeId}/payment-settings`)
                          : alert('Configure in Store Settings')
                      }
                    >
                      Configure
                    </Button>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100">
                        <span className="text-lg font-bold text-emerald-600">T</span>
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">Tap Payments</p>
                        <p className="text-sm text-gray-500">Credit cards, Apple Pay, Google Pay</p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        storeId
                          ? (window.location.href = `/stores/${storeId}/payment-settings`)
                          : alert('Configure in Store Settings')
                      }
                    >
                      Configure
                    </Button>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-100">
                        <span className="text-lg font-bold text-primary">M</span>
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">MyFatoorah</p>
                        <p className="text-sm text-gray-500">Kuwait payment gateway</p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        storeId
                          ? (window.location.href = `/stores/${storeId}/payment-settings`)
                          : alert('Configure in Store Settings')
                      }
                    >
                      Connect
                    </Button>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100">
                        <svg
                          className="h-5 w-5 text-amber-600"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"
                          />
                        </svg>
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">Cash on Delivery</p>
                        <p className="text-sm text-gray-500">Accept payment upon delivery</p>
                      </div>
                    </div>
                    <label className="relative inline-flex cursor-pointer items-center">
                      <input
                        type="checkbox"
                        checked={codEnabled}
                        onChange={e => handleCodToggle(e.target.checked)}
                        className="peer sr-only"
                      />
                      <div className="peer h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
                    </label>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Tax Settings</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label="Tax Rate (%)"
                    type="number"
                    step="0.01"
                    value={taxRate}
                    onChange={e => setTaxRate(e.target.value)}
                  />
                  <Select
                    label="Tax Calculation"
                    value={taxCalculation}
                    onChange={e => setTaxCalculation(e.target.value)}
                    options={[
                      { value: 'inclusive', label: 'Tax Inclusive' },
                      { value: 'exclusive', label: 'Tax Exclusive' },
                    ]}
                  />
                </div>
                <div className="mt-4 flex items-center gap-3">
                  {paymentSaveMessage && (
                    <span
                      className={`text-sm ${paymentSaveMessage.includes('Failed') ? 'text-red-600' : 'text-green-600'}`}
                    >
                      {paymentSaveMessage}
                    </span>
                  )}
                  <Button onClick={handlePaymentSave} isLoading={isSaving} size="sm">
                    Save Tax Settings
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Save Button */}
          <div className="mt-6 flex items-center justify-end gap-3">
            {saveMessage && (
              <span
                className={`text-sm ${saveMessage.includes('Failed') ? 'text-red-600' : 'text-green-600'}`}
              >
                {saveMessage}
              </span>
            )}
            <Button onClick={handleSave} isLoading={isSaving}>
              Save Changes
            </Button>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
