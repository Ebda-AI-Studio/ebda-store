'use client';

import { useCallback } from 'react';
import { formatPrice as formatPriceBase } from '@/lib/format';
import { useLanguage } from '../contexts/LanguageContext';
import { useStoreNumerals } from './useNumerals';

/**
 * Locale-aware price formatter — the ONE price formatter of the storefront.
 *
 * Arabic shoppers read `450 ج.م` (Western digits, the default in both
 * languages); English shoppers read `EGP 450`. Arabic-Indic digits
 * (`٤٥٠ ج.م`) only when the merchant opted in via `theme.arabicNumerals`
 * (Ruling NUMERALS-1). A whole amount drops its zero fraction.
 */
export function useLocalePrice(): (amount: number) => string {
  const { language } = useLanguage();
  const numerals = useStoreNumerals();
  const locale = language === 'ar' ? 'ar' : 'en';
  return useCallback(
    // A price never splits from its currency at a line end ("32,000" over "ج.م" at 390): the one
    // space is a no-break space on every storefront price path (STOP-2 re-audit).
    (amount: number) => formatPriceBase(amount, { locale, numerals }).replace(' ', '\u00A0'),
    [locale, numerals]
  );
}
