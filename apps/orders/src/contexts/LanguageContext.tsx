'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { MESSAGES, type Locale, type Messages } from '@/i18n/messages';

interface LanguageContextType {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: Messages;
  setLocale: (l: Locale) => void;
  toggle: () => void;
}

const LanguageContext = createContext<LanguageContextType | null>(null);

const STORAGE_KEY = 'force-orders-locale';

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  // Restore persisted locale on mount (client-only — avoids hydration mismatch).
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'en' || stored === 'ar') setLocaleState(stored);
    } catch {
      // localStorage unavailable
    }
  }, []);

  // Keep <html> lang/dir in sync so RTL flips the whole document.
  useEffect(() => {
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // ignore
    }
  }, []);

  const toggle = useCallback(() => {
    setLocale(locale === 'en' ? 'ar' : 'en');
  }, [locale, setLocale]);

  const value = useMemo<LanguageContextType>(
    () => ({
      locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      t: MESSAGES[locale],
      setLocale,
      toggle,
    }),
    [locale, setLocale, toggle]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
