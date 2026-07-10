import type { KnownFailureCase } from '../types';

/** Asked to translate EN -> AR, the model echoed the English source back untranslated. */
export const translationWrongTargetScript: KnownFailureCase = {
  id: 'translation-wrong-target-script',
  type: 'translation',
  description: 'Translation to Arabic returned the English source text verbatim, untranslated.',
  input: { text: 'Free shipping on orders over 20 KWD', from: 'en', to: 'ar', kind: 'free' },
  output: { translation: 'Free shipping on orders over 20 KWD' },
  expectedFailedChecks: ['target-script-correct'],
};
