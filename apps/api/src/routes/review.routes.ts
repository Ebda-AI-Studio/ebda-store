import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize, optionalAuthenticate, customerUserId } from '../middleware/auth';
import { requireCustomerStoreMatch } from '../middleware/customer-store-match';
import { requireStore } from '../middleware/store';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { ReviewService } from '../services/review.service';
import { LoyaltyService } from '../services/loyalty.service';
import logger from '../lib/logger';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import { prisma } from '@ebda/database';
import { auditLog, writeLimiter } from '../middleware/security';
import { draftOwnerResponse, summarizeProductReviews } from '../lib/ai/review-tools';
import { requireAiEnabled } from '../lib/store-ai-switch';
import { assertScalarQuery } from '../lib/query-params';

// `mergeParams: true` so the child router's handlers see `:storeId` from
// the parent mount path (`/stores/:storeId/reviews` in routes/index.ts).
// Without this, `req.params.storeId` is undefined inside every handler and
// `requireStore` returns 400 VALIDATION_ERROR — which is what the merchant
// saw when the storefront fetched /reviews/product/:productId.
const router = Router({ mergeParams: true });

/**
 * The PDP rating line (Phase B3, Ruling B3-6) reads `ratingStats` off the cached public product
 * payload (`public:product:<store>:<slug>`, 120 s, plus the 60 s edge copy). CACHE CLASS:
 * BOUNDED-stale. Moderation (approve / reject / delete) changes the published set, so it busts the
 * product caches now instead of waiting the TTL out; a failed purge never fails the moderation
 * (the TTL is the residual window, about 8 minutes with the edge copy).
 */
async function refreshRatingCaches(storeId: string): Promise<void> {
  try {
    await invalidateStoreProductCaches(storeId);
  } catch (err) {
    logger.warn({ err, storeId }, '[ReviewRoutes] rating cache purge failed after moderation');
  }
}

// Validation schemas
const createReviewSchema = z.object({
  productId: z.string().uuid('Invalid product ID'),
  orderId: z.string().uuid('Invalid order ID'),
  rating: z.number().int().min(1).max(5),
  title: z.string().max(200).optional(),
  body: z.string().min(20, 'Review body must be at least 20 characters').max(5000),
  language: z.enum(['en', 'ar']).optional(),
});

const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  title: z.string().max(200).optional(),
  body: z.string().max(5000).optional(),
  status: z.enum(['pending', 'published', 'rejected', 'spam']).optional(),
  rejectionReason: z.string().max(500).optional(),
});

// ==========================================
// Public Routes
// ==========================================

