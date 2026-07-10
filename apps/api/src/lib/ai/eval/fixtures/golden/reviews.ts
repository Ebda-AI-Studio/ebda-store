import type { GoldenCase } from '../types';

/** Golden fixtures: review-translation, review-spam-detection, review-summary, review-owner-response */
export const REVIEWS_GOLDEN: GoldenCase[] = [
  {
    id: 'review-translation-en-review',
    type: 'review-translation',
    input: { body: 'Great mug, exactly as described. Fast delivery too!', language: 'en' },
    output: { translated: 'كوب رائع، تمامًا كما هو موصوف. والتوصيل كان سريعًا أيضًا!' },
  },
  {
    id: 'review-spam-genuine-positive',
    type: 'review-spam-detection',
    input: {
      body: 'Love this mug, the glaze finish is beautiful and it fits my morning coffee perfectly.',
      rating: 5,
    },
    output: { spamScore: 0.05, reasons: [], recommendedStatus: 'published' },
  },
  {
    id: 'review-summary-mixed',
    type: 'review-summary',
    input: {
      reviews: [
        { rating: 5, body: 'Beautiful glaze, sturdy handle.' },
        { rating: 4, body: 'Great quality but arrived a bit late.' },
        { rating: 2, body: 'Chipped on arrival, packaging was thin.' },
      ],
    },
    output: {
      topPositives: ['Beautiful glaze finish', 'Sturdy handle'],
      topNegatives: ['Slow delivery', 'Fragile packaging'],
      overallSentiment: 'mixed',
    },
  },
  {
    id: 'review-owner-response-positive',
    type: 'review-owner-response',
    input: { storeName: 'Wady Aljuz', rating: 5, body: 'Love this mug, beautiful glaze!' },
    output: {
      en: "Thank you so much for the kind words — we're thrilled you love the mug! — Wady Aljuz",
      ar: 'شكرًا جزيلاً على كلماتك اللطيفة — يسعدنا أنك أعجبت بالكوب! — وادي الجوز',
    },
  },
];
