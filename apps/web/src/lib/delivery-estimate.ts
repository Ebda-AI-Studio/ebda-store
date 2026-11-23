/** Bilingual delivery-time text for the /shipping page (zone min/max/single day counts). */
import { deliveryDaysSchema, zoneForAddress, type DeliveryAddressLike } from '@ebda/shared';
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

interface EtaZone extends DeliveryEstimateInput {
  areas?: readonly string[] | null;
  areasAr?: readonly string[] | null;
}

/**
 * The delivery line under the checkout's delivery option (CK2): "بيوصل خلال 2–4 أيام عمل" /
 * "Arrives in 2–4 business days". The address's own shipping zone wins; a store whose zones carry no day
 * numbers uses its store-wide `settings.deliveryDays` (the delivery-times setting). When zones DO carry
 * numbers but none names this address there is no honest figure, so no line (same rule as the receipt).
 * Returns null when there is nothing configured: never "0 days".
 */
export function checkoutDeliveryEta(
  opts: {
    zones: readonly EtaZone[];
    address: DeliveryAddressLike;
    storeDeliveryDays: unknown;
  },
  lang: 'ar' | 'en'
): string | null {
  const num = (z: EtaZone) => z.estimatedDaysMin ?? z.estimatedDays ?? null;
  const numbered = opts.zones.filter(z => num(z) != null);
  let est: DeliveryEstimateInput | null = null;
  if (numbered.length > 0) {
    const own = zoneForAddress(opts.address, numbered);
    if (!own) return null;
    est = own;
  } else {
    const d = deliveryDaysSchema.safeParse(opts.storeDeliveryDays);
    if (d.success) est = { estimatedDaysMin: d.data.min, estimatedDaysMax: d.data.max };
  }
  if (!est) return null;
  const min = est.estimatedDaysMin ?? est.estimatedDays ?? null;
  const max = est.estimatedDaysMax ?? est.estimatedDays ?? min;
  if (!min || !max || max < min) return null;
  const text = formatEstimatedDays({ estimatedDaysMin: min, estimatedDaysMax: max }, lang);
  return lang === 'ar' ? `بيوصل خلال ${text}` : `Arrives in ${text}`;
}
