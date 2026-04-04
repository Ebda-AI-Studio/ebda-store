'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import { hslToHex } from '../../../../lib/color';

interface PWASettings {
  appName: string;
  appNameAr?: string;
  shortName: string;
  shortNameAr?: string;
  description: string;
  descriptionAr?: string;
  themeColor: string;
  backgroundColor: string;
  icon192?: string;
  icon512?: string;
  maskableIcon?: string;
  display: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser';
  orientation: 'any' | 'portrait' | 'landscape';
  startUrl: string;
  installPromptEnabled: boolean;
  offlineEnabled: boolean;
  pushNotificationsEnabled: boolean;
  iosStatusBarStyle: 'default' | 'black' | 'black-translucent';
  splashScreenColor: string;
}

interface StoreInfo {
  name: string;
  nameAr?: string;
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  theme?: {
    primaryColor?: string;
    secondaryColor?: string;
  };
}

const DEFAULT_SETTINGS: PWASettings = {
  appName: '',
  shortName: '',
  description: '',
  themeColor: '#f97316',
  backgroundColor: '#ffffff',
  display: 'standalone',
  orientation: 'any',
  startUrl: '/',
  installPromptEnabled: true,
  offlineEnabled: true,
  pushNotificationsEnabled: false,
  iosStatusBarStyle: 'default',
  splashScreenColor: '#ffffff',
};

const DISPLAY_OPTIONS = [
  {
    value: 'standalone',
    label: 'Standalone',
    description: 'Opens like a native app, no browser UI',
  },
  { value: 'fullscreen', label: 'Fullscreen', description: 'Takes up the entire screen' },
  { value: 'minimal-ui', label: 'Minimal UI', description: 'Minimal browser controls visible' },
  { value: 'browser', label: 'Browser', description: 'Opens in a browser tab' },
];

const ORIENTATION_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];

const IOS_STATUS_OPTIONS = [
  { value: 'default', label: 'Default (white)' },
  { value: 'black', label: 'Black' },
  { value: 'black-translucent', label: 'Black Translucent' },
];

