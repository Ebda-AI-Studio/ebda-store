'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  type StoreTheme,
  type StoreSocialLinks,
  type AnnouncementBar,
  type TemplateId,
  DEFAULT_THEME,
  BORDER_RADIUS_MAP,
  FONT_FAMILY_MAP,
} from '@force/shared';

/**
 * Convert theme to CSS custom properties
 * Defined locally to avoid module resolution issues
 */
function themeToCssVars(theme: StoreTheme): Record<string, string> {
  return {
    '--primary': theme.primaryColor,
    '--primary-foreground': theme.primaryForeground,
    '--secondary': theme.secondaryColor,
    '--secondary-foreground': theme.secondaryForeground,
    '--accent': theme.accentColor,
    '--accent-foreground': theme.accentForeground,
    '--background': theme.backgroundColor,
    '--foreground': theme.foregroundColor,
    '--muted': theme.mutedColor,
    '--muted-foreground': theme.mutedForeground,
    '--border': theme.borderColor,
    '--card': theme.cardColor,
    '--card-foreground': theme.cardForeground,
    '--popover': theme.popoverColor,
    '--popover-foreground': theme.popoverForeground,
    '--input': theme.inputColor,
    '--ring': theme.ringColor,
    '--destructive': theme.destructiveColor,
    '--destructive-foreground': theme.destructiveForeground,
    '--success': theme.successColor,
    '--success-foreground': theme.successForeground,
    '--warning': theme.warningColor,
    '--warning-foreground': theme.warningForeground,
    '--radius': BORDER_RADIUS_MAP[theme.borderRadius],
    '--font-family': FONT_FAMILY_MAP[theme.fontFamily],
  };
}

/**
 * Store data available in client components
 */
export interface StoreData {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  domain?: string;
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  currency: string;
  timezone: string;
  template: TemplateId;
  theme: StoreTheme;
  socialLinks: StoreSocialLinks;
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;
  announcementBar?: AnnouncementBar;
  metaTitle?: string;
  metaTitleAr?: string;
  metaDescription?: string;
  metaDescriptionAr?: string;
}

interface StoreContextValue {
  store: StoreData;
  isLoading: boolean;
  error: Error | null;
  refreshStore: () => Promise<void>;
}

const StoreContext = createContext<StoreContextValue | null>(null);

/**
 * Default store for initial render
 */
const DEFAULT_STORE: StoreData = {
  id: 'demo',
  name: 'Force Demo Store',
  nameAr: 'متجر فورس التجريبي',
  slug: 'demo',
  currency: 'KWD',
  timezone: 'Asia/Kuwait',
  template: 'modern',
  theme: DEFAULT_THEME,
  socialLinks: {},
};

interface StoreProviderProps {
  children: ReactNode;
  initialStore?: StoreData;
}

/**
 * Apply theme CSS variables to the document
 */
function applyTheme(theme: StoreTheme | undefined): void {
  if (typeof document === 'undefined') return;
  if (!theme) return;

  const cssVars = themeToCssVars(theme);
  const root = document.documentElement;

  Object.entries(cssVars).forEach(([property, value]) => {
    root.style.setProperty(property, value);
  });
}

export function StoreProvider({ children, initialStore }: StoreProviderProps) {
  // Merge initialStore with defaults to ensure theme is always present
  const mergedInitialStore = initialStore
    ? { ...DEFAULT_STORE, ...initialStore, theme: initialStore.theme || DEFAULT_THEME }
    : DEFAULT_STORE;

  const [store, setStore] = useState<StoreData>(mergedInitialStore);
  const [isLoading, setIsLoading] = useState(!initialStore);
  const [error, setError] = useState<Error | null>(null);

  // Apply theme on mount and when theme changes
  useEffect(() => {
    applyTheme(store.theme || DEFAULT_THEME);
  }, [store.theme]);

  // Apply favicon
  useEffect(() => {
    if (store.favicon && typeof document !== 'undefined') {
      const link =
        (document.querySelector("link[rel*='icon']") as HTMLLinkElement) ||
        document.createElement('link');
      link.type = 'image/x-icon';
      link.rel = 'shortcut icon';
      link.href = store.favicon;
      document.getElementsByTagName('head')[0].appendChild(link);
    }
  }, [store.favicon]);

  const refreshStore = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/store');
      if (!response.ok) {
        throw new Error('Failed to fetch store');
      }
      const data = await response.json();
      if (data.store) {
        setStore(data.store);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  return (
    <StoreContext.Provider value={{ store, isLoading, error, refreshStore }}>
      {children}
    </StoreContext.Provider>
  );
}

/**
 * Hook to access store data in client components
 */
export function useStore(): StoreContextValue {
  const context = useContext(StoreContext);

  if (!context) {
    throw new Error('useStore must be used within a StoreProvider');
  }

  return context;
}

/**
 * Hook to get the current store's theme
 */
export function useStoreTheme(): StoreTheme {
  const { store } = useStore();
  return store.theme;
}

/**
 * Hook to get the current store's template
 */
export function useStoreTemplate(): TemplateId {
  const { store } = useStore();
  return store.template;
}

/**
 * Hook to get store branding info
 */
export function useStoreBranding() {
  const { store } = useStore();
  return {
    name: store.name,
    nameAr: store.nameAr,
    logo: store.logo,
    logoAr: store.logoAr,
    description: store.description,
    descriptionAr: store.descriptionAr,
  };
}

/**
 * Hook to get store contact info
 */
export function useStoreContact() {
  const { store } = useStore();
  return {
    email: store.email,
    phone: store.phone,
    phoneAr: store.phoneAr,
    whatsapp: store.whatsapp,
    address: store.address,
    addressAr: store.addressAr,
    socialLinks: store.socialLinks,
  };
}

/**
 * Hook to get announcement bar configuration
 */
export function useAnnouncementBar(): AnnouncementBar | undefined {
  const { store } = useStore();
  return store.announcementBar;
}
