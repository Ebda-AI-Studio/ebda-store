import type { KnownFailureCase } from '../types';

/**
 * Same defect CLASS as the reported FAQ-duplication bug (ungrounded
 * generation), different shape: the model invents a specific number
 * (weight) that is nowhere in the product description. The full semantic
 * version of this check (any invented material/colour/compatibility, not
 * just numbers) is the model-judge "grounding" dimension — this fixture
 * exercises the deterministic numeric-spec proxy, which is the layer that
 * actually runs in CI on every push.
 */
export const productFaqInventsNumericSpec: KnownFailureCase = {
  id: 'product-faq-invents-numeric-spec',
  type: 'product-faq',
  description:
    'FAQ answer states a weight (450g) that is not present anywhere in the product description.',
  input: {
    storeId: 'store-1',
    storeName: 'Test Store',
    product: {
      name: 'Ceramic Serving Bowl',
      description: 'A hand-glazed ceramic serving bowl, dishwasher safe.',
    },
    count: 1,
  },
  output: [
    {
      question: 'How much does the bowl weigh?',
      questionAr: 'كم يزن الوعاء؟',
      answer: 'The bowl weighs 450g and is perfectly balanced for serving.',
      answerAr: 'يزن الوعاء 450 جرامًا وهو متوازن تمامًا للتقديم.',
    },
  ],
  expectedFailedChecks: ['no-invented-numeric-specs'],
};
