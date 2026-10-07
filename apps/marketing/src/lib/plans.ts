import type { Locale } from './site';

/** Locked EGP prices, in piastres; annual billing is nine monthly payments. */
export const PRICING_PUBLISHED = true;

export interface PlanPrice {
  /** EGP in piastres (minor units). */
  amountMinor: number;
  period: 'month' | 'year';
}

export interface Plan {
  id: 'basic' | 'growth' | 'business';
  name: Record<Locale, string>;
  /** null until Ahmad decides; the UI then shows the "pricing coming soon" placeholder. */
  price: PlanPrice | null;
  annualMinor: number;
  tagline: Record<Locale, string>;
  features: Record<Locale, string[]>;
}

export const PLANS: readonly Plan[] = [
  {
    id: 'basic',
    name: { ar: 'الأساسية', en: 'Basic' },
    price: { amountMinor: 149000, period: 'month' },
    annualMinor: 1341000,
    tagline: { ar: 'لأول متجر', en: 'For your first store' },
    features: {
      ar: ['٣٠٠ طلب شهريًا', 'عضوان للفريق', 'منتجات غير محدودة', 'دومين خاص وجميع طرق الدفع'],
      en: [
        '300 orders/month',
        '2 staff seats',
        'Unlimited products',
        'Custom domain and all payment methods',
      ],
    },
  },
  {
    id: 'growth',
    name: { ar: 'النمو', en: 'Growth' },
    price: { amountMinor: 349000, period: 'month' },
    annualMinor: 3141000,
    tagline: { ar: 'لما يكبر البيع', en: 'When sales pick up' },
    features: {
      ar: ['٣٬٠٠٠ طلب شهريًا', '٥ أعضاء للفريق', 'استعادة السلات المتروكة', 'إزالة علامة ابدأ'],
      en: [
        '3,000 orders/month',
        '5 staff seats',
        'Abandoned cart recovery',
        'Remove Ebda branding',
      ],
    },
  },
  {
    id: 'business',
    name: { ar: 'الأعمال', en: 'Business' },
    price: { amountMinor: 999000, period: 'month' },
    annualMinor: 8991000,
    tagline: { ar: 'لمتاجر بحجم أكبر', en: 'For busier stores' },
    features: {
      ar: ['طلبات غير محدودة', '١٥ عضوًا للفريق', 'حتى ٣ متاجر', 'دعم بأولوية'],
      en: ['Unlimited orders', '15 staff seats', 'Up to 3 stores', 'Priority support'],
    },
  },
];

export const PRICING_PLACEHOLDER: Record<Locale, string> = {
  ar: 'السعر قريبًا',
  en: 'Pricing coming soon',
};
