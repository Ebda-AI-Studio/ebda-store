import { z } from 'zod';

/** Row caps, shared by the schema and the admin editor. */
export const PRODUCT_FACTS_MAX = 24;
export const PRODUCT_FACTS_ON_CARD_MAX = 2;

const clean = (max: number) => z.string().trim().max(max).default('');

export const productFactSchema = z
  .object({
    key: clean(40),
    keyAr: clean(40),
    value: clean(120),
    valueAr: clean(120),
    onCard: z.boolean().default(false),
  })
  .refine(f => (f.key || f.keyAr) && (f.value || f.valueAr), {
    message: 'Fact needs a name and a value',
  });

export const productFactsSchema = z
  .array(productFactSchema)
  .max(PRODUCT_FACTS_MAX)
  .refine(a => a.filter(f => f.onCard).length <= PRODUCT_FACTS_ON_CARD_MAX, {
    message: 'At most 2 facts on the card',
  });

export type ProductFact = z.infer<typeof productFactSchema>;

/** Active-language text for a fact; falls back to the other language, never blank. */
export function factText(f: ProductFact, lang: 'ar' | 'en') {
  const pick = (en: string, ar: string) => (lang === 'ar' ? ar || en : en || ar);
  return { key: pick(f.key, f.keyAr), value: pick(f.value, f.valueAr) };
}

/** The rows the merchant pinned to the product card (max 2). */
export function cardFacts(facts: ProductFact[] | null | undefined): ProductFact[] {
  return (facts ?? []).filter(f => f.onCard).slice(0, PRODUCT_FACTS_ON_CARD_MAX);
}
