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
  /** null only if pricing is ever pulled again; the UI then shows the "pricing coming soon" placeholder. */
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
      ar: [
        '٣٠٠ طلب شهريًا',
        'عضوان للفريق',
        'متجر واحد',
        'منتجات غير محدودة',
        'دومين خاص وجميع طرق الدفع',
        'تحليلات أساسية ودعم بالبريد',
      ],
      en: [
        '300 orders/month',
        '2 staff seats',
        '1 store',
        'Unlimited products',
        'Custom domain and all payment methods',
        'Basic analytics and email support',
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
      ar: [
        '٣٬٠٠٠ طلب شهريًا',
        '٥ أعضاء للفريق',
        'متجر واحد',
        'استعادة السلات المتروكة',
        'إزالة علامة «مدعوم من ابدأ»',
        'تحليلات قياسية ودعم بالمحادثة',
      ],
      en: [
        '3,000 orders/month',
        '5 staff seats',
        '1 store',
        'Abandoned cart recovery',
        'Remove the “Powered by Ebda” footer',
        'Standard analytics and chat support',
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
      ar: [
        'طلبات غير محدودة',
        '١٥ عضوًا للفريق',
        'حتى ٣ متاجر',
        'وصول API',
        'تحليلات متقدمة ودعم بأولوية',
        'كل ميزات النمو',
      ],
      en: [
        'Unlimited orders',
        '15 staff seats',
        'Up to 3 stores',
        'API access',
        'Advanced analytics and priority support',
        'Everything in Growth',
      ],
    },
  },
];

export const PRICING_PLACEHOLDER: Record<Locale, string> = {
  ar: 'السعر قريبًا',
  en: 'Pricing coming soon',
};
