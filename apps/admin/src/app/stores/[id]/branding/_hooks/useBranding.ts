'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@force/ui';
import { apiGet, apiPut } from '../../../../../lib/api';
import { DEFAULT_THEME, type StoreBranding, type StoreTheme } from '../_components/types';
import { themePatch } from './theme-patch';

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
        setBranding({
          id: store.id,
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

      // Persist the new addressUrl / addressLink flags inside the JSONB
      // `settings.contact` blob. We have to merge with the rest of
      // `settings` so we don't blow away unrelated keys (footerLinks,
      // utilityBar, navMenu, etc.). Empty/whitespace URL collapses to
      // undefined so a stray space doesn't produce an `<a href=" ">`.
      const trimmedAddressUrl = branding.addressUrl?.trim();
      const settingsResultPromise = (async () => {
        const { data: getData, error: getErr } = await apiGet<{
          store: { settings?: Record<string, unknown> };
        }>(basePath);
        if (getErr) return { error: getErr };
        const currentSettings: Record<string, unknown> = { ...(getData?.store?.settings ?? {}) };
        const currentContact: Record<string, unknown> = {
          ...((currentSettings.contact as Record<string, unknown> | undefined) ?? {}),
        };
        if (trimmedAddressUrl) currentContact.addressUrl = trimmedAddressUrl;
        else delete currentContact.addressUrl;
        // Persist the boolean explicitly so legacy `'maps' | 'none'` values
        // get rewritten cleanly. Default `true` matches the storefront
        // resolver's default.
        currentContact.addressLink = branding.addressLink !== false;
        currentSettings.contact = currentContact;
        // Persist blogEnabled alongside the settings PUT — both ride
        // the same generic PUT /stores/:id endpoint per the
        // updateStoreSchema (2026-05-17). One round-trip covers both.
        return apiPut(basePath, {
          settings: currentSettings,
          ...(branding.blogEnabled !== undefined && { blogEnabled: branding.blogEnabled }),
        });
      })();

      // Only the keys the merchant changed on this page; nothing at all when
      // the theme was not touched (a logo/phone edit must not write theme).
      const changedTheme = themePatch(loadedTheme ?? branding.theme, branding.theme);
      const themeChanged = Object.keys(changedTheme).length > 0;

      const [brandingResult, themeResult, contactResult, socialResult, settingsResult] =
        await Promise.all([
          apiPut(`${basePath}/branding`, {
            name: branding.name,
            nameAr: branding.nameAr,
            logo: branding.logo,
            logoAr: branding.logoAr,
            favicon: branding.favicon,
            description: branding.description,
            descriptionAr: branding.descriptionAr,
          }),
          themeChanged
            ? apiPut(`${basePath}/theme`, changedTheme)
            : Promise.resolve({ data: null, error: null }),
          apiPut(`${basePath}/contact`, {
            email: branding.email,
            phone: branding.phone,
            phoneAr: branding.phoneAr,
            whatsapp: branding.whatsapp,
            address: branding.address,
            addressAr: branding.addressAr,
          }),
          apiPut(`${basePath}/social`, branding.socialLinks),
          settingsResultPromise,
        ]);

      const failed = [
        { name: messages.sectionBranding, result: brandingResult },
        { name: messages.sectionTheme, result: themeResult },
        { name: messages.sectionContact, result: contactResult },
        { name: messages.sectionSocial, result: socialResult },
        { name: messages.sectionContact, result: settingsResult },
      ].filter(r => r.result.error != null);

      if (failed.length > 0) {
        // Surface all failed sections, not just the first, so merchants know
        // exactly which parts of their branding didn't save.
        const first = failed[0];
        const err = first.result.error;
        if (err?.status === 403) {
          toast.error(messages.accessDeniedTitle, messages.accessDeniedBody);
        } else if (err?.status === 401) {
          toast.error(messages.sessionExpiredTitle, messages.sessionExpiredBody);
        } else {
          const failedNames = [...new Set(failed.map(f => f.name))].join(', ');
          toast.error(
            `${messages.saveFailedPrefix}${failedNames}`,
            err?.message || messages.serverError
          );
        }
        return;
      }

      setLoadedTheme(branding.theme);
      toast.success(messages.saveSuccessTitle, messages.saveSuccessBody);
    } catch (error) {
      console.error('Failed to save branding:', error);
      toast.error(messages.connectionErrorTitle, messages.connectionErrorSaveBody);
    } finally {
      setIsSaving(false);
    }
  }, [branding, loadedTheme, storeId, toast, messages]);

  return {
    branding,
    setBranding,
    isLoading,
    isSaving,
    saveBranding,
  };
}
