import type { KnownFailureCase } from '../types';

/** spamScore of 0.85 (clearly "spam" per the code's own 0.7 threshold) was mapped to "published" instead of "spam" — the exact kind of prompt/code mapping drift that would auto-publish spam. */
export const reviewSpamStatusMismatch: KnownFailureCase = {
  id: 'review-spam-status-mismatch',
  type: 'review-spam-detection',
  description:
    'spamScore=0.85 (>= the 0.7 "spam" threshold) but recommendedStatus is "published" — the status/score mapping is broken.',
  input: { body: 'BUY CHEAP WATCHES NOW!!! www.spam-link.example', rating: 5 },
  output: {
    spamScore: 0.85,
    reasons: ['promotional spam', 'off-topic link'],
    recommendedStatus: 'published',
  },
  expectedFailedChecks: ['status-matches-score-mapping'],
};
