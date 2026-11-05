import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { storeWriter } from '../../repo-factory';
import { runInStoreCtx } from '../../jobs/store-db';
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
 * Status thresholds (lib/ai/review-moderation-policy.ts, SEC-2):
 *   spamScore < 0.3  → published (auto-approve, genuine review)
 *   0.3-0.7          → pending   (merchant manual review)
 *   > 0.7            → spam      (hidden from storefront)
 *   no finite score  → pending   (FAIL CLOSED: missing / null / NaN / unparseable reply)
 *   link, phone, profanity or text addressed to the moderator → never published,
 *                                  whatever the model scored (deterministic pre-filter)
 *
 * Translation failure is non-blocking: the review keeps its AI-derived
 * status even if the translation call errors out.
 *
 * Guard against Inngest sync UI test payloads (data: {}).
 */
export const reviewModeration: JobDef = inngest.createFunction(
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
    // In a step: on a Workflow only step bodies hold a database connection.
    const reviewsEnabled = await step.run('check-feature', () =>
      featureService.isFeatureEnabled(storeId, 'reviews')
    );
    if (!reviewsEnabled) {
      logger.info({ storeId, reviewId }, '[REVIEW-MODERATION] reviews feature disabled, skipping');
      return { skipped: true, reason: 'feature_disabled', feature: 'reviews' };
    }

    // ── 1. Spam check — determines visibility ──────────────────────────────
    // detectSpamReview reads the review through storeDb (the DO, or Postgres under the
    // tenant scope that runInStoreCtx opens so FORCE RLS sees the store GUC).
    const spam = await step.run('detect-spam', () =>
      runInStoreCtx(storeId, () => detectSpamReview(reviewId))
    );

    // persist-spam-result goes through storeWriter (the DO, or the Postgres tenant scope).
    await step.run('persist-spam-result', () =>
      runInStoreCtx(storeId, async () =>
        (await storeWriter(storeId)).review.update({
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
        // translateReview reads and writes through storeDb / storeWriter — same scope.
        await step.run('translate', () => runInStoreCtx(storeId, () => translateReview(reviewId)));
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
