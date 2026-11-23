'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@ebda/ui';
import { apiGet, apiPut } from '../../../../../lib/api';
import { DEFAULT_THEME, type StoreBranding, type StoreTheme } from '../_components/types';
import { themePatch } from './theme-patch';
import { brandingPatch, CONTACT_KEYS, keyPatch, settingsContactPatch } from './branding-patch';

interface StoreResponse {
  id: string;
  template?: string;
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
  blogEnabled?: boolean;
  /**
   * `addressUrl` + `addressLink` live inside `settings.contact` (the JSONB
   * column) because they're storefront-display flags rather than columns
   * on the Store table. The store route returns the entire settings blob
   * so we read these out here.
   */
  settings?: Record<string, unknown>;
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
  // The theme as SHOWN when the page loaded (stored theme over the display
  // defaults). Saving diffs against it so only the keys the merchant changed
  // here reach `PUT /theme` — never the defaults (see theme-patch.ts).
  const [loadedTheme, setLoadedTheme] = useState<StoreTheme | null>(null);
  // The branding as last loaded/saved: the sticky Save bar shows while the page differs from it.
  const [baseline, setBaseline] = useState<string | null>(null);

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
        // Pull addressUrl + addressLink out of `settings.contact`. Tolerate
        // legacy values (`'maps' | 'none'`) by normalising to a boolean — a
        // tenant that hadn't been migrated yet shouldn't see their toggle
        // appear in the wrong state on first load.
        const settingsContact =
          (store.settings?.contact as Record<string, unknown> | undefined) ?? {};
        const rawAddressLink = settingsContact.addressLink;
        const addressLink: boolean | undefined =
          rawAddressLink === false || rawAddressLink === 'none'
            ? false
            : rawAddressLink === true || rawAddressLink === 'maps'
              ? true
              : undefined;
        const addressUrl =
          typeof settingsContact.addressUrl === 'string' ? settingsContact.addressUrl : undefined;

        const shownTheme: StoreTheme = { ...DEFAULT_THEME, ...(store.theme || {}) };
        setLoadedTheme(shownTheme);
        const loaded: StoreBranding = {
          id: store.id,
          template: store.template,
          name: store.name,
          nameAr: store.nameAr,
          logo: store.logo,
          logoAr: store.logoAr,
          favicon: store.favicon,
          description: store.description,
          descriptionAr: store.descriptionAr,
          theme: shownTheme,
          email: store.email,
          phone: store.phone,
          phoneAr: store.phoneAr,
          whatsapp: store.whatsapp,
          address: store.address,
          addressAr: store.addressAr,
          addressUrl,
          addressLink,
          socialLinks: store.socialLinks || {},
          blogEnabled: store.blogEnabled,
        };
        setBranding(loaded);
        setBaseline(JSON.stringify(loaded));
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

  const dirty = useMemo(
    () => baseline !== null && branding !== null && JSON.stringify(branding) !== baseline,
    [baseline, branding]
  );

  /**
   * ONE request (BE:F-3): `PUT /stores/:id/branding-bundle` applies branding, theme, contact, social and the
   * `settings.contact` flags together and rolls ALL of it back on any failure, so a 429 or a bad field can no
   * longer leave the store half saved. Only this page's keys travel (BE:F-2): `settings` carries just `contact`,
   * never the whole blob, and `blogEnabled` is not sent at all (it lives on the blog page now).
   */
  const saveBranding = useCallback(async () => {
    if (!branding) return;

    setIsSaving(true);
    try {
      const loaded = (baseline ? JSON.parse(baseline) : {}) as StoreBranding;
      const changedTheme = themePatch(loadedTheme ?? branding.theme, branding.theme);
      const themeChanged = Object.keys(changedTheme).length > 0;
      // Only what the merchant changed on this page travels (see branding-patch.ts): a save never writes back a stale copy of
      // a value another page set meanwhile.
      const contact = keyPatch(
        loaded as unknown as Record<string, unknown>,
        branding as unknown as Record<string, unknown>,
        CONTACT_KEYS
      );
      const social = keyPatch(loaded.socialLinks ?? {}, branding.socialLinks ?? {});
      const settingsContact = settingsContactPatch(loaded, branding);

      const { error } = await apiPut(`/api/v1/stores/${storeId}/branding-bundle`, {
        branding: brandingPatch(loaded, branding),
        ...(themeChanged && { theme: changedTheme }),
        ...(Object.keys(contact).length > 0 && { contact }),
        ...(Object.keys(social).length > 0 && { social }),
        ...(Object.keys(settingsContact).length > 0 && {
          settings: { contact: settingsContact },
        }),
      });

      if (error) {
        if (error.status === 403) {
          toast.error(messages.accessDeniedTitle, messages.accessDeniedBody);
        } else if (error.status === 401) {
          toast.error(messages.sessionExpiredTitle, messages.sessionExpiredBody);
        } else {
          // apiRequest already localized the message (ERROR_AR / server messageAr).
          toast.error(messages.saveFailedPrefix, error.message || messages.serverError);
        }
        return;
      }

      setLoadedTheme(branding.theme);
      setBaseline(JSON.stringify(branding));
      toast.success(messages.saveSuccessTitle, messages.saveSuccessBody);
    } catch (error) {
      console.error('Failed to save branding:', error);
      toast.error(messages.connectionErrorTitle, messages.connectionErrorSaveBody);
    } finally {
      setIsSaving(false);
    }
  }, [branding, baseline, loadedTheme, storeId, toast, messages]);

  const resetBranding = useCallback(() => {
    if (baseline) setBranding(JSON.parse(baseline) as StoreBranding);
  }, [baseline]);

  return {
    branding,
    setBranding,
    isLoading,
    isSaving,
    saveBranding,
    dirty,
    resetBranding,
  };
}
