import { visibleProductWhere } from '../lib/visible-product';
import { Prisma } from '@ebda/database';
import { customersById, storeRwClient } from '../lib/jobs/store-db';
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
    const { db, onDo } = await storeRwClient(storeId);
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
          // B2B M4: a wholesale-only product answers like an unknown id (no reviews), so this is not an existence oracle.
          product: visibleProductWhere(),
          OR: [{ status: 'published' }, { customerId: viewerCustomerId }],
        }
      : {
          storeId,
          productId,
          product: visibleProductWhere(),
          status: 'published',
        };

    const [reviews, total, stats] = await Promise.all([
      db.review.findMany({
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
      db.review.count({ where }),
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
    const { db, onDo } = await storeRwClient(storeId);
    const where = { storeId, productId, status: 'published', product: visibleProductWhere() };

    const [aggregate, distribution] = await Promise.all([
      db.review.aggregate({
        where,
        _avg: { rating: true },
        _count: true,
      }),
      db.review.groupBy({
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
    const { db, onDo } = await storeRwClient(storeId);
    const { page = 1, limit = 20, status = 'all', productId } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.ReviewWhereInput = { storeId };
    if (status !== 'all') where.status = status;
    if (productId) where.productId = productId;

    const [firstPage, total] = await Promise.all([
      db.review.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          product: {
            select: { id: true, name: true, slug: true },
          },
          // Postgres joins the buyer; a store on its Durable Object cannot (the buyer is a platform row), so it is attached below
          ...(onDo
            ? {}
            : { customer: { select: { id: true, email: true, firstName: true, lastName: true } } }),
        },
      }),
      db.review.count({ where }),
    ]);

    let reviews = firstPage;
    if (onDo) {
      const buyers = await customersById(
        storeId,
        reviews.map(r => r.customerId)
      );
      reviews = reviews.map(r => {
        const u = r.customerId ? buyers.get(r.customerId) : undefined;
        return {
          ...r,
          customer: u
            ? { id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName }
            : null,
        };
      }) as typeof reviews;
    }

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
    const { db, onDo } = await storeRwClient(storeId);
    // Validate rating
    if (data.rating < 1 || data.rating > 5) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Rating must be between 1 and 5');
    }

    // Validate body
    if (!data.body || data.body.trim().length < 20) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Review body must be at least 20 characters');
    }

    // Check if product exists in this store
    const product = await db.product.findFirst({
      where: { id: data.productId, storeId },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // Verify order exists, belongs to this store/customer, and is delivered
    const order = await db.order.findFirst({
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
    const existingReview = await db.review.findFirst({
      where: { storeId, orderId: data.orderId, productId: data.productId },
    });

    if (existingReview) {
      throw new AppError(
        409,
        'ALREADY_EXISTS',
        'You have already reviewed this product for this order'
      );
    }

    const review = await db.review.create({
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
    const { db } = await storeRwClient(storeId);
    const review = await db.review.findFirst({
      where: { id: reviewId, storeId },
    });

    if (!review) {
      throw new AppError(404, 'NOT_FOUND', 'Review not found');
    }

    return db.review.update({
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
    const { db } = await storeRwClient(storeId);
    const review = await db.review.findFirst({
      where: { id: reviewId, storeId },
    });

    if (!review) {
      throw new AppError(404, 'NOT_FOUND', 'Review not found');
    }

    return db.review.update({
      where: { id: reviewId, storeId },
      data: { status: 'published' },
    });
  }

  /**
   * Reject a review (admin)
   */
  static async reject(storeId: string, reviewId: string, reason?: string) {
    const { db } = await storeRwClient(storeId);
    const review = await db.review.findFirst({
      where: { id: reviewId, storeId },
    });

    if (!review) {
      throw new AppError(404, 'NOT_FOUND', 'Review not found');
    }

    return db.review.update({
      where: { id: reviewId, storeId },
      data: { status: 'rejected', rejectionReason: reason },
    });
  }

  /**
   * Delete a review
   */
  static async delete(storeId: string, reviewId: string) {
    const { db } = await storeRwClient(storeId);
    const review = await db.review.findFirst({
      where: { id: reviewId, storeId },
    });

    if (!review) {
      throw new AppError(404, 'NOT_FOUND', 'Review not found');
    }

    await db.review.delete({
      where: { id: reviewId, storeId },
    });

    return { success: true };
  }

  /**
   * Get reviews by customer
   */
  static async getCustomerReviews(storeId: string, customerId: string) {
    const { db } = await storeRwClient(storeId);
    return db.review.findMany({
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
    const { db, onDo } = await storeRwClient(storeId);
    // Check if already reviewed (any status — prevent duplicate pending submissions)
    const existingReview = await db.review.findFirst({
      where: { storeId, productId, customerId },
    });

    if (existingReview) {
      return { canReview: false, reason: 'already_reviewed', existingReview };
    }

    // Require a delivered order for this product
    const purchase = await db.order.findFirst({
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
