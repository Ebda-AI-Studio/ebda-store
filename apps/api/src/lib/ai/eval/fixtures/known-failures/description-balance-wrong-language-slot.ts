import type { KnownFailureCase } from '../types';

/** The balancer swapped slots: descriptionAr ended up holding the English text (untranslated) instead of Arabic — the exact bug class the Arabic-authoritative balancer exists to prevent. */
export const descriptionBalanceWrongLanguageSlot: KnownFailureCase = {
  id: 'description-balance-wrong-language-slot',
  type: 'description-balance',
  description: 'descriptionAr holds untranslated English text instead of Arabic after balancing.',
  input: {
    name: 'Ceramic Mug',
    nameAr: null,
    description: 'A handmade ceramic mug.',
    descriptionAr: null,
  },
  output: {
    name: 'Ceramic Mug',
    nameAr: 'كوب سيراميك',
    description: 'A handmade ceramic mug.',
    descriptionAr: 'A handmade ceramic mug.',
  },
  expectedFailedChecks: ['language-slots-correct'],
};
