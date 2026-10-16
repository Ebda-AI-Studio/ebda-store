/**
 * The storefront's ONE counted-noun helper (Y-01, quality-bar § 2).
 *
 * Arabic has six plural categories, and the noun changes with each:
 * 0 → zero, 1 → one, 2 → two, 3-10 → few, 11-99 → many, 100+ → other
 * ("قطعة واحدة / قطعتين / ٣ قطع / ١١ قطعة / ١٠٠ قطعة"). English has one and
 * other. `Intl.PluralRules` picks the category; the caller supplies a form per
 * category, with `{n}` where the number goes. Concatenating "{count} {noun}"
 * ("1 منتجات", "1 items") is banned (`tests/unit/plural-counted-nouns.test.ts`).
 *
 * Plain module (no 'use client'), so server code and lib helpers use it too;
 * components reach it through `useLanguage().tn`.
 */
export type PluralLang = 'ar' | 'en';

/** One string per category; `{n}` is replaced by the displayed number. */
export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** Both languages' forms for one counted noun. */
export interface CountedNoun {
  en: PluralForms;
  ar: PluralForms;
}

const RULES: Record<PluralLang, Intl.PluralRules> = {
  ar: new Intl.PluralRules('ar'),
  en: new Intl.PluralRules('en'),
};

/**
 * `count` picks the form; `display` is what replaces `{n}` (the count in the
 * render's digits, or a range like "3–5"). A form that spells the number out
 * ("قطعة واحدة", "يومين") cannot show a range, so when `display` is a range the
 * one/two/zero forms without `{n}` give way to `few`, then `other`.
 */
export function plural(
  lang: PluralLang,
  count: number,
  forms: PluralForms,
  display: string = String(count)
): string {
  const category = RULES[lang].select(count) as keyof PluralForms;
  let form = forms[category] ?? forms.other;
  const isRange = /[–-]/.test(display);
  if (isRange && !form.includes('{n}')) form = forms.few ?? forms.other;
  return form.replace('{n}', display);
}

/** `plural` for a `CountedNoun`, in the given language. */
export function countText(
  lang: PluralLang,
  count: number,
  noun: CountedNoun,
  display?: string
): string {
  return plural(lang, count, noun[lang], display);
}

/* ── The storefront's counted nouns ───────────────────────────────────── */

/** Cart / order lines: "1 item" · "قطعة واحدة / قطعتين / ٣ قطع / ١١ قطعة". */
export const ITEMS: CountedNoun = {
  en: { one: '{n} item', other: '{n} items' },
  ar: {
    zero: '{n} قطعة',
    one: 'قطعة واحدة',
    two: 'قطعتين',
    few: '{n} قطع',
    many: '{n} قطعة',
    other: '{n} قطعة',
  },
};

/** Category product counts: "4 pieces" · "٤ قطع". */
export const PIECES: CountedNoun = {
  en: { one: '{n} piece', other: '{n} pieces' },
  ar: ITEMS.ar,
};

/** Search results. */
export const RESULTS: CountedNoun = {
  en: { one: '{n} result', other: '{n} results' },
  ar: {
    zero: '{n} نتيجة',
    one: 'نتيجة واحدة',
    two: 'نتيجتين',
    few: '{n} نتائج',
    many: '{n} نتيجة',
    other: '{n} نتيجة',
  },
};

/** Verified product reviews. */
export const VERIFIED_REVIEWS: CountedNoun = {
  en: { one: '{n} verified review', other: '{n} verified reviews' },
  ar: {
    zero: '{n} مراجعة موثّقة',
    one: 'مراجعة موثّقة واحدة',
    two: 'مراجعتين موثّقتين',
    few: '{n} مراجعات موثّقة',
    many: '{n} مراجعة موثّقة',
    other: '{n} مراجعة موثّقة',
  },
};

/** Calendar days (return windows, made-to-order lead times). */
export const DAYS: CountedNoun = {
  en: { one: '{n} day', other: '{n} days' },
  ar: {
    zero: '{n} يوم',
    one: 'يوم واحد',
    two: 'يومين',
    few: '{n} أيام',
    many: '{n} يومًا',
    other: '{n} يوم',
  },
};

/** Business days (shipping-zone estimates). */
export const BUSINESS_DAYS: CountedNoun = {
  en: { one: '{n} business day', other: '{n} business days' },
  ar: {
    zero: '{n} يوم عمل',
    one: 'يوم عمل واحد',
    two: 'يومين عمل',
    few: '{n} أيام عمل',
    many: '{n} يوم عمل',
    other: '{n} يوم عمل',
  },
};

/** FBT "add all": the lines that went into the cart. */
export const ITEMS_ADDED: CountedNoun = {
  en: { one: '{n} item added to your cart', other: '{n} items added to your cart' },
  ar: {
    zero: 'لم تُضف أي قطعة إلى سلتك',
    one: 'أُضيفت قطعة واحدة إلى سلتك',
    two: 'أُضيفت قطعتين إلى سلتك',
    few: 'أُضيفت {n} قطع إلى سلتك',
    many: 'أُضيفت {n} قطعة إلى سلتك',
    other: 'أُضيفت {n} قطعة إلى سلتك',
  },
};

/** FBT "add all": the lines that still need a size/colour. */
export const ITEMS_NEED_OPTIONS: CountedNoun = {
  en: { one: '{n} item needs a variant', other: '{n} items need a variant' },
  ar: {
    zero: 'لا توجد منتجات تحتاج إلى اختيار نوع',
    one: 'منتج واحد يحتاج إلى اختيار نوع',
    two: 'منتجين يحتاجان إلى اختيار نوع',
    few: '{n} منتجات تحتاج إلى اختيار نوع',
    many: '{n} منتجًا تحتاج إلى اختيار نوع',
    other: '{n} منتج تحتاج إلى اختيار نوع',
  },
};
