import type { KnownFailureCase } from '../types';

/**
 * bulk-ai-citation-copy has NO explicit anti-hallucination instruction in
 * its prompt today (unlike product-faq-generator, which got one in PR
 * #538 after the merchant report) — this fixture demonstrates the SAME
 * defect class landing here too: an invented capacity number, plus a
 * length overrun past the 500-char persisted-field cap.
 */
export const citationCopyInventedSpecAndTooLong: KnownFailureCase = {
  id: 'citation-copy-invented-spec-and-too-long',
  type: 'citation-copy',
  description:
    'Citation copy invents a "500ml" capacity not present in the description, and exceeds the 500-char field cap.',
  input: {
    productName: 'Handmade Ceramic Mug',
    description: 'A handmade ceramic mug, dishwasher safe.',
  },
  output: {
    en: 'Handmade Ceramic Mug is a dishwasher-safe ceramic mug with a 500ml capacity, crafted from premium stoneware clay fired at high temperature for durability and finished with a lead-free glaze that is safe for everyday beverages and food contact. '.repeat(
      3
    ),
    ar: 'كوب السيراميك اليدوي هو كوب سيراميك آمن لغسالة الصحون بسعة 500 مل. '.repeat(3),
  },
  expectedFailedChecks: ['no-invented-numeric-specs', 'within-500-chars'],
};
