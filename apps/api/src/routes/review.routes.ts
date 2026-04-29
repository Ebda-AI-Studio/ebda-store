import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStore } from '../middleware/store';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { ReviewService } from '../services/review.service';
import { LoyaltyService } from '../services/loyalty.service';
import logger from '../lib/logger';

// `mergeParams: true` so the child router's handlers see `:storeId` from
// the parent mount path (`/stores/:storeId/reviews` in routes/index.ts).
// Without this, `req.params.storeId` is undefined inside every handler and
// `requireStore` returns 400 VALIDATION_ERROR — which is what the merchant
// saw when the storefront fetched /reviews/product/:productId.
const router = Router({ mergeParams: true });

// Validation schemas
const createReviewSchema = z.object({
  productId: z.string().uuid('Invalid product ID'),
  rating: z.number().int().min(1).max(5),
  title: z.string().max(200).optional(),
  comment: z.string().max(5000).optional(),
  orderId: z.string().uuid().optional(),
});

const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  title: z.string().max(200).optional(),
  comment: z.string().max(5000).optional(),
  isApproved: z.boolean().optional(),
});

// ==========================================
// Public Routes
// ==========================================

// GET /reviews/product/:productId - Get reviews for a product
router.get(
  '/product/:productId',
  requireStore,
  requireFeature('reviews'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { productId } = req.params;
      const { page, limit, sortBy } = req.query;

      const result = await ReviewService.listByProduct(req.storeId!, productId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        sortBy: sortBy as 'newest' | 'highest' | 'lowest' | 'helpful',
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
  requireFeature('reviews'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createReviewSchema.parse(req.body);
      const customerId = req.user!.userId;

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

// POST /reviews/:id/helpful - Mark review as helpful
router.post(
  '/:id/helpful',
  requireStore,
  requireFeature('reviews'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const review = await ReviewService.markHelpful(req.storeId!, id);

      res.json({
        success: true,
        data: { review },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /reviews/can-review/:productId - Check if customer can review
router.get(
  '/can-review/:productId',
  requireStore,
  authenticate,
  requireFeature('reviews'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { productId } = req.params;
      const result = await ReviewService.canReview(req.storeId!, productId, req.user!.userId);

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
      const reviews = await ReviewService.getCustomerReviews(req.storeId!, req.user!.userId);

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
      const { page, limit, status, productId } = req.query;

      const result = await ReviewService.listForStore(req.storeId!, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        status: status as 'pending' | 'approved' | 'all',
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updateReviewSchema.parse(req.body);

      const review = await ReviewService.update(req.storeId!, id, data);

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const review = await ReviewService.approve(req.storeId!, id);

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const review = await ReviewService.reject(req.storeId!, id);

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      await ReviewService.delete(req.storeId!, id);

      res.json({
        success: true,
        message: 'Review deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
