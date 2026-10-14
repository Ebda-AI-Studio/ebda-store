import { prisma, Prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { socketService } from './socket.service';
import logger from '../lib/logger';

interface CreateReviewData {
  productId: string;
  orderId: string; // required — verified-purchase only
  rating: number;
  title?: string;
  body?: string;
  language?: string;
}

interface UpdateReviewData {
  rating?: number;
  title?: string;
  body?: string;
  status?: string;
  rejectionReason?: string;
}

export class ReviewService {
  /**
   * List reviews for a product (public - only published reviews)
   */
  static async listByProduct(
    storeId: string,
    productId: string,
    options: {
      page?: number;
      limit?: number;
      sortBy?: 'newest' | 'highest' | 'lowest';
      /**
       * When set, the viewer's own pending reviews are included
       * alongside the public published set. Lets the author see their
       * just-submitted review with a "pending approval" indicator
       * instead of an empty list that makes them think it was lost.
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
    }[sortBy];

    const where: Prisma.ReviewWhereInput = viewerCustomerId
      ? {
          storeId,
          productId,
          OR: [{ status: 'published' }, { customerId: viewerCustomerId }],
        }
      : {
          storeId,
          productId,
          status: 'published',
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
          body: true,
          language: true,
          bodyTranslated: true,
          verifiedPurchase: true,
          status: true,
          ownerResponse: true,
          ownerResponseAr: true,
          ownerResponseAt: true,
          createdAt: true,
          customerId: true,
        },
      }),
      prisma.review.count({ where }),
      this.getProductReviewStats(storeId, productId),
    ]);

    // Anonymize customer names for public display. `isMine` flags the
    // viewer's own review so the storefront can show a "pending" badge.
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
    const where = { storeId, productId, status: 'published' };

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
      status?: 'pending' | 'published' | 'rejected' | 'spam' | 'all';
      productId?: string;
    } = {}
  ) {
    const { page = 1, limit = 20, status = 'all', productId } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ReviewWhereInput = { storeId };
    if (status !== 'all') where.status = status;
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
   * Create a review (verified-purchase only — requires a valid orderId)
   */
  static async create(storeId: string, customerId: string | null, data: CreateReviewData) {
    // Validate rating
    if (data.rating < 1 || data.rating > 5) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Rating must be between 1 and 5');
    }

    // Validate body
    if (!data.body || data.body.trim().length < 20) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Review body must be at least 20 characters');
    }

    // Check if product exists in this store
    const product = await prisma.product.findFirst({
      where: { id: data.productId, storeId },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // Verify order exists, belongs to this store/customer, and is delivered
    const order = await prisma.order.findFirst({
      where: {
        id: data.orderId,
        storeId,
        ...(customerId ? { customerId } : {}),
        status: 'delivered',
        items: { some: { productId: data.productId } },
      },
    });

    if (!order) {
      throw new AppError(403, 'FORBIDDEN', 'Review requires a delivered order for this product');
    }

    // Enforce unique (orderId, productId) — one review per buyer-product pair
    const existingReview = await prisma.review.findFirst({
      where: { storeId, orderId: data.orderId, productId: data.productId },
    });

    if (existingReview) {
      throw new AppError(
        409,
        'ALREADY_EXISTS',
        'You have already reviewed this product for this order'
      );
    }

    const review = await prisma.review.create({
      data: {
        storeId,
        productId: data.productId,
        orderId: data.orderId,
        customerId,
        rating: data.rating,
        title: data.title,
        body: data.body.trim(),
        language: data.language ?? 'en',
        verifiedPurchase: true, // always true — enforced by order check above
        status: 'pending', // awaits moderation
      },
    });

    // Send real-time notification to store admins
    try {
      socketService.newReviewNotification(storeId, {
        reviewId: review.id,
        productName: product.name,
        rating: data.rating,
        customerName: 'Customer',
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
        body: data.body,
        status: data.status,
        rejectionReason: data.rejectionReason,
      },
    });
  }

  /**
   * Publish a review (admin approval)
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
      data: { status: 'published' },
    });
  }

  /**
   * Reject a review (admin)
   */
  static async reject(storeId: string, reviewId: string, reason?: string) {
    const review = await prisma.review.findFirst({
      where: { id: reviewId, storeId },
    });

    if (!review) {
      throw new AppError(404, 'NOT_FOUND', 'Review not found');
    }

    return prisma.review.update({
      where: { id: reviewId, storeId },
      data: { status: 'rejected', rejectionReason: reason },
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
   * Check if customer can review a product (verified-purchase check)
   */
  static async canReview(storeId: string, productId: string, customerId: string) {
    // Check if already reviewed (any status — prevent duplicate pending submissions)
    const existingReview = await prisma.review.findFirst({
      where: { storeId, productId, customerId },
    });

    if (existingReview) {
      return { canReview: false, reason: 'already_reviewed', existingReview };
    }

    // Require a delivered order for this product
    const purchase = await prisma.order.findFirst({
      where: {
        storeId,
        customerId,
        status: 'delivered',
        items: { some: { productId } },
      },
    });

    if (!purchase) {
      return { canReview: false, reason: 'not_purchased' };
    }

    return {
      canReview: true,
      isVerifiedPurchase: true,
      orderId: purchase.id,
    };
  }
}
