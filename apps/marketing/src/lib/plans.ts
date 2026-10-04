import type { Locale } from './site';

/**
 * Pricing is NOT decided (docs/ebda/research/pricing-and-packaging.md leaves
 * numbers to Ahmad). Everything the pricing section renders comes from this one
 * file. To publish: set `price` on each plan to `{ amountMinor, period }` (EGP
 * piastres) and flip PRICING_PUBLISHED. No number is invented here.
 */
export const PRICING_PUBLISHED = false;

export interface PlanPrice {
  /** EGP in piastres (minor units). */
  amountMinor: number;
  period: 'month' | 'year';
}

export interface Plan {
  id: 'starter' | 'growth' | 'pro' | 'scale';
  name: Record<Locale, string>;
  /** null until Ahmad decides; the UI then shows the "pricing coming soon" placeholder. */
  price: PlanPrice | null;
  tagline: Record<Locale, string>;
  features: Record<Locale, string[]>;
}

export const PLANS: readonly Plan[] = [
  {
    id: 'starter',
    name: { ar: 'البداية', en: 'Starter' },
    price: null,
    tagline: { ar: 'لأول متجر', en: 'For your first store' },
    features: {
      ar: [
        'متجر على <اسمك>.ebda.app',
        'الدفع عند الاستلام',
        'زر واتساب (wa.me)',
        'تحليلات أساسية',
        'واجهة عربية وإنجليزية',
      ],
      en: [
        'A store on <you>.ebda.app',
        'Cash on delivery',
        'WhatsApp click-to-chat button',
        'Basic analytics',
        'Arabic and English storefront',
      ],
    },
  },
  {
    id: 'growth',
    name: { ar: 'النمو', en: 'Growth' },
    price: null,
    tagline: { ar: 'لما يكبر البيع', en: 'When sales pick up' },
    features: {
      ar: ['كل مزايا البداية', 'دومين خاص بك', 'إزالة علامة ابدأ', 'طرق دفع أكثر', 'أعضاء فريق'],
      en: [
        'Everything in Starter',
        'Your own custom domain',
        'Remove Ebda branding',
        'More payment methods',
        'Team seats',
      ],
    },
  },
  {
    id: 'pro',
    name: { ar: 'المحترف', en: 'Pro' },
    price: null,
    tagline: { ar: 'لمتاجر بحجم أكبر', en: 'For busier stores' },
    features: {
      ar: ['كل مزايا النمو', 'تحليلات متقدمة', 'حدّ أعلى للطلبات', 'دعم بأولوية'],
      en: ['Everything in Growth', 'Advanced analytics', 'Higher order volume', 'Priority support'],
    },
  },
  {
    id: 'scale',
    name: { ar: 'التوسّع', en: 'Scale' },
    price: null,
    tagline: { ar: 'لحجم كبير', en: 'For high volume' },
    features: {
      ar: ['كل مزايا المحترف', 'أكثر من متجر', 'وصول API وwebhooks', 'عرض سعر مخصص'],
      en: ['Everything in Pro', 'Multiple stores', 'API access and webhooks', 'Custom quote'],
    },
  },
];

export const PRICING_PLACEHOLDER: Record<Locale, string> = {
  ar: 'السعر قريبًا',
  en: 'Pricing coming soon',
};
