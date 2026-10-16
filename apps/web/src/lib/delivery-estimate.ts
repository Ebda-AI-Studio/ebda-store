/** Bilingual delivery-time text for the /shipping page (zone min/max/single day counts). */
import { countText, BUSINESS_DAYS } from './plural';
export interface DeliveryEstimateInput {
  estimatedDays?: number | null;
  estimatedDaysMin?: number | null;
  estimatedDaysMax?: number | null;
}

export function formatEstimatedDays(zone: DeliveryEstimateInput, lang: 'ar' | 'en'): string {
  const { estimatedDaysMin: min, estimatedDaysMax: max, estimatedDays: one } = zone;
  if (min && max) {
    if (lang === 'ar') {
      return min === max
        ? countText('ar', max, BUSINESS_DAYS)
        : countText('ar', max, BUSINESS_DAYS, `${min}–${max}`);
    }
    return countText('en', max, BUSINESS_DAYS, `${min}–${max}`);
  }
  if (one) {
    return countText(lang, one, BUSINESS_DAYS);
  }
  return lang === 'ar' ? 'مدة التوصيل تختلف حسب المنطقة' : 'Delivery time varies';
}
