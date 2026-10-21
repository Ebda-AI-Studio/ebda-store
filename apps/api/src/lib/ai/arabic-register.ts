/**
 * The ONE Arabic-register instruction for AI copy a shopper reads (Ruling FU46-Y02d, Ahmad
 * 2026-10-16 "Egyptian for full sentences"). Every storefront-facing generator embeds it; the gate
 * is `tests/unit/ai-arabic-register.test.ts`. It changes NEW output only — stored merchant text is
 * never rewritten. Fact and PII guards stay in each prompt; this line only sets the voice.
 */
export const EGYPTIAN_ARABIC_REGISTER =
  'Arabic: natural Egyptian Arabic (Masri) in full sentences, the way a friendly Egyptian shop ' +
  'owner writes to customers — clear and warm, not Modern Standard Arabic and not street slang. ' +
  'Short labels and titles may stay neutral nouns. Keep product names, brand names, numbers, ' +
  'sizes and measurements exactly as given.';
