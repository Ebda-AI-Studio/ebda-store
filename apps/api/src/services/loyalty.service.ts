import { prisma, Prisma, LoyaltyTransactionType } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { featureService } from './feature.service';

// Default loyalty settings structure
interface LoyaltySettings {
  // Points earning
  pointsPerDinar: number; // Points earned per 1 KWD spent (e.g., 10 points per KWD)
  signupBonus: number; // Points given on account creation
  referralBonus: number; // Points for referring someone
  reviewBonus: number; // Points for leaving a review
  birthdayBonus: number; // Annual birthday bonus

  // Tiers
  tiers: {
    bronze: { minPoints: number; multiplier: number };
    silver: { minPoints: number; multiplier: number };
    gold: { minPoints: number; multiplier: number };
    platinum: { minPoints: number; multiplier: number };
  };

  // Redemption
  pointsValue: number; // Value in fils per point (e.g., 1 point = 1 fils)
  minRedeemPoints: number; // Minimum points to redeem
  maxRedeemPercentage: number; // Max % of order that can be paid with points

  // Expiration
  expirationMonths: number; // Points expire after X months (0 = never)
}

const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = {
  pointsPerDinar: 10, // 10 points per 1 KWD
  signupBonus: 100,
  referralBonus: 200,
  reviewBonus: 50,
  birthdayBonus: 500,
  tiers: {
    bronze: { minPoints: 0, multiplier: 1.0 },
    silver: { minPoints: 1000, multiplier: 1.25 },
    gold: { minPoints: 5000, multiplier: 1.5 },
    platinum: { minPoints: 15000, multiplier: 2.0 },
  },
  pointsValue: 1, // 1 point = 1 fils (0.001 KWD)
  minRedeemPoints: 500, // Minimum 500 points to redeem
  maxRedeemPercentage: 50, // Max 50% of order value
  expirationMonths: 12, // Points expire after 1 year
};

interface LoyaltySettingsResponse {
  loyaltyEnabled: boolean;
  settings: LoyaltySettings;
}

interface CustomerPointsInfo {
  id: string;
  customerId: string;
  points: number;
  totalEarned: number;
  totalRedeemed: number;
  tier: string;
  tierMultiplier: number;
  nextTier: string | null;
  pointsToNextTier: number;
  pointsValue: number; // Value in fils
}

