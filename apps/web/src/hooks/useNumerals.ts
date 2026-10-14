import { useCallback } from 'react';
import {
  effectiveNumerals,
  formatMoney,
  localizeDigits,
  storeNumerals,
  type Numerals,
} from '@ebda/shared';
import { useLanguage } from '../contexts/LanguageContext';
import { useStore } from '../contexts/StoreContext';

/**
 * The digit system for THIS render (Ruling NUMERALS-1): Western (0-9) unless
 * the merchant opted into Arabic-Indic (`StoreTheme.arabicNumerals`, admin:
 * "شكل الأرقام في المتجر") AND the shopper is reading Arabic. Pass it to
 * `formatPrice` / `intlLocale` / `<Price numerals>`.
 */
export function useStoreNumerals(): Numerals {
  const { language } = useLanguage();
  const { store } = useStore();
  return effectiveNumerals(language, storeNumerals(store?.theme));
}

/**
 * Single choke point for numeral localization of pre-formatted strings on the
 * storefront. Wrap displayed numeric strings (counts, quantities, page
 * numbers, loyalty points) with `localize(...)`. Do NOT apply it to
 * identifiers (order numbers, SKUs, phone numbers, tracking numbers) — those
 * stay Western digits always. Prices go through `useLocalePrice`.
 */
export function useNumerals() {
  const numerals = useStoreNumerals();
  const localize = useCallback(
    (value: string | number): string => localizeDigits(value, numerals),
    [numerals]
  );
  /** A MINOR-unit amount without its currency (`1,299.50`, `450`) in the
   *  render's digits — for layouts that place the symbol themselves. */
  const money = useCallback(
    (minor: number): string => formatMoney(minor, 'ar', { hideSymbol: true, numerals }),
    [numerals]
  );
  return { localize, money, numerals };
}
