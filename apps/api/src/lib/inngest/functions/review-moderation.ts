import type { InngestFunction } from 'inngest';
import { inngest } from '../client';
import { prisma } from '@force/database';
import { translateReview, detectSpamReview } from '../../ai/review-tools';
import logger from '../../logger';

/**
 * Auto-moderation for every submitted review.
 *
 * Fires on `review/submitted` (sent from the public review-submit route,
 * Task 28). Runs spam detection first — short-circuits translate if the
 * review is clearly junk so we don't burn tokens on spam.
 *
 * Status thresholds:
 *   spamScore < 0.3  → published (auto-approve, genuine review)
 *   0.3-0.7          → pending   (merchant manual review)
 *   > 0.7            → spam      (hidden from storefront)
 *
 * Translation failure is non-blocking: the review keeps its AI-derived
 * status even if the translation call errors out.
 *
 * Guard against Inngest sync UI test payloads (data: {}).
 */
export const reviewModeration: InngestFunction.Any = inngest.createFunction(
  {
    id: 'review-moderation',
    name: 'AI review moderation — translate + spam check',
    retries: 3,
    triggers: [{ event: 'review/submitted' }],
  },
  async ({ event, step }) => {
    const { reviewId, storeId } = event.data as { reviewId: string; storeId: string };

    if (!reviewId || !storeId) {
      logger.warn({ event: event.name }, '[REVIEW-MODERATION] fired without ids — skipping');
      return { skipped: 'missing-ids' };
    }

    // ── 1. Spam check — determines visibility ──────────────────────────────
    const spam = await step.run('detect-spam', () => detectSpamReview(reviewId));

    await step.run('persist-spam-result', () =>
      prisma.review.update({
        where: { id: reviewId },
        data: {
          spamScore: spam.spamScore,
          spamReasons: spam.reasons,
          status: spam.recommendedStatus,
        },
      })
    );

    // ── 2. Translate — only if not spam ────────────────────────────────────
    if (spam.recommendedStatus !== 'spam') {
      try {
        await step.run('translate', () => translateReview(reviewId));
      } catch (err) {
        // Non-blocking: review already has correct status; just log.
        logger.warn({ err, reviewId }, '[REVIEW-MODERATION] translate failed; continuing');
      }
    }

    logger.info(
      { reviewId, storeId, spamScore: spam.spamScore, status: spam.recommendedStatus },
      '[REVIEW-MODERATION] done'
    );

    return {
      reviewId,
      spamScore: spam.spamScore,
      status: spam.recommendedStatus,
    };
  }
);