export default function PWASettingsPage() {
  const params = useParams();
  const storeId = params.id as string;

  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pwaEnabled, setPwaEnabled] = useState(false);
  const [settings, setSettings] = useState<PWASettings>(DEFAULT_SETTINGS);
  const [hasExistingSettings, setHasExistingSettings] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchStoreInfo = useCallback(async () => {
    const { data } = await apiGet<{ store: StoreInfo & { [key: string]: unknown } }>(
      `/api/v1/stores/${storeId}`
    );
    const store = data?.store;
    if (store) {
      setStoreInfo({
        name: store.name || '',
        nameAr: store.nameAr || undefined,
        logo: store.logo || undefined,
        logoAr: store.logoAr || undefined,
        favicon: store.favicon || undefined,
        description: store.description || undefined,
        descriptionAr: store.descriptionAr || undefined,
        theme: store.theme || undefined,
      });
    }
  }, [storeId]);

  const fetchSettings = useCallback(async () => {
    const { data } = await apiGet<{ pwaEnabled: boolean; settings: PWASettings }>(
      `/api/v1/stores/${storeId}/pwa/settings`
    );
    if (data) {
      setPwaEnabled(data.pwaEnabled || false);
      if (data.settings && Object.keys(data.settings).length > 0) {
        setHasExistingSettings(true);
        setSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
      }
    }
  }, [storeId]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchStoreInfo(), fetchSettings()]);
    setLoading(false);
  }, [fetchStoreInfo, fetchSettings]);

  useEffect(() => {
    fetchAll();
  }, [storeId]);

  // Auto-populate from store branding when no existing PWA settings
  useEffect(() => {
    if (!storeInfo || hasExistingSettings) return;

    const themeColor = storeInfo.theme?.primaryColor
      ? hslToHex(storeInfo.theme.primaryColor)
      : '#f97316';

    setSettings(prev => ({
      ...prev,
      appName: prev.appName || storeInfo.name || '',
      appNameAr: prev.appNameAr || storeInfo.nameAr || undefined,
      shortName: prev.shortName || (storeInfo.name || '').slice(0, 12),
      shortNameAr: prev.shortNameAr || (storeInfo.nameAr || '').slice(0, 12) || undefined,
      description: prev.description || storeInfo.description || '',
      descriptionAr: prev.descriptionAr || storeInfo.descriptionAr || undefined,
      themeColor: themeColor,
      splashScreenColor: themeColor,
      icon192: prev.icon192 || storeInfo.favicon || storeInfo.logo || undefined,
      icon512: prev.icon512 || storeInfo.logo || undefined,
    }));
  }, [storeInfo, hasExistingSettings]);

  const handlePopulateFromStore = () => {
    if (!storeInfo) return;
    const themeColor = storeInfo.theme?.primaryColor
      ? hslToHex(storeInfo.theme.primaryColor)
      : '#f97316';
    setSettings(prev => ({
      ...prev,
      appName: storeInfo.name || prev.appName,
      appNameAr: storeInfo.nameAr || prev.appNameAr,
      shortName: (storeInfo.name || '').slice(0, 12) || prev.shortName,
      shortNameAr: (storeInfo.nameAr || '').slice(0, 12) || prev.shortNameAr,
      description: storeInfo.description || prev.description,
      descriptionAr: storeInfo.descriptionAr || prev.descriptionAr,
      themeColor: themeColor,
      splashScreenColor: themeColor,
      icon192: storeInfo.favicon || storeInfo.logo || prev.icon192,
      icon512: storeInfo.logo || prev.icon512,
    }));
    setMessage({ type: 'success', text: 'Populated from store branding' });
    setTimeout(() => setMessage(null), 3000);
  };

  const handleToggleEnabled = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/pwa/settings`, {
        pwaEnabled: !pwaEnabled,
      });
      if (!error) {
        setPwaEnabled(!pwaEnabled);
      } else {
        setMessage({ type: 'error', text: 'Failed to update PWA status' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to update PWA status' });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/pwa/settings`, { settings });
      if (!error) {
        setMessage({ type: 'success', text: 'PWA settings saved successfully' });
        setHasExistingSettings(true);
      } else {
        setMessage({ type: 'error', text: 'Failed to save PWA settings' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to save PWA settings' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminLayout
      title="Progressive Web App"
      subtitle="Enable app-like experience for your customers"
      actions={
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">PWA Status:</span>
          <button
            onClick={handleToggleEnabled}
            disabled={saving}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              pwaEnabled
                ? 'bg-green-100 text-green-700 hover:bg-green-200'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {pwaEnabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Auto-populate banner */}
          {storeInfo && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {storeInfo.logo && (
                  <img
                    src={storeInfo.logo}
                    alt="Store logo"
                    className="w-10 h-10 rounded-lg object-contain bg-white border"
                  />
                )}
                <div>
                  <p className="font-medium text-foreground">
                    {storeInfo.name}
                    {storeInfo.nameAr && <span className="text-muted-foreground mx-2">|</span>}
                    {storeInfo.nameAr && <span dir="rtl">{storeInfo.nameAr}</span>}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Use store branding to fill PWA settings
                  </p>
                </div>
              </div>
              <button
                onClick={handlePopulateFromStore}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap"
              >
                Populate from Store
              </button>
            </div>
          )}

          {/* PWA Benefits Info */}
          <div className="bg-gradient-to-r from-orange-50 to-amber-50 border border-orange-200 rounded-xl p-6">
            <h3 className="font-semibold text-foreground mb-3">Why Enable PWA?</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg
                    className="w-4 h-4 text-orange-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                    />
                  </svg>
                </div>
                <div>
                  <p className="font-medium text-foreground">Install on Device</p>
                  <p className="text-sm text-muted-foreground">Customers can add to home screen</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg
                    className="w-4 h-4 text-orange-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3"
                    />
                  </svg>
                </div>
                <div>
                  <p className="font-medium text-foreground">Offline Support</p>
                  <p className="text-sm text-muted-foreground">Works even without internet</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 bg-orange-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg
                    className="w-4 h-4 text-orange-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                </div>
                <div>
                  <p className="font-medium text-foreground">Fast Performance</p>
                  <p className="text-sm text-muted-foreground">Cached assets load instantly</p>
                </div>
              </div>
            </div>
          </div>

          {/* App Identity */}
          <div className="bg-card rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">App Identity</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  App Name
                </label>
                <input
                  type="text"
                  value={settings.appName}
                  onChange={e => setSettings({ ...settings, appName: e.target.value })}
                  placeholder="My Store"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  disabled={!pwaEnabled}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  App Name (Arabic)
                </label>
                <input
                  type="text"
                  value={settings.appNameAr || ''}
                  onChange={e => setSettings({ ...settings, appNameAr: e.target.value })}
                  placeholder="متجري"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  dir="rtl"
                  disabled={!pwaEnabled}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Short Name (max 12 chars)
                </label>
                <input
                  type="text"
                  maxLength={12}
                  value={settings.shortName}
                  onChange={e => setSettings({ ...settings, shortName: e.target.value })}
                  placeholder="Store"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  disabled={!pwaEnabled}
                />
                <p className="text-xs text-muted-foreground mt-1">Shown under home screen icon</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Short Name (Arabic)
                </label>
                <input
                  type="text"
                  maxLength={12}
                  value={settings.shortNameAr || ''}
                  onChange={e => setSettings({ ...settings, shortNameAr: e.target.value })}
                  placeholder="المتجر"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  dir="rtl"
                  disabled={!pwaEnabled}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Description
                </label>
                <textarea
                  value={settings.description}
                  onChange={e => setSettings({ ...settings, description: e.target.value })}
                  placeholder="Shop the latest products at amazing prices"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  rows={2}
                  disabled={!pwaEnabled}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Description (Arabic)
                </label>
                <textarea
                  value={settings.descriptionAr || ''}
                  onChange={e => setSettings({ ...settings, descriptionAr: e.target.value })}
                  placeholder="تسوق أحدث المنتجات بأسعار مميزة"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  rows={2}
                  dir="rtl"
                  disabled={!pwaEnabled}
                />
              </div>
            </div>
          </div>

          {/* Theme & Appearance */}
          <div className="bg-card rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">Theme & Appearance</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Theme Color
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={settings.themeColor}
                    onChange={e => setSettings({ ...settings, themeColor: e.target.value })}
                    className="w-10 h-10 rounded border border-border cursor-pointer"
                    disabled={!pwaEnabled}
                  />
                  <input
                    type="text"
                    value={settings.themeColor}
                    onChange={e => setSettings({ ...settings, themeColor: e.target.value })}
                    className="flex-1 px-3 py-2 border border-border rounded-lg text-sm uppercase"
                    disabled={!pwaEnabled}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">Browser address bar color</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Background Color
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={settings.backgroundColor}
                    onChange={e => setSettings({ ...settings, backgroundColor: e.target.value })}
                    className="w-10 h-10 rounded border border-border cursor-pointer"
                    disabled={!pwaEnabled}
                  />
                  <input
                    type="text"
                    value={settings.backgroundColor}
                    onChange={e => setSettings({ ...settings, backgroundColor: e.target.value })}
                    className="flex-1 px-3 py-2 border border-border rounded-lg text-sm uppercase"
                    disabled={!pwaEnabled}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">Splash screen background</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Display Mode
                </label>
                <select
                  value={settings.display}
                  onChange={e =>
                    setSettings({ ...settings, display: e.target.value as PWASettings['display'] })
                  }
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  disabled={!pwaEnabled}
                >
                  {DISPLAY_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Orientation
                </label>
                <select
                  value={settings.orientation}
                  onChange={e =>
                    setSettings({
                      ...settings,
                      orientation: e.target.value as PWASettings['orientation'],
                    })
                  }
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  disabled={!pwaEnabled}
                >
                  {ORIENTATION_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Icons */}
          <div className="bg-card rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">App Icons</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Icon 192x192
                </label>
                <input
                  type="text"
                  value={settings.icon192 || ''}
                  onChange={e => setSettings({ ...settings, icon192: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  disabled={!pwaEnabled}
                />
                {settings.icon192 && (
                  <img
                    src={settings.icon192}
                    alt="Icon 192"
                    className="mt-2 w-12 h-12 rounded-lg object-contain bg-muted border"
                  />
                )}
                <p className="text-xs text-muted-foreground mt-1">Standard icon for app</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Icon 512x512
                </label>
                <input
                  type="text"
                  value={settings.icon512 || ''}
                  onChange={e => setSettings({ ...settings, icon512: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  disabled={!pwaEnabled}
                />
                {settings.icon512 && (
                  <img
                    src={settings.icon512}
                    alt="Icon 512"
                    className="mt-2 w-12 h-12 rounded-lg object-contain bg-muted border"
                  />
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  High-res icon for splash screen
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Maskable Icon
                </label>
                <input
                  type="text"
                  value={settings.maskableIcon || ''}
                  onChange={e => setSettings({ ...settings, maskableIcon: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  disabled={!pwaEnabled}
                />
                {settings.maskableIcon && (
                  <img
                    src={settings.maskableIcon}
                    alt="Maskable"
                    className="mt-2 w-12 h-12 rounded-lg object-contain bg-muted border"
                  />
                )}
                <p className="text-xs text-muted-foreground mt-1">Adaptive icon with safe zone</p>
              </div>
            </div>
          </div>

          {/* Features */}
          <div className="bg-card rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">Features</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <div>
                  <h3 className="font-medium text-foreground">Install Prompt</h3>
                  <p className="text-sm text-muted-foreground">
                    Show prompt to add app to home screen
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.installPromptEnabled}
                    onChange={e =>
                      setSettings({ ...settings, installPromptEnabled: e.target.checked })
                    }
                    className="sr-only peer"
                    disabled={!pwaEnabled}
                  />
                  <div
                    className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500 ${!pwaEnabled ? 'opacity-50' : ''}`}
                  ></div>
                </label>
              </div>

              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <div>
                  <h3 className="font-medium text-foreground">Offline Support</h3>
                  <p className="text-sm text-muted-foreground">Cache pages for offline access</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.offlineEnabled}
                    onChange={e => setSettings({ ...settings, offlineEnabled: e.target.checked })}
                    className="sr-only peer"
                    disabled={!pwaEnabled}
                  />
                  <div
                    className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500 ${!pwaEnabled ? 'opacity-50' : ''}`}
                  ></div>
                </label>
              </div>

              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <div>
                  <h3 className="font-medium text-foreground">Push Notifications</h3>
                  <p className="text-sm text-muted-foreground">
                    Send notifications to customers (requires setup)
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.pushNotificationsEnabled}
                    onChange={e =>
                      setSettings({ ...settings, pushNotificationsEnabled: e.target.checked })
                    }
                    className="sr-only peer"
                    disabled={!pwaEnabled}
                  />
                  <div
                    className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500 ${!pwaEnabled ? 'opacity-50' : ''}`}
                  ></div>
                </label>
              </div>
            </div>
          </div>

          {/* iOS Specific */}
          <div className="bg-card rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">iOS Settings</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Status Bar Style
                </label>
                <select
                  value={settings.iosStatusBarStyle}
                  onChange={e =>
                    setSettings({
                      ...settings,
                      iosStatusBarStyle: e.target.value as PWASettings['iosStatusBarStyle'],
                    })
                  }
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  disabled={!pwaEnabled}
                >
                  {IOS_STATUS_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Splash Screen Color
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={settings.splashScreenColor}
                    onChange={e => setSettings({ ...settings, splashScreenColor: e.target.value })}
                    className="w-10 h-10 rounded border border-border cursor-pointer"
                    disabled={!pwaEnabled}
                  />
                  <input
                    type="text"
                    value={settings.splashScreenColor}
                    onChange={e => setSettings({ ...settings, splashScreenColor: e.target.value })}
                    className="flex-1 px-3 py-2 border border-border rounded-lg text-sm uppercase"
                    disabled={!pwaEnabled}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Message */}
          {message && (
            <div
              className={`rounded-xl p-4 text-sm ${
                message.type === 'success'
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                  : 'bg-red-50 border border-red-200 text-red-700'
              }`}
            >
              {message.text}
            </div>
          )}

          {/* Save Button */}
          {pwaEnabled && (
            <div className="flex justify-end">
              <button
                onClick={handleSaveSettings}
                disabled={saving}
                className="px-6 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {saving && (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                )}
                Save Settings
              </button>
            </div>
          )}
        </div>
      )}
    </AdminLayout>
  );
}
