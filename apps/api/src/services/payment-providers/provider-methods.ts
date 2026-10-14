/**
 * The customer-facing methods of each Egyptian gateway, as the merchant enabled them.
 * One place for "which methods does this store's Paymob offer", used by the checkout
 * config, the v1 bridge (`getPaymentMethods`) and the admin.
 */
import { paymobSettingsBaseSchema, kashierSettingsSchema, fawrySettingsSchema } from '@ebda/shared';

export const METHOD_LABELS: Record<string, { name: string; nameAr: string }> = {
  card: { name: 'Card', nameAr: 'بطاقة' },
  meeza: { name: 'Meeza', nameAr: 'ميزة' },
  wallet: { name: 'Mobile wallet', nameAr: 'محفظة إلكترونية' },
  valu: { name: 'valU installments', nameAr: 'تقسيط فاليو' },
  payatfawry: { name: 'Pay at Fawry', nameAr: 'ادفع في فوري' },
};

/** Methods this merchant's config actually offers (an unset / invalid settings blob offers none). */
export function enabledMethods(provider: string, settings: unknown): string[] {
  const raw = settings && typeof settings === 'object' ? settings : {};
  switch (provider) {
    case 'paymob': {
      const parsed = paymobSettingsBaseSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.publicKey) return [];
      return Object.entries(parsed.data.integrationIds)
        .filter(([, id]) => typeof id === 'number')
        .map(([method]) => method);
    }
    case 'kashier': {
      const parsed = kashierSettingsSchema.safeParse(raw);
      return parsed.success ? parsed.data.methods : [];
    }
    case 'fawry': {
      const parsed = fawrySettingsSchema.safeParse(raw);
      return parsed.success ? parsed.data.methods : [];
    }
    default:
      return [];
  }
}
