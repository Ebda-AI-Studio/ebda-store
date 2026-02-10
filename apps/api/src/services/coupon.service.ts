import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

interface CreateCouponData {
  code: string;
  name: string;
  nameAr?: string;
  description?: string;
  descriptionAr?: string;
  type: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
  minOrderAmount?: number;
  maxDiscount?: number;
  usageLimit?: number;
  usageLimitPerUser?: number;
  isActive?: boolean;
  startsAt?: Date;
  expiresAt?: Date;
}

type UpdateCouponData = Partial<CreateCouponData>;

interface ListCouponsOptions {
  page?: number;
  limit?: number;
  isActive?: boolean;
  search?: string;
}

export class CouponService {
  static async list(storeId: string, options: ListCouponsOptions = {}) {
    const { page = 1, limit = 20, isActive, search } = options;
    const skip = (page - 1) * limit;

    const where: Prisma.CouponWhereInput = { storeId };

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [coupons, total] = await Promise.all([
      prisma.coupon.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.coupon.count({ where }),
    ]);

    return {
      coupons,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getById(storeId: string, couponId: string) {
    const coupon = await prisma.coupon.findFirst({
      where: { id: couponId, storeId },
    });

    if (!coupon) {
      throw new AppError(404, 'NOT_FOUND', 'Coupon not found');
    }

    return coupon;
  }

  static async getByCode(storeId: string, code: string) {
    const coupon = await prisma.coupon.findFirst({
      where: {
        storeId,
        code: { equals: code, mode: 'insensitive' },
        isActive: true,
      },
    });

    if (!coupon) {
      throw new AppError(404, 'NOT_FOUND', 'Coupon not found or inactive');
    }

    // Check if coupon has started
    if (coupon.startsAt && new Date() < coupon.startsAt) {
      throw new AppError(400, 'COUPON_NOT_STARTED', 'Coupon is not yet active');
    }

    // Check if coupon has expired
    if (coupon.expiresAt && new Date() > coupon.expiresAt) {
      throw new AppError(400, 'COUPON_EXPIRED', 'Coupon has expired');
    }

    // Check usage limit
    if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
      throw new AppError(400, 'COUPON_LIMIT_REACHED', 'Coupon usage limit reached');
    }

    return coupon;
  }

  static async create(storeId: string, data: CreateCouponData) {
    // Check for duplicate code
    const existingCoupon = await prisma.coupon.findFirst({
      where: {
        storeId,
        code: { equals: data.code, mode: 'insensitive' },
      },
    });

    if (existingCoupon) {
      throw new AppError(409, 'DUPLICATE_CODE', 'A coupon with this code already exists');
    }

    const coupon = await prisma.coupon.create({
      data: {
        storeId,
        code: data.code.toUpperCase(),
        name: data.name,
        nameAr: data.nameAr,
        description: data.description,
        descriptionAr: data.descriptionAr,
        type: data.type,
        value: data.value,
        minOrderAmount: data.minOrderAmount,
        maxDiscount: data.maxDiscount,
        usageLimit: data.usageLimit,
        usageLimitPerUser: data.usageLimitPerUser,
        isActive: data.isActive ?? true,
        startsAt: data.startsAt,
        expiresAt: data.expiresAt,
      },
    });

    return coupon;
  }

  static async update(storeId: string, couponId: string, data: UpdateCouponData) {
    await this.getById(storeId, couponId);

    // Check for duplicate code if changing code
    if (data.code) {
      const existingCoupon = await prisma.coupon.findFirst({
        where: {
          storeId,
          code: { equals: data.code, mode: 'insensitive' },
          id: { not: couponId },
        },
      });

      if (existingCoupon) {
        throw new AppError(409, 'DUPLICATE_CODE', 'A coupon with this code already exists');
      }
    }

    const coupon = await prisma.coupon.update({
      where: { id: couponId, storeId },
      data: {
        code: data.code?.toUpperCase(),
        name: data.name,
        nameAr: data.nameAr,
        description: data.description,
        descriptionAr: data.descriptionAr,
        type: data.type,
        value: data.value,
        minOrderAmount: data.minOrderAmount,
        maxDiscount: data.maxDiscount,
        usageLimit: data.usageLimit,
        usageLimitPerUser: data.usageLimitPerUser,
        isActive: data.isActive,
        startsAt: data.startsAt,
        expiresAt: data.expiresAt,
      },
    });

    return coupon;
  }

  static async delete(storeId: string, couponId: string) {
    await this.getById(storeId, couponId);

    await prisma.coupon.delete({
      where: { id: couponId, storeId },
    });
  }

  static async toggleActive(storeId: string, couponId: string) {
    const coupon = await this.getById(storeId, couponId);

    const updatedCoupon = await prisma.coupon.update({
      where: { id: couponId, storeId },
      data: { isActive: !coupon.isActive },
    });

    return updatedCoupon;
  }

  static async incrementUsage(couponId: string) {
    await prisma.coupon.update({
      where: { id: couponId },
      data: { usageCount: { increment: 1 } },
    });
  }

  /**
   * Calculate discount for an order
   */
  static calculateDiscount(
    coupon: {
      type: string;
      value: number;
      maxDiscount: number | null;
    },
    orderTotal: number
  ): number {
    let discount = 0;

    if (coupon.type === 'percentage') {
      discount = Math.round((orderTotal * coupon.value) / 100);
      if (coupon.maxDiscount && discount > coupon.maxDiscount) {
        discount = coupon.maxDiscount;
      }
    } else if (coupon.type === 'fixed') {
      discount = coupon.value;
      if (discount > orderTotal) {
        discount = orderTotal;
      }
    }
    // free_shipping is handled separately

    return discount;
  }
}
