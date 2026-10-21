import { GeminiFailoverClient } from './gemini-keys';
import { prisma, currentStoreId } from '@ebda/database';
import { config } from '../../config';
import logger from '../logger';
import { assertAiQuota } from '../ai-quota';
import { rethrowAsAppError } from './gemini-errors';
import { EGYPTIAN_ARABIC_REGISTER } from './arabic-register';

async function throttle() {
  const ms = parseInt(process.env.AI_BULK_THROTTLE_MS || '2500', 10);
  await new Promise(r => setTimeout(r, ms));
}

function getModel() {
  if (!config.googleAiKey) {
    throw new Error('AI_NOT_CONFIGURED: GOOGLE_GENERATIVE_AI_KEY missing');
  }
  const genAI = new GeminiFailoverClient();
  const modelName = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  return genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: 'application/json' },
  });
}

function stripFences(text: string): string {
  let s = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Extract the outermost JSON span. Gemini occasionally appends explanatory
  // text after a valid JSON body even when prompted for pure JSON. Slice
  // from the first `{` or `[` to the last `}` or `]`. See bulk-ai-aeo.ts
  // for full rationale (2026-05-25 fix after Mastic + caraway products
  // failed AEO meta sweep with "Unexpected non-whitespace character after
  // JSON at position 331").
  const firstOpen = s.search(/[\{\[]/);
  if (firstOpen > 0) s = s.slice(firstOpen);

  const lastClose = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (lastClose !== -1 && lastClose < s.length - 1) {
    s = s.slice(0, lastClose + 1);
  }

  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. TRANSLATE — auto on submit. en review → ar; ar review → en.
//    Smart-skips if bodyTranslated is already set.
// ─────────────────────────────────────────────────────────────────────────────
export async function translateReview(reviewId: string): Promise<void> {
  const review = await prisma.review.findUnique({
    where: { id: reviewId, storeId: currentStoreId() },
    select: { id: true, storeId: true, body: true, language: true, bodyTranslated: true },
  });
  if (!review) {
    logger.warn({ reviewId }, '[REVIEW-TOOLS] translateReview: review not found');
    return;
  }
  if (review.bodyTranslated) {
    logger.info({ reviewId }, '[REVIEW-TOOLS] translateReview: already translated, skipping');
    return;
  }

  const target = review.language === 'ar' ? 'English' : 'Arabic';
  const prompt = `Translate the following customer product review to ${target}. Preserve the tone (positive/negative/neutral) and personal voice. Do not soften criticism. Return JSON: { "translated": "..." }.

Review:
${review.body}`;

  await assertAiQuota({ storeId: review.storeId });
  await throttle();

  let result;
  try {
    result = await getModel().generateContent(prompt);
  } catch (err) {
    rethrowAsAppError(err, 'AI review translation failed');
  }
  const parsed = JSON.parse(stripFences(result.response.text())) as { translated: string };

  await prisma.review.update({
    where: { id: reviewId, storeId: review.storeId },
    data: { bodyTranslated: parsed.translated, bodyTranslatedAt: new Date() },
  });

  logger.info({ reviewId, target }, '[REVIEW-TOOLS] translateReview: done');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SPAM DETECTION — auto on submit.
//    Score 0-1: >0.7 = spam, 0.3-0.7 = pending, <0.3 = auto-publish.
// ─────────────────────────────────────────────────────────────────────────────
export interface SpamCheckResult {
  spamScore: number;
  reasons: string[];
  recommendedStatus: 'published' | 'pending' | 'spam';
}

export async function detectSpamReview(reviewId: string): Promise<SpamCheckResult> {
  const review = await prisma.review.findUnique({
    where: { id: reviewId, storeId: currentStoreId() },
    select: { storeId: true, body: true, title: true, rating: true, language: true },
  });
  if (!review) {
    logger.warn({ reviewId }, '[REVIEW-TOOLS] detectSpamReview: review not found');
    return { spamScore: 0, reasons: [], recommendedStatus: 'pending' };
  }

  const prompt = `You are a fraud detector for product reviews on an Egypt e-commerce platform. Analyze this review for spam, fakeness, profanity, or off-topic content.

Score 0.0-1.0:
- 0.0-0.2: clearly genuine
- 0.2-0.5: likely genuine, minor concerns
- 0.5-0.8: suspicious (very short, generic, mismatched language, marketing speak)
- 0.8-1.0: clearly spam/fake/abusive

Reasons to flag: profanity, hate speech, off-topic content (not about the product), competitor mentions, marketing/promotional spam, copy-paste from other sites, single-word reviews, all-caps abuse, rating-comment mismatch (e.g. 5 stars with negative text).

Return JSON: { "spamScore": number, "reasons": string[] }

Review:
title: ${review.title ?? '(none)'}
rating: ${review.rating}/5
language: ${review.language}
body: ${review.body}`;

  await assertAiQuota({ storeId: review.storeId });
  await throttle();

  let result;
  try {
    result = await getModel().generateContent(prompt);
  } catch (err) {
    rethrowAsAppError(err, 'AI review spam detection failed');
  }
  const parsed = JSON.parse(stripFences(result.response.text())) as {
    spamScore: number;
    reasons: string[];
  };

  const score = Math.max(0, Math.min(1, parsed.spamScore || 0));
  const recommendedStatus: SpamCheckResult['recommendedStatus'] =
    score >= 0.7 ? 'spam' : score >= 0.3 ? 'pending' : 'published';

  logger.info({ reviewId, score, recommendedStatus }, '[REVIEW-TOOLS] detectSpamReview: done');
  return { spamScore: score, reasons: parsed.reasons || [], recommendedStatus };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. SUMMARIZE — merchant dashboard button.
//    Returns top positives + top negatives + sentiment from up to 100 reviews.
// ─────────────────────────────────────────────────────────────────────────────
export interface ReviewSummary {
  topPositives: string[];
  topNegatives: string[];
  overallSentiment: 'positive' | 'mixed' | 'negative';
  reviewCount: number;
}

export async function summarizeProductReviews(
  storeId: string,
  productId: string
): Promise<ReviewSummary> {
  // storeId is load-bearing: productId arrives as a route param and product
  // ids are public on the storefront, so without it any store_admin could
  // summarise a competitor's reviews and read their exact verified-purchase
  // count. ReviewService's own CRUD is store-scoped; only these AI helpers
  // were not.
  const reviews = await prisma.review.findMany({
    // storeId in the WHERE is the cross-tenant fix (a product id is public, so
    // without it any store_admin could summarise a competitor's reviews);
    // storeId in the SELECT is what main added for per-store AI accounting.
    // Both are wanted — they solve different problems.
    where: { storeId, productId, status: 'published', verifiedPurchase: true },
    select: { storeId: true, rating: true, body: true, language: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  if (reviews.length === 0) {
    return { topPositives: [], topNegatives: [], overallSentiment: 'mixed', reviewCount: 0 };
  }

  const reviewsText = reviews.map((r, i) => `[${i + 1}] (${r.rating}⭐) ${r.body}`).join('\n');

  const prompt = `Analyze these ${reviews.length} customer reviews for a single product. Identify recurring themes — top 3 positive aspects customers mention, top 3 negative aspects, and the overall sentiment.

Return JSON: { "topPositives": [string], "topNegatives": [string], "overallSentiment": "positive" | "mixed" | "negative" }

Each theme should be a short phrase (3-7 words) summarizing what multiple reviewers mention. Use English regardless of the review language.

Reviews:
${reviewsText}`;

  await assertAiQuota({ storeId: reviews[0].storeId });
  await throttle();

  let result;
  try {
    result = await getModel().generateContent(prompt);
  } catch (err) {
    rethrowAsAppError(err, 'AI review summarization failed');
  }
  const parsed = JSON.parse(stripFences(result.response.text())) as Omit<
    ReviewSummary,
    'reviewCount'
  >;

  logger.info(
    { productId, reviewCount: reviews.length, sentiment: parsed.overallSentiment },
    '[REVIEW-TOOLS] summarizeProductReviews: done'
  );
  return { ...parsed, reviewCount: reviews.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. DRAFT OWNER RESPONSE — merchant dashboard button.
//    Drafts a bilingual reply (en + ar). Merchant edits + approves before save.
// ─────────────────────────────────────────────────────────────────────────────
export interface OwnerResponseDraft {
  en: string;
  ar: string;
}

export async function draftOwnerResponse(
  storeId: string,
  reviewId: string
): Promise<OwnerResponseDraft> {
  const review = await prisma.review.findFirst({
    where: { id: reviewId, storeId },
    select: {
      id: true,
      storeId: true,
      rating: true,
      title: true,
      body: true,
      language: true,
      store: { select: { name: true, nameAr: true } },
      product: { select: { name: true, nameAr: true } },
    },
  });
  if (!review) throw new Error(`Review ${reviewId} not found`);

  const prompt = `You are helping an Egypt merchant draft a professional, warm response to a customer's product review. Match the tone (positive review → thank them genuinely; negative → empathize + offer to make it right). Keep responses concise (1-3 sentences).

Write BOTH versions in JSON: { "en": "...", "ar": "..." }
- en: English
- ar: ${EGYPTIAN_ARABIC_REGISTER}

Sign off with the store name, no other branding.

Store: ${review.store.name}${review.store.nameAr ? ` (${review.store.nameAr})` : ''}
Product: ${review.product.name}${review.product.nameAr ? ` (${review.product.nameAr})` : ''}
Review:
- rating: ${review.rating}/5
- title: ${review.title ?? '(none)'}
- body: ${review.body}`;

  await assertAiQuota({ storeId: review.storeId });
  await throttle();

  let result;
  try {
    result = await getModel().generateContent(prompt);
  } catch (err) {
    rethrowAsAppError(err, 'AI owner response draft failed');
  }
  const parsed = JSON.parse(stripFences(result.response.text())) as OwnerResponseDraft;

  logger.info({ reviewId }, '[REVIEW-TOOLS] draftOwnerResponse: done');
  return parsed;
}
