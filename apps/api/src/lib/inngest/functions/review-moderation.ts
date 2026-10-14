import type { InngestFunction } from 'inngest';
import { inngest } from '../client';
import { prisma, runInTenantContext } from '@ebda/database';
import { translateReview, detectSpamReview } from '../../ai/review-tools';
import logger from '../../logger';
import { featureService } from '../../../services/feature.service';

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

    // Feature gate — skip AI moderation when reviews feature is disabled.
    const reviewsEnabled = await featureService.isFeatureEnabled(storeId, 'reviews');
    if (!reviewsEnabled) {
      logger.info({ storeId, reviewId }, '[REVIEW-MODERATION] reviews feature disabled, skipping');
      return { skipped: true, reason: 'feature_disabled', feature: 'reviews' };
    }

    // ── 1. Spam check — determines visibility ──────────────────────────────
    // detectSpamReview uses bare prisma internally. Wrap in runInTenantContext
    // so FORCE RLS sees the correct store GUC and the Review row is visible.
    const spam = await step.run('detect-spam', () =>
      runInTenantContext(storeId, () => detectSpamReview(reviewId))
    );

    // persist-spam-result also needs the tenant context — Review is an RLS table.
    await step.run('persist-spam-result', () =>
      runInTenantContext(storeId, () =>
        prisma.review.update({
          where: { id: reviewId, storeId },
          data: {
            spamScore: spam.spamScore,
            spamReasons: spam.reasons,
            status: spam.recommendedStatus,
          },
        })
      )
    );

    // ── 2. Translate — only if not spam ────────────────────────────────────
    if (spam.recommendedStatus !== 'spam') {
      try {
        // translateReview uses bare prisma — wrap for the same reason.
        await step.run('translate', () =>
          runInTenantContext(storeId, () => translateReview(reviewId))
        );
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
