import type { KnownFailureCase } from '../types';

/** Recommendation sweep recommends the source product to itself, includes a duplicate pick, and references a product id outside the candidate list — three distinct guard-rail violations in one output. */
export const productRecommendationsSelfAndDuplicate: KnownFailureCase = {
  id: 'product-recommendations-self-and-duplicate',
  type: 'product-recommendations',
  description:
    'Recommendations include the source product itself, a duplicate pick, and an out-of-candidate-list id.',
  input: { sourceProductId: 'prod-mug', candidateIds: ['prod-coaster', 'prod-teapot'] },
  output: [
    { productId: 'prod-mug', score: 0.9, reason: 'Self-reference bug' },
    { productId: 'prod-coaster', score: 0.8, reason: 'Complements the mug' },
    { productId: 'prod-coaster', score: 0.8, reason: 'Duplicate of the above' },
    { productId: 'prod-outside-catalog', score: 0.7, reason: 'Not a real candidate' },
  ],
  expectedFailedChecks: [
    'no-self-recommendation',
    'no-duplicate-recommendations',
    'ids-drawn-from-candidates',
  ],
};
