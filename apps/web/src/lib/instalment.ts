import { resolveInstalment } from '@ebda/shared';
import { countText, MONTHS } from './plural';

export { resolveInstalment };

/**
 * The PDP instalment line (Ruling B2-9), pure. Arabic: "تقسيط من 1,290 ج.م في الشهر على
 * 12 شهرًا · تقريبي"; English: "From EGP 1,290 / month for 12 months · estimate". When the merchant
 * typed a provider NAME it is named in text ("تقسيط عبر X من ..."); no logo, ever. `money` is
 * the shared price formatter (digits and currency as everywhere else), `localize` the numerals
 * helper for the month count.
 */
export function instalmentText(
  lang: 'ar' | 'en',
  r: { monthly: number; months: number; providerAr?: string; providerEn?: string },
  money: (minor: number) => string,
  localize: (n: number) => string = String
): string {
  const months = countText(lang, r.months, MONTHS, localize(r.months));
  if (lang === 'en') {
    const lead = r.providerEn ? `Instalments via ${r.providerEn} from` : 'From';
    return `${lead} ${money(r.monthly)} / month for ${months} · estimate`;
  }
  const lead = r.providerAr ? `تقسيط عبر ${r.providerAr} من` : 'تقسيط من';
  return `${lead} ${money(r.monthly)} في الشهر على ${months} · تقريبي`;
}
