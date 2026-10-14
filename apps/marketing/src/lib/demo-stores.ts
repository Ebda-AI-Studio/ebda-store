import type { Locale } from './site';

/**
 * The one example store still captured from a real apps/web render: Dahab (jewellery on night
 * and gold, the brand's own palette), used by the scroll story and its bottom bar. The five
 * templates and their 15 looks shown in the looks section are NOT from here: they are generated
 * by scripts/looks (illustrative AI photos, public/looks). No real merchant. Photos: public/demo/CREDITS.md.
 */
export const TEMPLATE_IDS = ['dahab'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

type L = Record<Locale, string>;

export interface DemoProduct {
  /** Base file name in public/demo/ (without -<size>.<ext>). */
  img: string;
  name: L;
  /** EGP, whole pounds. */
  price: number;
}

export interface DemoStore {
  template: L;
  kind: L;
  name: L;
  tagline: L;
  products: [DemoProduct, DemoProduct, DemoProduct, DemoProduct];
}

export const DEMO_STORES: Record<TemplateId, DemoStore> = {
  dahab: {
    template: { ar: 'دهب', en: 'Dahab' },
    kind: { ar: 'مجوهرات', en: 'Jewellery' },
    name: { ar: 'مجوهرات نادين', en: 'Nadine Jewellery' },
    tagline: { ar: 'دهب عيار 21، بشغل إيد.', en: '21-karat gold, made by hand.' },
    products: [
      { img: 'dahab-solitaire', name: { ar: 'خاتم سوليتير', en: 'Solitaire ring' }, price: 32000 },
      { img: 'dahab-bands', name: { ar: 'دبل دهب', en: 'Gold bands' }, price: 18500 },
      { img: 'dahab-bangle', name: { ar: 'غويشة دهب', en: 'Gold bangle' }, price: 24900 },
      { img: 'dahab-chain', name: { ar: 'سلسلة دهب', en: 'Gold chain' }, price: 9750 },
    ],
  },
};

/** EGP with Western digits: "1,490 ج.م" in Arabic, "EGP 1,490" in English. */
export function egp(locale: Locale, pounds: number): string {
  const n = pounds.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return locale === 'ar' ? `${n} ج.م` : `EGP ${n}`;
}
