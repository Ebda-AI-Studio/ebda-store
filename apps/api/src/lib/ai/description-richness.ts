const ARABIC = /[؀-ۿ]/;

/** Heuristic richness score: trimmed length + a small bonus per sentence. */
export function descriptionRichness(text?: string | null): number {
  const t = (text ?? '').trim();
  if (!t) return 0;
  const sentences = t.split(/[.!؟?\n]/).filter(Boolean).length;
  return t.length + Math.max(0, sentences - 1) * 5;
}

/** Which side is richer, or null when both are effectively empty. */
export function richerSide(en?: string | null, ar?: string | null): 'en' | 'ar' | null {
  const e = descriptionRichness(en);
  const a = descriptionRichness(ar);
  if (e === 0 && a === 0) return null;
  return e >= a ? 'en' : 'ar';
}

export const containsArabic = (t?: string | null): boolean => !!t && ARABIC.test(t);
