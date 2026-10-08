/** Bilingual delivery-time text for the /shipping page (zone min/max/single day counts). */
export interface DeliveryEstimateInput {
  estimatedDays?: number | null;
  estimatedDaysMin?: number | null;
  estimatedDaysMax?: number | null;
}

/** Arabic noun agreement for "business day(s)": 1, 2, 3-10, 11+. */
function arDays(n: number): string {
  if (n === 1) return 'يوم عمل واحد';
  if (n === 2) return 'يومان عمل';
  if (n >= 3 && n <= 10) return `${n} أيام عمل`;
  return `${n} يوم عمل`;
}

export function formatEstimatedDays(zone: DeliveryEstimateInput, lang: 'ar' | 'en'): string {
  const { estimatedDaysMin: min, estimatedDaysMax: max, estimatedDays: one } = zone;
  if (min && max) {
    if (lang === 'ar') {
      return min === max ? arDays(max) : `${min}–${max} ${max <= 10 ? 'أيام' : 'يوم'} عمل`;
    }
    return `${min}–${max} business days`;
  }
  if (one) {
    return lang === 'ar' ? arDays(one) : `${one} business day${one !== 1 ? 's' : ''}`;
  }
  return lang === 'ar' ? 'مدة التوصيل تختلف حسب المنطقة' : 'Delivery time varies';
}
