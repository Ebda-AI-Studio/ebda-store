/**
 * Placeholder copy: text that was never written by a merchant (or a real AI
 * generation) and must not reach a live storefront.
 *
 * ONE definition, three consumers:
 *   - `validatePublishReadiness` (publish / rollback / legacy layout PUT) —
 *     refuses a page whose visible text settings still hold it;
 *   - the registry's section presets, which source their instructional
 *     starter copy from `PLACEHOLDER_STARTER_COPY` below so the default a
 *     merchant gets and the text the publish gate refuses can never drift;
 *   - `apps/api/src/lib/ai/placeholder-guard.ts` (bulk AI sweeps).
 *
 * Whole-string matching only. A merchant's real sentence that merely
 * CONTAINS "n/a" or "todo" ("Todo lo que necesitas", "Returns: n/a for
 * sale items") must never trip the gate, so every pattern is anchored.
 * Empty text is NOT placeholder copy here: an empty optional field renders
 * nothing, which is a valid published state.
 */

/**
 * Instructional starter copy the editor inserts to show a merchant WHERE to
 * write. It is a prompt, not content — publishing it as-is puts
 * "Tell customers what makes your products special." on a live store.
 */
export const PLACEHOLDER_STARTER_COPY = {
  imageTextBody: {
    en: 'Tell customers what makes your products special.',
    ar: 'احكِ لعملائك ما يميز منتجاتك.',
  },
} as const;

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^n\/a$/i,
  /^tbd$/i,
  /^todo$/i,
  /^undefined$/i,
  /^null$/i,
  /^\.{3,}$/,
  /^[-–—_]+$/,
  /^lorem ipsum\b/i,
  /^لوريم إيبسوم/,
  // "[insert text here]", "{{heading}}"
  /^\[[^\]]*\]$/,
  /^\{\{[^}]*\}\}$/,
  // "Sample text", "Dummy heading", "Placeholder"
  /^(sample|dummy|placeholder|example|test)( (text|title|heading|description|copy))?$/i,
  // "Your text here", "Insert heading here", "Write your story here"
  /^(your|insert|add|enter|type|write)\b[^.!?\n]{0,40}\bhere\.?$/i,
  // Arabic: "نص تجريبي", "نص نموذجي", "اكتب النص هنا"
  /^نص (تجريبي|نموذجي|افتراضي)$/,
  /^(اكتب|أدخل|ادخل|أضف|اضف)\s[^.!؟\n]{0,40}\sهنا\.?$/,
];

const normalize = (v: string): string =>
  v
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!؟?…]+$/u, '')
    .toLowerCase();

const STARTER_COPY_SET: ReadonlySet<string> = new Set(
  Object.values(PLACEHOLDER_STARTER_COPY).flatMap(c => [normalize(c.en), normalize(c.ar)])
);

/**
 * True when `v` is a non-empty string that is placeholder copy: a known
 * starter prompt, or a whole-string placeholder pattern (EN + AR).
 * Non-strings and blank strings return false (see module note).
 */
export function isPlaceholderCopy(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!t) return false;
  if (STARTER_COPY_SET.has(normalize(t))) return true;
  return PLACEHOLDER_PATTERNS.some(p => p.test(t));
}
