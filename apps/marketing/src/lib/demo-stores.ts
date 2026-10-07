import type { Locale } from './site';

/**
 * The ONE example store shown on ebda.app until the designed templates exist (builder
 * Phase 3; Ahmad 2026-10-07): Dahab, the jewellery store on night and gold, the brand's own
 * palette. scripts/storefront-capture seeds it into a local Ebda and captures the real
 * apps/web storefront for every device frame. No real merchant. Photos: public/demo/CREDITS.md.
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
