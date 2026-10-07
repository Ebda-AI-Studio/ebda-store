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
    tagline: { ar: 'لأول متجر ليك', en: 'For your first store' },
    features: {
      ar: ['300 طلب في الشهر', 'عضوين في الفريق', 'منتجات من غير حد', 'دومين خاص بيك'],
      en: ['300 orders a month', '2 team members', 'Unlimited products', 'Your own domain'],
    },
  },
  {
    id: 'growth',
    name: { ar: 'النمو', en: 'Growth' },
    price: { amountMinor: 349000, period: 'month' },
    annualMinor: 3141000,
    tagline: { ar: 'لما البيع يكتر', en: 'When sales pick up' },
    features: {
      ar: [
        '3,000 طلب في الشهر',
        '5 أعضاء في الفريق',
        'رجّع السلات المتروكة',
        'شيل «مدعوم من ابدأ»',
      ],
      en: [
        '3,000 orders a month',
        '5 team members',
        'Win back abandoned carts',
        'Remove “Powered by Ebda”',
      ],
    },
  },
  {
    id: 'business',
    name: { ar: 'الأعمال', en: 'Business' },
    price: { amountMinor: 999000, period: 'month' },
    annualMinor: 8991000,
    tagline: { ar: 'للمتاجر الكبيرة', en: 'For bigger stores' },
    features: {
      ar: ['طلبات من غير حد', '15 عضو في الفريق', 'لحد 3 متاجر', 'ربط API ودعم بأولوية'],
      en: [
        'Unlimited orders',
        '15 team members',
        'Up to 3 stores',
        'API access and priority support',
      ],
    },
  },
];

export const PRICING_PLACEHOLDER: Record<Locale, string> = {
  ar: 'السعر قريب',
  en: 'Pricing coming soon',
};
