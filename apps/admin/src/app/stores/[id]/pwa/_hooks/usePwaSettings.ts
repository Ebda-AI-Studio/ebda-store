'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPut } from '../../../../../lib/api';
import { hslToHex } from '../../../../../lib/color';
import { BRAND } from '@ebda/shared';
import {
  DEFAULT_SETTINGS,
  type PWASettings,
  type StatusMessage,
  type StoreInfo,
} from '../_components/types';

/**
 * Centralizes data loading and mutations for the PWA settings page:
 * fetching store branding + existing settings, toggling enablement,
 * auto-populating defaults from the store, and persisting edits.
 */
export function usePwaSettings(storeId: string) {
  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pwaEnabled, setPwaEnabled] = useState(false);
  const [settings, setSettings] = useState<PWASettings>(DEFAULT_SETTINGS);
  const [hasExistingSettings, setHasExistingSettings] = useState(false);
  const [message, setMessage] = useState<StatusMessage | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  // Auto-populate from store branding when no existing PWA settings
  useEffect(() => {
    if (!storeInfo || hasExistingSettings) return;

    const themeColor = storeInfo.theme?.primaryColor
      ? hslToHex(storeInfo.theme.primaryColor)
      : BRAND.colors.night;

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

  const populateFromStore = useCallback(
    (populatedText: string) => {
      if (!storeInfo) return;
      const themeColor = storeInfo.theme?.primaryColor
        ? hslToHex(storeInfo.theme.primaryColor)
        : BRAND.colors.night;
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
      setMessage({ type: 'success', text: populatedText });
      setTimeout(() => setMessage(null), 3000);
    },
    [storeInfo]
  );

  const toggleEnabled = useCallback(
    async (errorText: string) => {
      setSaving(true);
      setMessage(null);
      try {
        const { error } = await apiPut(`/api/v1/stores/${storeId}/pwa/settings`, {
          pwaEnabled: !pwaEnabled,
        });
        if (!error) {
          setPwaEnabled(!pwaEnabled);
        } else {
          setMessage({ type: 'error', text: errorText });
        }
      } catch {
        setMessage({ type: 'error', text: errorText });
      } finally {
        setSaving(false);
      }
    },
    [pwaEnabled, storeId]
  );

  const saveSettings = useCallback(
    async (successText: string, errorText: string): Promise<boolean> => {
      setSaving(true);
      setMessage(null);
      try {
        const { error } = await apiPut(`/api/v1/stores/${storeId}/pwa/settings`, { settings });
        if (!error) {
          setMessage({ type: 'success', text: successText });
          setHasExistingSettings(true);
          return true;
        }
        setMessage({ type: 'error', text: errorText });
        return false;
      } catch {
        setMessage({ type: 'error', text: errorText });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [settings, storeId]
  );

  return {
    storeInfo,
    loading,
    saving,
    pwaEnabled,
    settings,
    setSettings,
    message,
    populateFromStore,
    toggleEnabled,
    saveSettings,
  };
}
