'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@force/ui';
import { apiGet, apiPut } from '../../../../../lib/api';
import { DEFAULT_THEME, type StoreBranding, type StoreTheme } from '../_components/types';

interface StoreResponse {
  id: string;
  name: string;
  nameAr?: string;
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  theme?: Partial<StoreTheme>;
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;
  socialLinks?: StoreBranding['socialLinks'];
}

interface ToastMessages {
  loadFailedTitle: string;
  connectionErrorTitle: string;
  connectionErrorBody: string;
  connectionErrorSaveBody: string;
  serverErrorPrefix: string;
  accessDeniedTitle: string;
  accessDeniedBody: string;
  sessionExpiredTitle: string;
  sessionExpiredBody: string;
  saveFailedPrefix: string;
  serverError: string;
  saveSuccessTitle: string;
  saveSuccessBody: string;
  sectionBranding: string;
  sectionTheme: string;
  sectionContact: string;
  sectionSocial: string;
}

/**
 * Centralizes data loading and save coordination for the store branding page.
 * Translations are injected from the page so the hook stays locale-agnostic.
 */
export function useBranding(storeId: string, messages: ToastMessages) {
  const toast = useToast();
  const [branding, setBranding] = useState<StoreBranding | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const fetchBranding = useCallback(async () => {
    try {
      const { data, error: apiError } = await apiGet<{ store: StoreResponse }>(
        `/api/v1/stores/${storeId}`
      );

      if (apiError) {
        toast.error(
          messages.loadFailedTitle,
          apiError.message || `${messages.serverErrorPrefix}${apiError.status}`
        );
        return;
      }

      if (data?.store) {
        const store = data.store;
        setBranding({
          id: store.id,
          name: store.name,
          nameAr: store.nameAr,
          logo: store.logo,
          logoAr: store.logoAr,
          favicon: store.favicon,
          description: store.description,
          descriptionAr: store.descriptionAr,
          theme: { ...DEFAULT_THEME, ...(store.theme || {}) },
          email: store.email,
          phone: store.phone,
          phoneAr: store.phoneAr,
          whatsapp: store.whatsapp,
          address: store.address,
          addressAr: store.addressAr,
          socialLinks: store.socialLinks || {},
        });
      }
    } catch (error) {
      console.error('Failed to fetch branding:', error);
      toast.error(messages.connectionErrorTitle, messages.connectionErrorBody);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, toast, messages]);

  useEffect(() => {
    fetchBranding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  const saveBranding = useCallback(async () => {
    if (!branding) return;

    setIsSaving(true);
    try {
      const basePath = `/api/v1/stores/${storeId}`;

      const [brandingResult, themeResult, contactResult, socialResult] = await Promise.all([
        apiPut(`${basePath}/branding`, {
          name: branding.name,
          nameAr: branding.nameAr,
          logo: branding.logo,
          logoAr: branding.logoAr,
          favicon: branding.favicon,
          description: branding.description,
          descriptionAr: branding.descriptionAr,
        }),
        apiPut(`${basePath}/theme`, branding.theme),
        apiPut(`${basePath}/contact`, {
          email: branding.email,
          phone: branding.phone,
          phoneAr: branding.phoneAr,
          whatsapp: branding.whatsapp,
          address: branding.address,
          addressAr: branding.addressAr,
        }),
        apiPut(`${basePath}/social`, branding.socialLinks),
      ]);

      const failed = [
        { name: messages.sectionBranding, result: brandingResult },
        { name: messages.sectionTheme, result: themeResult },
        { name: messages.sectionContact, result: contactResult },
        { name: messages.sectionSocial, result: socialResult },
      ].filter(r => r.result.error !== null);

      if (failed.length > 0) {
        const first = failed[0];
        const err = first.result.error;
        if (err?.status === 403) {
          toast.error(messages.accessDeniedTitle, messages.accessDeniedBody);
        } else if (err?.status === 401) {
          toast.error(messages.sessionExpiredTitle, messages.sessionExpiredBody);
        } else {
          toast.error(
            `${messages.saveFailedPrefix}${first.name}`,
            err?.message || messages.serverError
          );
        }
        return;
      }

      toast.success(messages.saveSuccessTitle, messages.saveSuccessBody);
    } catch (error) {
      console.error('Failed to save branding:', error);
      toast.error(messages.connectionErrorTitle, messages.connectionErrorSaveBody);
    } finally {
      setIsSaving(false);
    }
  }, [branding, storeId, toast, messages]);

  return {
    branding,
    setBranding,
    isLoading,
    isSaving,
    saveBranding,
  };
}
