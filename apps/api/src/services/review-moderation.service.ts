/**
 * Moderating a review (approve / reject / send back) with its side effects: the PDP rating caches and the review bonus points.
 * One home for the effects so the admin routes (review.routes.ts) and the Ebda assistant (smart-layer/tools/customers.tools.ts)
 * cannot drift. The route still writes the audit row; the assistant's audit row is written by `runAsMerchant`.
 */
import { ReviewService } from './review.service';
import { LoyaltyService } from './loyalty.service';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import logger from '../lib/logger';

/**
 * The PDP rating line (Phase B3, Ruling B3-6) reads `ratingStats` off the cached public product
 * payload (`public:product:<store>:<slug>`, 120 s, plus the 60 s edge copy). CACHE CLASS:
 * BOUNDED-stale. Moderation (approve / reject / delete) changes the published set, so it busts the
 * product caches now instead of waiting the TTL out; a failed purge never fails the moderation
 * (the TTL is the residual window, about 8 minutes with the edge copy).
 */
export async function refreshRatingCaches(storeId: string): Promise<void> {
  try {
    await invalidateStoreProductCaches(storeId);
  } catch (err) {
    logger.warn({ err, storeId }, '[ReviewRoutes] rating cache purge failed after moderation');
  }
}

export type ReviewStatus = 'pending' | 'published' | 'rejected' | 'spam';

/** Sets a review's status the way the admin Approve / Reject buttons do (published = approve, rejected = reject). Returns the updated review. */
export async function moderateReview(storeId: string, reviewId: string, status: ReviewStatus) {
  let review;
  if (status === 'published') review = await ReviewService.approve(storeId, reviewId);
  else if (status === 'rejected') review = await ReviewService.reject(storeId, reviewId);
  else review = await ReviewService.update(storeId, reviewId, { status });
  await refreshRatingCaches(storeId);
  // Award review bonus points if the review has a customer (idempotent per review)
  if (status === 'published' && review.customerId) {
    try {
      await LoyaltyService.awardReviewBonus(storeId, review.customerId, review.productId, reviewId);
    } catch (err) {
      // Non-fatal: log and continue
      logger.warn({ err, reviewId }, '[ReviewRoutes] Failed to award review bonus points');
    }
  }
  return review;
}
