/**
 * The ONE counted-noun engine (Y-01, quality-bar § 2), shared by the storefront
 * (`apps/web/src/lib/plural.ts` re-exports it) and the API's SMS/push templates.
 * Arabic has six plural categories; `Intl.PluralRules` picks one and the caller supplies a form
 * per category with `{n}` where the number goes. The dual is the Egyptian "قطعتين" in every
 * position and 11+ takes the bare singular. See the web file for the rest of the nouns.
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