// GET /reviews/product/:productId - Get reviews for a product.
// `optionalAuthenticate` lets us identify the viewer without requiring
// auth — when set, the service includes the viewer's own pending
// reviews so a freshly-submitted review is visible to its author with
// a "pending approval" indicator instead of silently disappearing.
router.get(
  '/product/:productId',
  requireStore,
  optionalAuthenticate,
  requireFeature('reviews'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { productId } = req.params;
      assertScalarQuery(req.query, ['page', 'limit', 'sortBy']);
      const { page, limit, sortBy } = req.query;

      const result = await ReviewService.listByProduct(req.storeId!, productId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        sortBy: sortBy as 'newest' | 'highest' | 'lowest',
        // customerUserId() ensures we only attach a viewer ID for actual
        // customer sessions. An admin browsing the storefront would
        // otherwise see "your pending review" markers keyed on their
        // own userId, which is misleading.
        viewerCustomerId: customerUserId(req),
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /reviews/product/:productId/stats - Get review stats for a product
router.get(
  '/product/:productId/stats',
  requireStore,
  requireFeature('reviews'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { productId } = req.params;
      const stats = await ReviewService.getProductReviewStats(req.storeId!, productId);

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /reviews - Create a review (requires authentication)
router.post(
  '/',
  requireStore,
  authenticate,
  requireCustomerStoreMatch,
  requireFeature('reviews'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createReviewSchema.parse(req.body);
      const customerId = customerUserId(req);
      if (!customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Customer account required' },
        });
        return;
      }

      const review = await ReviewService.create(req.storeId!, customerId, data);

      res.status(201).json({
        success: true,
        data: { review },
        message: 'Review submitted successfully. It will be visible after approval.',
      });
    } catch (error) {
      next(error);
    }
  }
);

// (helpful endpoint removed — helpfulCount was removed from the new review schema)

// GET /reviews/can-review/:productId - Check if customer can review
router.get(
  '/can-review/:productId',
  requireStore,
  authenticate,
  requireFeature('reviews'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { productId } = req.params;
      const customerId = customerUserId(req);
      if (!customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Customer account required' },
        });
        return;
      }
      const result = await ReviewService.canReview(req.storeId!, productId, customerId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /reviews/my-reviews - Get customer's reviews
router.get(
  '/my-reviews',
  requireStore,
  authenticate,
  requireFeature('reviews'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = customerUserId(req);
      if (!customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Customer account required' },
        });
        return;
      }
      const reviews = await ReviewService.getCustomerReviews(req.storeId!, customerId);

      res.json({
        success: true,
        data: { reviews },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Admin Routes
// ==========================================

// GET /reviews/admin - List all reviews for store (admin)
router.get(
  '/admin',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStore,
  requireStoreAccess,
  requireFeature('reviews'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Scalars only: `status`/`productId` go into a Prisma where (an object would be an operator).
      assertScalarQuery(req.query, ['page', 'limit', 'status', 'productId']);
      const { page, limit, status, productId } = req.query;

      const result = await ReviewService.listForStore(req.storeId!, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        status: status as 'pending' | 'published' | 'rejected' | 'spam' | 'all',
        productId: productId as string,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /reviews/admin/:id - Update review (admin)
router.put(
  '/admin/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStore,
  requireStoreAccess,
  requireFeature('reviews'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updateReviewSchema.parse(req.body);

      const review = await ReviewService.update(req.storeId!, id, data);
      if (data.status !== undefined || data.rating !== undefined)
        await refreshRatingCaches(req.storeId!);

      res.json({
        success: true,
        data: { review },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /reviews/admin/:id/approve - Approve review
router.post(
  '/admin/:id/approve',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStore,
  requireStoreAccess,
  requireFeature('reviews'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const review = await ReviewService.approve(req.storeId!, id);
      await refreshRatingCaches(req.storeId!);

      await auditLog({
        action: 'review.approved',
        userId: req.user!.userId,
        storeId: req.storeId!,
        resourceType: 'review',
        resourceId: id,
        details: { productId: review.productId, customerId: review.customerId },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Award review bonus points if the review has a customer
      if (review.customerId) {
        try {
          await LoyaltyService.awardReviewBonus(
            req.storeId!,
            review.customerId,
            review.productId,
            id
          );
        } catch (err) {
          // Non-fatal: log and continue
          logger.warn({ err, reviewId: id }, '[ReviewRoutes] Failed to award review bonus points');
        }
      }

      res.json({
        success: true,
        data: { review },
        message: 'Review approved successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /reviews/admin/:id/reject - Reject review
router.post(
  '/admin/:id/reject',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStore,
  requireStoreAccess,
  requireFeature('reviews'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const review = await ReviewService.reject(req.storeId!, id);
      await refreshRatingCaches(req.storeId!);

      await auditLog({
        action: 'review.rejected',
        userId: req.user!.userId,
        storeId: req.storeId!,
        resourceType: 'review',
        resourceId: id,
        details: { productId: review.productId, customerId: review.customerId },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { review },
        message: 'Review rejected',
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /reviews/admin/:id - Delete review
router.delete(
  '/admin/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStore,
  requireStoreAccess,
  requireFeature('reviews'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      await ReviewService.delete(req.storeId!, id);
      await refreshRatingCaches(req.storeId!);

      res.json({
        success: true,
        message: 'Review deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// AI Endpoints (admin only)
// ==========================================

// POST /reviews/admin/:id/draft-response
// Calls Gemini to draft a bilingual owner response. Merchant edits +
// approves before the result is persisted via PUT /admin/:id.
router.post(
  '/admin/:id/draft-response',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStore,
  requireStoreAccess,
  requireFeature('reviews'),
  requireAiEnabled,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const draft = await draftOwnerResponse(req.storeId!, id);
      res.json({ success: true, data: draft });
    } catch (error) {
      next(error);
    }
  }
);

// POST /reviews/admin/products/:productId/summary
// Summarises up to 100 published verified reviews for a product.
// Returns topPositives, topNegatives, overallSentiment, reviewCount.
router.post(
  '/admin/products/:productId/summary',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStore,
  requireStoreAccess,
  requireFeature('reviews'),
  requireAiEnabled,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { productId } = req.params;
      const summary = await summarizeProductReviews(req.storeId!, productId);
      res.json({ success: true, data: summary });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /reviews/admin/:id/owner-response
// Persists the merchant-approved bilingual owner response.
const ownerResponseSchema = z.object({
  ownerResponse: z.string().max(2000).optional(),
  ownerResponseAr: z.string().max(2000).optional(),
});

router.put(
  '/admin/:id/owner-response',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStore,
  requireStoreAccess,
  requireFeature('reviews'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = ownerResponseSchema.parse(req.body);
      // Direct prisma update — ReviewService.update doesn't expose owner
      // response fields (those are merchant-managed, not moderation fields).
      const review = await prisma.review.update({
        where: { id, storeId: req.storeId! },
        data: {
          ownerResponse: data.ownerResponse,
          ownerResponseAr: data.ownerResponseAr,
          ownerResponseAt: data.ownerResponse || data.ownerResponseAr ? new Date() : undefined,
        },
      });
      res.json({ success: true, data: { review } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