export class LoyaltyService {
  /**
   * Get store loyalty settings
   */
  static async getSettings(storeId: string): Promise<LoyaltySettingsResponse> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        loyaltyEnabled: true,
        loyaltySettings: true,
      },
    });

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    return {
      loyaltyEnabled: store.loyaltyEnabled,
      settings,
    };
  }

  /**
   * Update store loyalty settings
   */
  static async updateSettings(
    storeId: string,
    data: { loyaltyEnabled?: boolean; settings?: Partial<LoyaltySettings> }
  ): Promise<LoyaltySettingsResponse> {
    // Verify store exists
    const existing = await prisma.store.findUnique({
      where: { id: storeId },
      select: { loyaltySettings: true },
    });

    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    const currentSettings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(existing.loyaltySettings as Partial<LoyaltySettings>),
    };

    const updatedSettings = data.settings
      ? { ...currentSettings, ...data.settings }
      : currentSettings;

    const store = await prisma.store.update({
      where: { id: storeId },
      data: {
        loyaltyEnabled: data.loyaltyEnabled,
        loyaltySettings: updatedSettings as unknown as Prisma.InputJsonValue,
      },
      select: {
        loyaltyEnabled: true,
        loyaltySettings: true,
      },
    });

    return {
      loyaltyEnabled: store.loyaltyEnabled,
      settings: store.loyaltySettings as unknown as LoyaltySettings,
    };
  }

  /**
   * Get customer's loyalty points info
   */
  static async getCustomerPoints(
    storeId: string,
    customerId: string
  ): Promise<CustomerPointsInfo | null> {
    const [loyalty, store, loyaltyEnabled] = await Promise.all([
      prisma.loyaltyPoints.findUnique({
        where: {
          storeId_customerId: { storeId, customerId },
        },
      }),
      prisma.store.findUnique({
        where: { id: storeId },
        select: {
          loyaltySettings: true,
        },
      }),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store || !loyaltyEnabled) {
      return null;
    }

    if (!loyalty) {
      return null;
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    const tierInfo = this.getTierInfo(loyalty.totalEarned, settings);

    return {
      id: loyalty.id,
      customerId: loyalty.customerId,
      points: loyalty.points,
      totalEarned: loyalty.totalEarned,
      totalRedeemed: loyalty.totalRedeemed,
      tier: loyalty.tier,
      tierMultiplier: tierInfo.multiplier,
      nextTier: tierInfo.nextTier,
      pointsToNextTier: tierInfo.pointsToNext,
      pointsValue: settings.pointsValue,
    };
  }

  /**
   * Initialize loyalty points for a new customer
   */
  static async initializeCustomerPoints(
    storeId: string,
    customerId: string,
    giveSignupBonus = true
  ): Promise<CustomerPointsInfo> {
    const [store, loyaltyEnabled] = await Promise.all([
      prisma.store.findUnique({
        where: { id: storeId },
        select: {
          loyaltySettings: true,
        },
      }),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    if (!loyaltyEnabled) {
      throw new AppError(400, 'LOYALTY_DISABLED', 'Loyalty program is not enabled for this store');
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    // Check if already exists
    const existing = await prisma.loyaltyPoints.findUnique({
      where: {
        storeId_customerId: { storeId, customerId },
      },
    });

    if (existing) {
      throw new AppError(400, 'ALREADY_EXISTS', 'Customer already has loyalty points');
    }

    const signupBonus = giveSignupBonus ? settings.signupBonus : 0;

    // Create loyalty points record
    const loyalty = await prisma.loyaltyPoints.create({
      data: {
        storeId,
        customerId,
        points: signupBonus,
        totalEarned: signupBonus,
        tier: 'bronze',
      },
    });

    // Log signup bonus transaction
    if (signupBonus > 0) {
      await prisma.loyaltyTransaction.create({
        data: {
          storeId,
          customerId,
          type: 'earn_signup',
          points: signupBonus,
          description: 'Welcome bonus for joining loyalty program',
          expiresAt:
            settings.expirationMonths > 0
              ? new Date(Date.now() + settings.expirationMonths * 30 * 24 * 60 * 60 * 1000)
              : null,
        },
      });
    }

    const tierInfo = this.getTierInfo(loyalty.totalEarned, settings);

    return {
      id: loyalty.id,
      customerId: loyalty.customerId,
      points: loyalty.points,
      totalEarned: loyalty.totalEarned,
      totalRedeemed: loyalty.totalRedeemed,
      tier: loyalty.tier,
      tierMultiplier: tierInfo.multiplier,
      nextTier: tierInfo.nextTier,
      pointsToNextTier: tierInfo.pointsToNext,
      pointsValue: settings.pointsValue,
    };
  }

  /**
   * Award points for a purchase
   */
  static async earnPointsFromPurchase(
    storeId: string,
    customerId: string,
    orderId: string,
    orderTotalFils: number
  ): Promise<{ pointsEarned: number; newBalance: number }> {
    const [store, loyaltyEnabled] = await Promise.all([
      prisma.store.findUnique({
        where: { id: storeId },
        select: {
          loyaltySettings: true,
        },
      }),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store || !loyaltyEnabled) {
      return { pointsEarned: 0, newBalance: 0 };
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    // Get or create loyalty record
    let loyalty = await prisma.loyaltyPoints.findUnique({
      where: {
        storeId_customerId: { storeId, customerId },
      },
    });

    if (!loyalty) {
      // Auto-initialize for purchase
      loyalty = await prisma.loyaltyPoints.create({
        data: {
          storeId,
          customerId,
          points: 0,
          totalEarned: 0,
          tier: 'bronze',
        },
      });
    }

    // Get tier multiplier
    const tierInfo = this.getTierInfo(loyalty.totalEarned, settings);

    // Calculate points: (orderTotal in KWD) * pointsPerDinar * tierMultiplier
    const orderTotalKWD = orderTotalFils / 1000;
    const basePoints = Math.floor(orderTotalKWD * settings.pointsPerDinar);
    const pointsEarned = Math.floor(basePoints * tierInfo.multiplier);

    // Update balance and log transaction atomically
    const [updated] = await prisma.$transaction([
      prisma.loyaltyPoints.update({
        where: { id: loyalty.id },
        data: {
          points: { increment: pointsEarned },
          totalEarned: { increment: pointsEarned },
          tier: this.calculateTier(loyalty.totalEarned + pointsEarned, settings),
        },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          storeId,
          customerId,
          orderId,
          type: 'earn_purchase',
          points: pointsEarned,
          description: `Points earned from order (${tierInfo.multiplier}x multiplier)`,
          expiresAt:
            settings.expirationMonths > 0
              ? new Date(Date.now() + settings.expirationMonths * 30 * 24 * 60 * 60 * 1000)
              : null,
        },
      }),
    ]);

    return {
      pointsEarned,
      newBalance: updated.points,
    };
  }

  /**
   * Redeem points for a discount
   */
  static async redeemPoints(
    storeId: string,
    customerId: string,
    orderId: string,
    pointsToRedeem: number
  ): Promise<{ discountFils: number; newBalance: number }> {
    const [store, loyaltyEnabled] = await Promise.all([
      prisma.store.findUnique({
        where: { id: storeId },
        select: {
          loyaltySettings: true,
        },
      }),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store || !loyaltyEnabled) {
      throw new AppError(400, 'LOYALTY_DISABLED', 'Loyalty program is not enabled');
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    // Get loyalty record
    const loyalty = await prisma.loyaltyPoints.findUnique({
      where: {
        storeId_customerId: { storeId, customerId },
      },
    });

    if (!loyalty) {
      throw new AppError(400, 'NO_POINTS', 'Customer has no loyalty points');
    }

    if (pointsToRedeem < settings.minRedeemPoints) {
      throw new AppError(
        400,
        'MIN_POINTS_NOT_MET',
        `Minimum ${settings.minRedeemPoints} points required to redeem`
      );
    }

    if (loyalty.points < pointsToRedeem) {
      throw new AppError(400, 'INSUFFICIENT_POINTS', 'Insufficient points balance');
    }

    // Calculate discount value
    const discountFils = pointsToRedeem * settings.pointsValue;

    // Update balance and log transaction atomically
    const [updated] = await prisma.$transaction([
      prisma.loyaltyPoints.update({
        where: { id: loyalty.id },
        data: {
          points: { decrement: pointsToRedeem },
          totalRedeemed: { increment: pointsToRedeem },
        },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          storeId,
          customerId,
          orderId,
          type: 'redeem_discount',
          points: -pointsToRedeem,
          description: `Redeemed ${pointsToRedeem} points for ${(discountFils / 1000).toFixed(3)} KWD discount`,
        },
      }),
    ]);

    return {
      discountFils,
      newBalance: updated.points,
    };
  }

  /**
   * Award bonus points (manual or for reviews, referrals, etc.)
   */
  static async awardBonusPoints(
    storeId: string,
    customerId: string,
    points: number,
    type: LoyaltyTransactionType,
    description?: string
  ): Promise<{ newBalance: number }> {
    const [store, loyaltyEnabled] = await Promise.all([
      prisma.store.findUnique({
        where: { id: storeId },
        select: {
          loyaltySettings: true,
        },
      }),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store || !loyaltyEnabled) {
      throw new AppError(400, 'LOYALTY_DISABLED', 'Loyalty program is not enabled');
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    // Get or create loyalty record
    let loyalty = await prisma.loyaltyPoints.findUnique({
      where: {
        storeId_customerId: { storeId, customerId },
      },
    });

    if (!loyalty) {
      loyalty = await prisma.loyaltyPoints.create({
        data: {
          storeId,
          customerId,
          points: 0,
          totalEarned: 0,
          tier: 'bronze',
        },
      });
    }

    // Update balance and log transaction atomically
    const isPositive = points > 0;
    const [updated] = await prisma.$transaction([
      prisma.loyaltyPoints.update({
        where: { id: loyalty.id },
        data: {
          points: { increment: points },
          totalEarned: isPositive ? { increment: points } : undefined,
          totalRedeemed: !isPositive ? { increment: Math.abs(points) } : undefined,
          tier: isPositive
            ? this.calculateTier(loyalty.totalEarned + points, settings)
            : loyalty.tier,
        },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          storeId,
          customerId,
          type,
          points,
          description,
          expiresAt:
            isPositive && settings.expirationMonths > 0
              ? new Date(Date.now() + settings.expirationMonths * 30 * 24 * 60 * 60 * 1000)
              : null,
        },
      }),
    ]);

    return { newBalance: updated.points };
  }

  /**
   * Get customer's transaction history
   */
  static async getTransactionHistory(
    storeId: string,
    customerId: string,
    options?: { page?: number; limit?: number }
  ) {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      prisma.loyaltyTransaction.findMany({
        where: { storeId, customerId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
            },
          },
        },
      }),
      prisma.loyaltyTransaction.count({
        where: { storeId, customerId },
      }),
    ]);

    return {
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * List all loyalty members for a store (admin)
   */
  static async listMembers(
    storeId: string,
    options?: { page?: number; limit?: number; tier?: string; search?: string }
  ) {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.LoyaltyPointsWhereInput = { storeId };
    if (options?.tier) {
      where.tier = options.tier;
    }

    const [members, total] = await Promise.all([
      prisma.loyaltyPoints.findMany({
        where,
        orderBy: { totalEarned: 'desc' },
        skip,
        take: limit,
        include: {
          customer: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      prisma.loyaltyPoints.count({ where }),
    ]);

    return {
      members,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get loyalty program statistics
   */
  static async getStats(storeId: string) {
    const [totalMembers, tierCounts, totalPointsIssued, totalPointsRedeemed] = await Promise.all([
      prisma.loyaltyPoints.count({ where: { storeId } }),
      prisma.loyaltyPoints.groupBy({
        by: ['tier'],
        where: { storeId },
        _count: true,
      }),
      prisma.loyaltyPoints.aggregate({
        where: { storeId },
        _sum: { totalEarned: true },
      }),
      prisma.loyaltyPoints.aggregate({
        where: { storeId },
        _sum: { totalRedeemed: true },
      }),
    ]);

    const tierBreakdown = tierCounts.reduce(
      (acc, { tier, _count }) => {
        acc[tier] = _count;
        return acc;
      },
      {} as Record<string, number>
    );

    return {
      totalMembers,
      tierBreakdown: {
        bronze: tierBreakdown.bronze || 0,
        silver: tierBreakdown.silver || 0,
        gold: tierBreakdown.gold || 0,
        platinum: tierBreakdown.platinum || 0,
      },
      totalPointsIssued: totalPointsIssued._sum.totalEarned || 0,
      totalPointsRedeemed: totalPointsRedeemed._sum.totalRedeemed || 0,
      outstandingPoints:
        (totalPointsIssued._sum.totalEarned || 0) - (totalPointsRedeemed._sum.totalRedeemed || 0),
    };
  }

  // Helper: Get tier info
  private static getTierInfo(
    totalEarned: number,
    settings: LoyaltySettings
  ): { tier: string; multiplier: number; nextTier: string | null; pointsToNext: number } {
    const tiers = ['bronze', 'silver', 'gold', 'platinum'] as const;
    let currentTier: (typeof tiers)[number] = 'bronze';
    let nextTier: (typeof tiers)[number] | null = null;

    for (let i = tiers.length - 1; i >= 0; i--) {
      if (totalEarned >= settings.tiers[tiers[i]].minPoints) {
        currentTier = tiers[i];
        nextTier = i < tiers.length - 1 ? tiers[i + 1] : null;
        break;
      }
    }

    const pointsToNext = nextTier ? settings.tiers[nextTier].minPoints - totalEarned : 0;

    return {
      tier: currentTier,
      multiplier: settings.tiers[currentTier].multiplier,
      nextTier,
      pointsToNext: Math.max(0, pointsToNext),
    };
  }

  // Helper: Calculate tier from points
  private static calculateTier(totalEarned: number, settings: LoyaltySettings): string {
    const tiers = ['bronze', 'silver', 'gold', 'platinum'] as const;
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (totalEarned >= settings.tiers[tiers[i]].minPoints) {
        return tiers[i];
      }
    }
    return 'bronze';
  }
}
