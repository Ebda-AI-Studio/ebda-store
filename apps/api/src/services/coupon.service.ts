import { assertCouponValue } from '../lib/sellable-price';
import { prisma, Prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { matchesTargeting, computeDiscount, TargetingCtx } from './promotion-targeting';

import { fromMinor, REGION, minorToDecimalString } from '@ebda/shared';
/** One coupon rule an admin order broke. `code` is the checkout error code. */
export interface CouponRuleViolation {
  code:
    | 'COUPON_NOT_STARTED'
    | 'COUPON_EXPIRED'
    | 'COUPON_LIMIT_REACHED'
    | 'MIN_ORDER_NOT_MET'
    | 'COUPON_NOT_ELIGIBLE'
    | 'COUPON_NEEDS_CONTACT';
  message: string;
}

type AdminCouponRow = {
  type: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
  maxDiscount: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  usageLimit: number | null;
  usageCount: number;
  customerGroupId: string | null;
  firstOrderOnly: boolean;
  minOrderAmount: number | null;
  minQuantity: number | null;
  scopeProductIds: string[];
  scopeCategoryIds: string[];
};

interface CreateCouponData {
  code: string;
  name: string;
  /** `null` clears the column; `undefined` leaves the stored value alone. */
  nameAr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
  type: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
  /**
   * `null` removes the restriction (no minimum / no cap / unlimited uses /
   * never expires); `undefined` leaves the stored value alone. Passed
   * straight to Prisma, same as nameAr/description above — Prisma omits an
   * `undefined` key from the write and writes an explicit `null` as NULL.
   */
  minOrderAmount?: number | null;
  maxDiscount?: number | null;
  usageLimit?: number | null;
  usageLimitPerUser?: number | null;
  isActive?: boolean;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  // Targeting — shared shape with Promotion (see PromotionService's
  // CreatePromotionData). All optional/empty = "everyone, whole cart" so
  // existing coupons are unchanged. Nullable (not just optional) since the
  // route's Zod schema uses `.nullish()` for these fields, matching
  // promotion.routes.ts's createSchema.
  customerGroupId?: string | null;
  firstOrderOnly?: boolean;
  minQuantity?: number | null;
  scopeProductIds?: string[];
  scopeCategoryIds?: string[];
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

    // QA-COUPON-1: a legacy percentage/fixed coupon saved with value 0 would be "accepted" and then charge full price.
    // Every public path (validate, quote, order) reads through here, so all of them refuse it the same way.
    if (coupon.type !== 'free_shipping' && typeof coupon.value === 'number' && coupon.value <= 0) {
      throw new AppError(400, 'COUPON_VALUE_REQUIRED', 'Coupon has no discount value');
    }

    return coupon;
  }

  static async create(storeId: string, data: CreateCouponData) {
    // QA-PRICE-ZERO-1: a coupon that discounts nothing (or everything) is refused at the door.
    assertCouponValue(data.type, data.value);
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
        customerGroupId: data.customerGroupId,
        firstOrderOnly: data.firstOrderOnly ?? false,
        minQuantity: data.minQuantity,
        scopeProductIds: data.scopeProductIds ?? [],
        scopeCategoryIds: data.scopeCategoryIds ?? [],
      },
    });

    return coupon;
  }

  static async update(storeId: string, couponId: string, data: UpdateCouponData) {
    const current = await this.getById(storeId, couponId);
    // QA-PRICE-ZERO-1: judge the type/value pair the row will HAVE after this update.
    if (data.type !== undefined || data.value !== undefined) {
      assertCouponValue(data.type ?? current.type, data.value ?? current.value);
    }

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
        customerGroupId: data.customerGroupId,
        firstOrderOnly: data.firstOrderOnly,
        minQuantity: data.minQuantity,
        scopeProductIds: data.scopeProductIds,
        scopeCategoryIds: data.scopeCategoryIds,
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

  static async incrementUsage(storeId: string, couponId: string) {
    await prisma.coupon.update({
      where: { id: couponId, storeId },
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

  /**
   * Every rule an admin/manual order breaks for this coupon, in the order the
   * checkout reports them: dates, store-wide usage limit, minimum order,
   * targeting (customer group, first order, min quantity, product/category
   * scope). The per-customer limit needs the order transaction and is
   * checked there. Pure — no DB access.
   *
   * Empty = the coupon applies exactly as it would at checkout.
   */
  static adminOrderCouponViolations(
    coupon: AdminCouponRow,
    ctx: TargetingCtx,
    subtotal: number,
    now: Date = new Date()
  ): CouponRuleViolation[] {
    const out: CouponRuleViolation[] = [];
    if (coupon.startsAt && now < coupon.startsAt) {
      out.push({ code: 'COUPON_NOT_STARTED', message: 'Coupon is not yet active' });
    }
    if (coupon.expiresAt && now > coupon.expiresAt) {
      out.push({ code: 'COUPON_EXPIRED', message: 'Coupon has expired' });
    }
    if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
      out.push({ code: 'COUPON_LIMIT_REACHED', message: 'Coupon usage limit reached' });
    }
    if (coupon.minOrderAmount && subtotal < coupon.minOrderAmount) {
      out.push({
        code: 'MIN_ORDER_NOT_MET',
        message: `Minimum order amount of ${minorToDecimalString(coupon.minOrderAmount)} ${REGION.currency} required for this coupon`,
      });
    }
    if (!CouponService.evaluateForCart(coupon, ctx).eligible) {
      out.push({
        code: 'COUPON_NOT_ELIGIBLE',
        message: 'This coupon does not apply to this order.',
      });
    }
    return out;
  }

  /**
   * The cart discount an admin/manual order gets from a coupon.
   *
   * Rules enforced (the default): exactly the checkout discount —
   * `evaluateForCart`, so a scoped coupon discounts only its in-scope lines.
   *
   * Rules overridden (ruling M-OVR-1): the eligibility gates (customer group,
   * first order, minimums, dates, usage limits) are ignored. A scoped coupon
   * still discounts only its in-scope lines when the order has any; when it
   * has none, the override applies it to the whole order — that is the scope
   * rule being overridden.
   *
   * `free_shipping` returns 0: its benefit is the shipping line.
   */
  static adminOrderCouponDiscount(
    coupon: AdminCouponRow,
    ctx: TargetingCtx,
    subtotal: number,
    override: boolean
  ): number {
    if (!override) return CouponService.evaluateForCart(coupon, ctx).discount;
    const scopeOnly = matchesTargeting(
      {
        customerGroupId: null,
        firstOrderOnly: false,
        minOrderAmount: null,
        minQuantity: null,
        scopeProductIds: coupon.scopeProductIds,
        scopeCategoryIds: coupon.scopeCategoryIds,
      },
      ctx
    );
    const base = scopeOnly.eligible ? scopeOnly.matchingSubtotal : subtotal;
    return computeDiscount(coupon.type, coupon.value, coupon.maxDiscount, base);
  }

  /**
   * Evaluate a coupon's targeting (customer group, first-order, min
   * qty/amount, product/category scope) against a resolved cart context and
   * compute the discount over the matching subtotal. Pure — no DB access.
   */
  static evaluateForCart(
    coupon: {
      type: 'percentage' | 'fixed' | 'free_shipping';
      value: number;
      maxDiscount: number | null;
      customerGroupId: string | null;
      firstOrderOnly: boolean;
      minOrderAmount: number | null;
      minQuantity: number | null;
      scopeProductIds: string[];
      scopeCategoryIds: string[];
    },
    ctx: TargetingCtx
  ): { eligible: boolean; discount: number; reason?: string } {
    const r = matchesTargeting(coupon, ctx);
    if (!r.eligible) return { eligible: false, discount: 0, reason: 'COUPON_NOT_ELIGIBLE' };
    const discount = computeDiscount(
      coupon.type,
      coupon.value,
      coupon.maxDiscount,
      r.matchingSubtotal
    );
    return { eligible: true, discount };
  }
}
