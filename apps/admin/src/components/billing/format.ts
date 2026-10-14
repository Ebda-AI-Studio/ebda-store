import type { BillingCard } from './types';
import { withNumerals } from '@ebda/shared';

export type UiLocale = 'ar' | 'en';

export function planLabel(
  p: { nameEn: string; nameAr: string } | undefined,
  fallback: string,
  locale: UiLocale
): string {
  if (!p) return fallback;
  return locale === 'ar' ? p.nameAr : p.nameEn;
}

export function fmtDate(iso: string | null | undefined, locale: UiLocale): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(
    locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB',
    withNumerals({
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
  );
}

/** "•••• 4242 visa" (brand omitted when unknown). */
export function cardLabel(card: BillingCard | null | undefined): string {
  if (!card?.last4) return '';
  return `•••• ${card.last4}${card.brand ? ` ${card.brand}` : ''}`;
}
