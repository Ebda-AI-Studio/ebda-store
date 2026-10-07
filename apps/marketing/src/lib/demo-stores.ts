import type { Locale } from './site';

/**
 * The five EXAMPLE stores, one per storefront template family (TEMPLATE_FAMILIES ids:
 * souq, dahab, qamar, lamma, jasmine). scripts/storefront-capture seeds them into a local
 * Ebda and captures the real apps/web storefront for the device frames; the template
 * switcher reads their labels. No real merchant. Photos: public/demo/CREDITS.md.
 */
export const TEMPLATE_IDS = ['souq', 'dahab', 'qamar', 'lamma', 'jasmine'] as const;
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
  souq: {
    template: { ar: 'سوق', en: 'Souq' },
    kind: { ar: 'إلكترونيات', en: 'Electronics' },
    name: { ar: 'تك كورنر', en: 'Tech Corner' },
    tagline: {
      ar: 'أصلي وبضمان، والتوصيل لحد البيت.',
      en: 'Genuine, with warranty, delivered home.',
    },
    products: [
      { img: 'souq-headphones', name: { ar: 'سماعة هيدفون', en: 'Headphones' }, price: 1250 },
      { img: 'souq-earbuds', name: { ar: 'إيربودز لاسلكي', en: 'Wireless earbuds' }, price: 899 },
      { img: 'souq-speaker', name: { ar: 'سبيكر بلوتوث', en: 'Bluetooth speaker' }, price: 650 },
      { img: 'souq-watch', name: { ar: 'ساعة سمارت', en: 'Smartwatch' }, price: 1890 },
    ],
  },
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
  qamar: {
    template: { ar: 'قمر', en: 'Qamar' },
    kind: { ar: 'أزياء', en: 'Fashion' },
    name: { ar: 'لين بوتيك', en: 'Leen Boutique' },
    tagline: { ar: 'كتان وجلد طبيعي للصيف.', en: 'Linen and leather for summer.' },
    products: [
      { img: 'qamar-dress', name: { ar: 'فستان كتان', en: 'Linen dress' }, price: 1350 },
      { img: 'qamar-shirt', name: { ar: 'قميص مقلّم', en: 'Striped shirt' }, price: 690 },
      { img: 'qamar-bag', name: { ar: 'شنطة جلد', en: 'Leather bag' }, price: 2400 },
      { img: 'qamar-shoes', name: { ar: 'جزمة جلد', en: 'Leather shoes' }, price: 1750 },
    ],
  },
  lamma: {
    template: { ar: 'لمّة', en: 'Lamma' },
    kind: { ar: 'أكل بيتي', en: 'Home food' },
    name: { ar: 'مطبخ أم يوسف', en: 'Om Youssef’s Kitchen' },
    tagline: { ar: 'أكل بيتي يوصلك سخن.', en: 'Home cooking, delivered warm.' },
    products: [
      { img: 'lamma-mahshi', name: { ar: 'ورق عنب (كيلو)', en: 'Vine leaves (1 kg)' }, price: 280 },
      {
        img: 'lamma-kahk',
        name: { ar: 'كحك وغُريبة (كيلو)', en: 'Kahk and ghorayeba (1 kg)' },
        price: 380,
      },
      { img: 'lamma-cake', name: { ar: 'كيكة شوكولاتة', en: 'Chocolate cake' }, price: 450 },
      { img: 'lamma-torshi', name: { ar: 'طرشي بلدي', en: 'Homemade pickles' }, price: 120 },
    ],
  },
  jasmine: {
    template: { ar: 'ياسمين', en: 'Jasmine' },
    kind: { ar: 'تجميل', en: 'Beauty' },
    name: { ar: 'ياسمينة', en: 'Yasmina' },
    tagline: { ar: 'عناية طبيعية لبشرتك.', en: 'Natural care for your skin.' },
    products: [
      { img: 'jasmine-serum', name: { ar: 'سيروم بشرة', en: 'Face serum' }, price: 420 },
      { img: 'jasmine-toner', name: { ar: 'تونر خيار', en: 'Cucumber toner' }, price: 240 },
      { img: 'jasmine-soap', name: { ar: 'صابون طبيعي', en: 'Natural soap' }, price: 95 },
      { img: 'jasmine-soaps', name: { ar: 'طقم صابون', en: 'Soap set' }, price: 260 },
    ],
  },
};

/** EGP with Western digits: "1,490 ج.م" in Arabic, "EGP 1,490" in English. */
export function egp(locale: Locale, pounds: number): string {
  const n = pounds.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return locale === 'ar' ? `${n} ج.م` : `EGP ${n}`;
}
