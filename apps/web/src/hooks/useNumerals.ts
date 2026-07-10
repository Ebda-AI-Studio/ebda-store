import { useCallback } from 'react';
import { toArabicDigits } from '@force/shared';
import { useLanguage } from '../contexts/LanguageContext';
import { useStore } from '../contexts/StoreContext';

/**
 * Single choke point for numeral localization on the storefront.
 *
 * By default every number renders in Western digits (0-9), in both
 * languages. A merchant can opt in (`StoreTheme.arabicNumerals`) so that
 * numeric displays render Eastern Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) — but
 * ONLY while the visitor is browsing the Arabic locale. The English
 * storefront always stays Western digits regardless of the flag.
 *
 * Wrap displayed numeric strings (prices, counts, quantities, page numbers,
 * loyalty points) with `localize(...)`. Do NOT apply it to identifiers
 * (order numbers, SKUs, phone numbers, tracking numbers) — those must stay
 * Western digits always.
 */
export function useNumerals() {
  const { language } = useLanguage();
  const { store } = useStore();
  const arabicNumerals = store?.theme?.arabicNumerals === true;

  const localize = useCallback(
    (value: string | number): string => {
      if (language === 'ar' && arabicNumerals) {
        return toArabicDigits(value);
      }
      return String(value);
    },
    [language, arabicNumerals]
  );

  return { localize };
}
