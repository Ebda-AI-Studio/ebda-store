/**
 * A post-check for AI-written Arabic sentences shown to merchants (RO2: "بـ 10 وحد مع" reached the reorder
 * cards). The model sometimes truncates a unit word, detaches a prefix from its word with a kashida, or loops
 * a token. None of those can be fixed mechanically, so a sentence that shows one is DROPPED (the caller keeps
 * the English text instead) rather than shown broken. Pure, no I/O.
 */
const AR = '\\u0621-\\u064A';

/** Signatures of a malformed generated sentence. Each is a mechanical glitch, never valid Arabic. */
const MALFORMED: ReadonlyArray<RegExp> = [
  // a one-letter prefix + kashida cut off from its word: "بـ 10", "لـ ."
  new RegExp(`(^|\\s)[بلكف]\u0640(\\s|$)`),
  // the unit word "وحدة" truncated to "وحد" or "وح" standing alone
  new RegExp(`(^|[^${AR}])(?:وحد|وح)(?![${AR}])`),
  // the same word three times in a row
  /(?:^|\s)(\S{2,})(?:\s+\1){2}(?:\s|$)/u,
  // a stray replacement / control character
  /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/,
];

/** The Arabic reasoning text to keep, or null when it is empty, not Arabic, or malformed. */
export function cleanArabicReasoning(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (!new RegExp(`[${AR}]`).test(t)) return null;
  if (MALFORMED.some(re => re.test(t))) return null;
  return t;
}
