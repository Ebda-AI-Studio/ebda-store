'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPut } from '../../../../../lib/api';
import type { MarketingPixels, StoreData } from '../_components/types';

interface UseMarketingPixelsResult {
  store: StoreData | null;
  pixels: MarketingPixels;
  isLoading: boolean;
  isSaving: boolean;
  saveError: boolean;
  saveSuccess: boolean;
  save: () => Promise<void>;
  updatePixel: (platformId: string, field: string, value: string | boolean) => void;
  togglePlatform: (platformId: string) => void;
}

/**
 * Handles the fetch / update / persist lifecycle for marketing-pixel settings.
 * Keeps the page component free of API glue and exposes boolean save flags so
 * the UI can localise the status message itself.
 */
export function useMarketingPixels(storeId: string): UseMarketingPixelsResult {
  const [store, setStore] = useState<StoreData | null>(null);
  const [pixels, setPixels] = useState<MarketingPixels>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchStore = useCallback(async () => {
    if (!storeId) return;
    try {
      const { data } = await apiGet<{ store: StoreData }>(`/api/v1/stores/${storeId}`);
      if (data?.store) {
        setStore(data.store);
        setPixels(data.store.marketingPixels || {});
      }
    } catch (error) {
      console.error('Failed to fetch store:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchStore();
  }, [fetchStore]);

  const save = useCallback(async () => {
    setIsSaving(true);
    setSaveError(false);
    setSaveSuccess(false);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/marketing-pixels`, {
        marketingPixels: pixels,
      });

      if (error) {
        throw new Error('Failed to save');
      }
      setSaveSuccess(true);
    } catch (error) {
      console.error('Failed to save marketing pixels:', error);
      setSaveError(true);
    } finally {
      setIsSaving(false);
    }
  }, [storeId, pixels]);

  const updatePixel = useCallback((platformId: string, field: string, value: string | boolean) => {
    setPixels(prev => {
      const current = (prev as Record<string, Record<string, unknown>>)[platformId] || {
        enabled: false,
      };
      return {
        ...prev,
        [platformId]: {
          ...current,
          [field]: value,
        },
      };
    });
  }, []);

  const togglePlatform = useCallback(
    (platformId: string) => {
      const current = (pixels as Record<string, { enabled?: boolean }>)[platformId];
      const isEnabled = current?.enabled || false;
      updatePixel(platformId, 'enabled', !isEnabled);
    },
    [pixels, updatePixel]
  );

  return {
    store,
    pixels,
    isLoading,
    isSaving,
    saveError,
    saveSuccess,
    save,
    updatePixel,
    togglePlatform,
  };
}
