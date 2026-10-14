'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { apiPut } from '../../../../../lib/api';
import { useCurrentStore } from '../../../../../hooks/useCurrentStore';
import type { MarketingPixels, StoreData } from '../_components/types';

interface UseMarketingPixelsResult {
  store: StoreData | null;
  pixels: MarketingPixels;
  isLoading: boolean;
  isSaving: boolean;
  save: () => Promise<void>;
  updatePixel: (platformId: string, field: string, value: string | boolean) => void;
  togglePlatform: (platformId: string) => void;
}

/**
 * Handles the fetch / update / persist lifecycle for marketing-pixel settings.
 * Fetches the store via the shared `useCurrentStore` hook (dedupes with other
 * admin pages) and owns its toasts directly so the page component no longer
 * needs to plumb success/error flags into a status-bar render.
 */
export function useMarketingPixels(storeId: string): UseMarketingPixelsResult {
  const { store: fetchedStore, isLoading } = useCurrentStore(storeId);
  const toast = useToast();
  const tSave = useT('marketingPixels.save');
  const [pixels, setPixels] = useState<MarketingPixels>({});
  const [isSaving, setIsSaving] = useState(false);

  const store: StoreData | null = fetchedStore
    ? {
        id: fetchedStore.id,
        name: fetchedStore.name,
        marketingPixels: (fetchedStore.marketingPixels as MarketingPixels) || {},
      }
    : null;

  // Seed the editable pixel state once the store is fetched/cached.
  useEffect(() => {
    if (fetchedStore) {
      setPixels((fetchedStore.marketingPixels as MarketingPixels) || {});
    }
  }, [fetchedStore]);

  const save = useCallback(async () => {
    setIsSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/marketing-pixels`, {
        marketingPixels: pixels,
      });

      if (error) {
        throw new Error('Failed to save');
      }
      toast.success(tSave('successMessage'));
    } catch (error) {
      console.error('Failed to save marketing pixels:', error);
      toast.error(tSave('errorMessage'));
    } finally {
      setIsSaving(false);
    }
  }, [storeId, pixels, toast, tSave]);

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
    save,
    updatePixel,
    togglePlatform,
  };
}
