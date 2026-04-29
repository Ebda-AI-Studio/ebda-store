import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { socketService } from './socket.service';
import logger from '../lib/logger';

interface CreateReviewData {
  productId: string;
  rating: number;
  title?: string;
  comment?: string;
  orderId?: string;
}

interface UpdateReviewData {
  rating?: number;
  title?: string;
  comment?: string;
  isApproved?: boolean;
}

export class ReviewService {
  /**
   * List reviews for a product (public - only approved reviews)
   */
  static async listByProduct(
    storeId: string,
    productId: string,
    options: {
      page?: number;
      limit?: number;
      sortBy?: 'newest' | 'highest' | 'lowest' | 'helpful';
      /**
       * When set, the viewer's own un-approved reviews are included
       * alongside the public approved set. Lets the author see their
       * just-submitted review with a "pending approval" indicator
       * instead of an empty list ("لا توجد مراجعات بعد") that makes
       * them think their submission was lost.
       */
      viewerCustomerId?: string;
    } = {}
  ) {
    const { page = 1, limit = 10, sortBy = 'newest', viewerCustomerId } = options;
    const skip = (page - 1) * limit;

    const orderBy: Prisma.ReviewOrderByWithRelationInput = {
      newest: { createdAt: 'desc' as const },
      highest: { rating: 'desc' as const },
      lowest: { rating: 'asc' as const },
      helpful: { helpfulCount: 'desc' as const },
    }[sortBy];

    const where: Prisma.ReviewWhereInput = viewerCustomerId
      ? {
          storeId,
          productId,
          OR: [{ isApproved: true }, { customerId: viewerCustomerId }],
        }
      : {
          storeId,
          productId,
          isApproved: true,
        };

    const [reviews, total, stats] = await Promise.all([
      prisma.review.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        select: {
          id: true,
          rating: true,
          title: true,
          comment: true,
          isVerified: true,
          isApproved: true,
          helpfulCount: true,
          createdAt: true,
          customerId: true,
        },
      }),
      prisma.review.count({ where }),
      this.getProductReviewStats(storeId, productId),
    ]);

    // Anonymize customer names for public display. `isMine` flags the
    // viewer's own review so the storefront can show a "pending approval"
    // badge on it without exposing other customers' identities.
    const anonymizedReviews = reviews.map(review => ({
      ...review,
      customerName: review.customerId ? 'Verified Buyer' : 'Anonymous',
      isMine: viewerCustomerId ? review.customerId === viewerCustomerId : false,
      customerId: undefined,
    }));

    return {
      reviews: anonymizedReviews,
      stats,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get review statistics for a product
   */
  static async getProductReviewStats(storeId: string, productId: string) {
    const where = { storeId, productId, isApproved: true };

    const [aggregate, distribution] = await Promise.all([
      prisma.review.aggregate({
        where,
        _avg: { rating: true },
        _count: true,
      }),
      prisma.review.groupBy({
        by: ['rating'],
        where,
        _count: true,
      }),
    ]);

    const ratingDistribution = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };

    distribution.forEach(d => {
      ratingDistribution[d.rating as keyof typeof ratingDistribution] = d._count;
    });

    return {
      averageRating: Math.round((aggregate._avg.rating || 0) * 10) / 10,
      totalReviews: aggregate._count,
      ratingDistribution,
    };
  }

  /**
   * Admin: List all reviews for a store
   */
  static async listForStore(
    storeId: string,
    options: {
      page?: number;
      limit?: number;
      status?: 'pending' | 'approved' | 'all';
      productId?: string;
    } = {}
  ) {
    const { page = 1, limit = 20, status = 'all', productId } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ReviewWhereInput = { storeId };
    if (status === 'pending') where.isApproved = false;
    if (status === 'approved') where.isApproved = true;
    if (productId) where.productId = productId;

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          product: {
            select: { id: true, name: true, slug: true },
          },
          customer: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      }),
      prisma.review.count({ where }),
    ]);

    return {
      reviews,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Create a review
   */
  static async create(storeId: string, customerId: string | null, data: CreateReviewData) {
    // Validate rating
    if (data.rating < 1 || data.rating > 5) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Rating must be between 1 and 5');
    }

    // Check if product exists in this store
    const product = await prisma.product.findFirst({
      where: { id: data.productId, storeId },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // Check if customer has already reviewed this product
    if (customerId) {
      const existingReview = await prisma.review.findFirst({
        where: {
          storeId,
          productId: data.productId,
          customerId,
        },
      });

      if (existingReview) {
        throw new AppError(409, 'ALREADY_EXISTS', 'You have already reviewed this product');
      }
    }

    // Check if this is a verified purchase
    let isVerified = false;
    if (customerId && data.orderId) {
      const order = await prisma.order.findFirst({
        where: {
          id: data.orderId,
          storeId,
          customerId,
          status: 'delivered',
          items: { some: { productId: data.productId } },
        },
      });
      isVerified = !!order;
    } else if (customerId) {
      // Check if customer has purchased this product
      const purchase = await prisma.order.findFirst({
        where: {
          storeId,
          customerId,
          status: 'delivered',
          items: { some: { productId: data.productId } },
        },
      });
      isVerified = !!purchase;
    }

    const review = await prisma.review.create({
      data: {
        storeId,
        productId: data.productId,
        customerId,
        orderId: data.orderId,
        rating: data.rating,
        title: data.title,
        comment: data.comment,
        isVerified,
        isApproved: false, // Requires admin approval
      },
    });

    // Send real-time notification to store admins
    try {
      socketService.newReviewNotification(storeId, {
        productName: product.name,
        rating: data.rating,
        customerName: 'Customer', // Anonymized for privacy
      });
    } catch (notifyError) {
      logger.error({ err: notifyError }, 'Failed to send review notification');
    }

    return review;
  }

  /**
   * Update a review (admin)
   */
  static async update(storeId: string, reviewId: string, data: UpdateReviewData) {
    const review = await prisma.review.findFirst({
      where: { id: reviewId, storeId },
    });

    if (!review) {
      throw new AppError(404, 'NOT_FOUND', 'Review not found');
    }

    return prisma.review.update({
      where: { id: reviewId, storeId },
      data: {
        rating: data.rating,
        title: data.title,
        comment: data.comment,
        isApproved: data.isApproved,
      },
    });
  }

  /**
   * Approve a review
   */
  static async approve(storeId: string, reviewId: string) {
    const review = await prisma.review.findFirst({
      where: { id: reviewId, storeId },
    });

    if (!review) {
      throw new AppError(404, 'NOT_FOUND', 'Review not found');
    }

    return prisma.review.update({
      where: { id: reviewId, storeId },
      data: { isApproved: true },
    });
  }

  /**
   * Reject/unapprove a review
   */
  static async reject(storeId: string, reviewId: string) {
    const review = await prisma.review.findFirst({
      where: { id: reviewId, storeId },
    });

    if (!review) {
      throw new AppError(404, 'NOT_FOUND', 'Review not found');
    }

    return prisma.review.update({
      where: { id: reviewId, storeId },
      data: { isApproved: false },
    });
  }

  /**
   * Delete a review
   */
  static async delete(storeId: string, reviewId: string) {
    const review = await prisma.review.findFirst({
      where: { id: reviewId, storeId },
    });

    if (!review) {
      throw new AppError(404, 'NOT_FOUND', 'Review not found');
    }

    await prisma.review.delete({
      where: { id: reviewId, storeId },
    });

    return { success: true };
  }

  /**
   * Mark review as helpful (increment helpful count)
   */
  static async markHelpful(storeId: string, reviewId: string) {
    const review = await prisma.review.findFirst({
      where: { id: reviewId, storeId, isApproved: true },
    });

    if (!review) {
      throw new AppError(404, 'NOT_FOUND', 'Review not found');
    }

    return prisma.review.update({
      where: { id: reviewId, storeId },
      data: { helpfulCount: { increment: 1 } },
    });
  }

  /**
   * Get reviews by customer
   */
  static async getCustomerReviews(storeId: string, customerId: string) {
    return prisma.review.findMany({
      where: { storeId, customerId },
      take: 100,
      include: {
        product: {
          select: { id: true, name: true, slug: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Check if customer can review a product
   */
  static async canReview(storeId: string, productId: string, customerId: string) {
    // Check if already reviewed
    const existingReview = await prisma.review.findFirst({
      where: { storeId, productId, customerId },
    });

    if (existingReview) {
      return { canReview: false, reason: 'already_reviewed', existingReview };
    }

    // Check if customer has purchased the product
    const purchase = await prisma.order.findFirst({
      where: {
        storeId,
        customerId,
        status: 'delivered',
        items: { some: { productId } },
      },
    });

    return {
      canReview: true,
      isVerifiedPurchase: !!purchase,
    };
  }
}
