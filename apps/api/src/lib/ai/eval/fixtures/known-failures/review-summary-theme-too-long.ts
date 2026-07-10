import type { KnownFailureCase } from '../types';

/** Review summary theme is a full sentence instead of the "3-7 words" short phrase the prompt asks for — breaks the compact pill/chip UI the merchant dashboard renders these in. */
export const reviewSummaryThemeTooLong: KnownFailureCase = {
  id: 'review-summary-theme-too-long',
  type: 'review-summary',
  description:
    'A "top positive" theme is a full run-on sentence instead of a short 3-7 word phrase.',
  input: {
    reviews: [
      {
        rating: 5,
        body: 'The glaze finish is beautiful and the handle feels sturdy in my hand every morning.',
      },
    ],
  },
  output: {
    topPositives: [
      'Many customers repeatedly mention that they really love the beautiful glaze finish and how sturdy the handle feels when they use it every single morning for their coffee',
    ],
    topNegatives: [],
    overallSentiment: 'positive',
  },
  expectedFailedChecks: ['themes-are-short-phrases'],
};
