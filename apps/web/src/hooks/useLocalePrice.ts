'use client';

import { useCallback } from 'react';
import { formatPrice as formatPriceBase } from '@/lib/format';
import { useStore } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * Locale-aware price formatter.
 *
 * `formatPriceBase` defaults to Western digits when no locale is passed, so
 * every surface that shows money needs the same wrapper to give Arabic-locale
 * shoppers Arabic-Indic digits — and only when the merchant has actually opted
 * in via `theme.arabicNumerals`.
 *
 * That wrapper existed in TEN components, byte-identical down to the comment
 * (cart, checkout, order summary, checkout success, product detail, product list
 * item, shipping, account dashboard, orders list, order detail). Ten copies of
 * one currency-rendering rule is ten places to miss when the rule changes, on
 * every screen where a shopper reads a price.
 *
 * Two of the ten read `isRtl` rather than `language === 'ar'`. Those are the same
 * condition — LanguageContext defines `isRtl: language === 'ar'` — so unifying
 * them changes nothing.
 */
export function useLocalePrice(): (amount: number) => string {
  const { store } = useStore();
  const { language } = useLanguage();
  const useArabicDigits = language === 'ar' && store?.theme?.arabicNumerals === true;

  return useCallback(
    (amount: number) => formatPriceBase(amount, { locale: useArabicDigits ? 'ar' : 'en' }),
    [useArabicDigits]
  );
}
