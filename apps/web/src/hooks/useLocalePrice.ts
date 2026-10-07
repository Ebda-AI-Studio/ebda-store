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
    (amount: number) => formatPriceBase(amount, { locale, numerals }),
    [locale, numerals]
  );
}
