import type { KnownFailureCase } from '../types';

/** HowTo guide has 8 steps (prompt asks for 3-6) and stepsAr has a different count than steps — either defect alone would break the storefront's numbered-step rendering. */
export const howtoGuideStepCountOutOfRange: KnownFailureCase = {
  id: 'howto-guide-step-count-out-of-range',
  type: 'howto-guide',
  description: 'Guide has 8 steps (prompt spec is 3-6) and stepsAr is missing 2 of them.',
  input: { storeName: 'Test Store' },
  output: [
    {
      title: 'How to Return an Item',
      titleAr: 'كيفية إرجاع منتج',
      description: 'A walkthrough of our return process.',
      descriptionAr: 'شرح لعملية الإرجاع لدينا.',
      steps: Array.from({ length: 8 }, (_, i) => ({
        name: `Step ${i + 1}`,
        text: `Do step ${i + 1}.`,
      })),
      stepsAr: Array.from({ length: 6 }, (_, i) => ({
        name: `الخطوة ${i + 1}`,
        text: `نفذ الخطوة ${i + 1}.`,
      })),
    },
  ],
  expectedFailedChecks: ['step-count-in-range', 'steps-and-stepsAr-aligned'],
};
