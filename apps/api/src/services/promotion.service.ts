/**
 * Automatic promotion CRUD — mirrors CouponService's shape minus code/usage
 * tracking (promotions apply automatically, there's no code to redeem), plus
 * the targeting fields (customer group, order minimums, product/category
 * scope) shared with coupons. Eligibility evaluation lives in the shared
 * targeting evaluator (Task 2), not here — this is persistence only.
 */
import { prisma } from '@ebda/database';
import { assertCustomerGroupInStore } from '../lib/customer-group-scope';
import { AppError } from '../middleware/error-handler';
import { searchNameIds } from './product-search.service';

interface CreatePromotionData {
  name: string;
  nameAr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
  type: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
  maxDiscount?: number | null;
  priority?: number;
  isActive?: boolean;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  customerGroupId?: string | null;
  firstOrderOnly?: boolean;
  minOrderAmount?: number | null;
  minQuantity?: number | null;
  scopeProductIds?: string[];
  scopeCategoryIds?: string[];
}

type UpdatePromotionData = Partial<CreatePromotionData>;

interface ListPromotionsOptions {
  page?: number;
  limit?: number;
  isActive?: boolean;
  search?: string;
}

export class PromotionService {
  static async list(storeId: string, options: ListPromotionsOptions = {}) {
    const { page = 1, limit = 20, isActive, search } = options;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { storeId };

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (search) {
      // Arabic-normalised name + nameAr word-AND (product-search.service searchNameIds).
      where.id = { in: await searchNameIds('promotions', storeId, search) };
    }

    const [promotions, total] = await Promise.all([
      prisma.promotion.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.promotion.count({ where }),
    ]);

    return {
      promotions,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getById(storeId: string, promotionId: string) {
    const promotion = await prisma.promotion.findFirst({
      where: { id: promotionId, storeId },
    });

    if (!promotion) {
      throw new AppError(404, 'NOT_FOUND', 'Promotion not found');
    }

    return promotion;
  }

  static async create(storeId: string, data: CreatePromotionData) {
    this.validateValue(data.type, data.value);
    await assertCustomerGroupInStore(storeId, data.customerGroupId); // BE:S-25

    const promotion = await prisma.promotion.create({
      data: {
        storeId,
        name: data.name,
        nameAr: data.nameAr,
        description: data.description,
        descriptionAr: data.descriptionAr,
        type: data.type,
        value: data.value,
        maxDiscount: data.maxDiscount,
        priority: data.priority ?? 0,
        isActive: data.isActive ?? true,
        startsAt: data.startsAt,
        expiresAt: data.expiresAt,
        customerGroupId: data.customerGroupId,
        firstOrderOnly: data.firstOrderOnly ?? false,
        minOrderAmount: data.minOrderAmount,
        minQuantity: data.minQuantity,
        scopeProductIds: data.scopeProductIds ?? [],
        scopeCategoryIds: data.scopeCategoryIds ?? [],
      },
    });

    return promotion;
  }

  static async update(storeId: string, promotionId: string, data: UpdatePromotionData) {
    const existing = await this.getById(storeId, promotionId);

    // Validate the merged type/value — a partial update that only touches
    // one of the two must still be checked against the resulting pair, not
    // just the fields present in this request.
    const type = data.type ?? (existing.type as CreatePromotionData['type']);
    const value = data.value ?? existing.value;
    this.validateValue(type, value);
    await assertCustomerGroupInStore(storeId, data.customerGroupId); // BE:S-25

    const promotion = await prisma.promotion.update({
      where: { id: promotionId, storeId },
      data: {
        name: data.name,
        nameAr: data.nameAr,
        description: data.description,
        descriptionAr: data.descriptionAr,
        type: data.type,
        value: data.value,
        maxDiscount: data.maxDiscount,
        priority: data.priority,
        isActive: data.isActive,
        startsAt: data.startsAt,
        expiresAt: data.expiresAt,
        customerGroupId: data.customerGroupId,
        firstOrderOnly: data.firstOrderOnly,
        minOrderAmount: data.minOrderAmount,
        minQuantity: data.minQuantity,
        scopeProductIds: data.scopeProductIds,
        scopeCategoryIds: data.scopeCategoryIds,
      },
    });

    return promotion;
  }

  static async delete(storeId: string, promotionId: string) {
    await this.getById(storeId, promotionId);

    await prisma.promotion.delete({
      where: { id: promotionId, storeId },
    });
  }

  static async toggleActive(storeId: string, promotionId: string) {
    const promotion = await this.getById(storeId, promotionId);

    const updatedPromotion = await prisma.promotion.update({
      where: { id: promotionId, storeId },
      data: { isActive: !promotion.isActive },
    });

    return updatedPromotion;
  }

  private static validateValue(type: string, value: number) {
    if (type === 'percentage' && (value < 0 || value > 100)) {
      throw new AppError(400, 'INVALID_VALUE', 'Percentage promotions must be 0-100.');
    }
    if (type === 'fixed' && value < 0) {
      throw new AppError(400, 'INVALID_VALUE', 'Fixed discount cannot be negative.');
    }
  }
}
