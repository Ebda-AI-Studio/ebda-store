import { randomBytes } from 'crypto';
import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { recordAffiliateEvent } from './affiliate-event.service';

// ==========================================
// Interfaces
// ==========================================

interface AffiliateConfigDefaults {
  defaultCommissionRate: number;
  cookieDurationDays: number;
  minPayoutAmount: number;
  autoApprove: boolean;
  publicSignupEnabled: boolean;
}

const CONFIG_DEFAULTS: AffiliateConfigDefaults = {
  defaultCommissionRate: 10,
  cookieDurationDays: 30,
  minPayoutAmount: 5000,
  autoApprove: false,
  publicSignupEnabled: true,
};

interface ApplyAffiliateData {
  name: string;
  email: string;
  phone?: string;
  instagram?: string;
  tiktok?: string;
}

interface CreateAffiliateData {
  name: string;
  email: string;
  phone?: string;
  instagram?: string;
  tiktok?: string;
  commissionRate?: number;
  notes?: string;
}

interface UpdateAffiliateData {
  commissionRate?: number;
  notes?: string;
}

interface ListAffiliatesOptions {
  page?: number;
  limit?: number;
  status?: string;
}

interface ListReferralsOptions {
  page?: number;
  limit?: number;
}

interface CreatePayoutData {
  amount: number;
  method?: string;
  notes?: string;
}

// ==========================================
// Helpers
// ==========================================

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 10);
}

function randomChars(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(bytes[i] % chars.length);
  }
  return result;
}

// ==========================================
// Service
// ==========================================

class AffiliateService {
  // ---- Config ----

  async getConfig(storeId: string) {
    const config = await prisma.affiliateConfig.findUnique({
      where: { storeId },
    });

    if (!config) {
      return { storeId, ...CONFIG_DEFAULTS };
    }

    return config;
  }

  async upsertConfig(storeId: string, data: Partial<AffiliateConfigDefaults>) {
    const config = await prisma.affiliateConfig.upsert({
      where: { storeId },
      create: {
        storeId,
        defaultCommissionRate: data.defaultCommissionRate ?? CONFIG_DEFAULTS.defaultCommissionRate,
        cookieDurationDays: data.cookieDurationDays ?? CONFIG_DEFAULTS.cookieDurationDays,
        minPayoutAmount: data.minPayoutAmount ?? CONFIG_DEFAULTS.minPayoutAmount,
        autoApprove: data.autoApprove ?? CONFIG_DEFAULTS.autoApprove,
        publicSignupEnabled: data.publicSignupEnabled ?? CONFIG_DEFAULTS.publicSignupEnabled,
      },
      update: {
        ...(data.defaultCommissionRate !== undefined && {
          defaultCommissionRate: data.defaultCommissionRate,
        }),
        ...(data.cookieDurationDays !== undefined && {
          cookieDurationDays: data.cookieDurationDays,
        }),
        ...(data.minPayoutAmount !== undefined && { minPayoutAmount: data.minPayoutAmount }),
        ...(data.autoApprove !== undefined && { autoApprove: data.autoApprove }),
        ...(data.publicSignupEnabled !== undefined && {
          publicSignupEnabled: data.publicSignupEnabled,
        }),
      },
    });

    return config;
  }

  // ---- Referral Code Generation ----

  private async generateUniqueReferralCode(storeId: string, name: string): Promise<string> {
    const base = slugify(name);

    for (let attempt = 0; attempt < 10; attempt++) {
      const code = `${base}${randomChars(4)}`;
      const existing = await prisma.affiliate.findUnique({
        where: { storeId_referralCode: { storeId, referralCode: code } },
      });
      if (!existing) return code;
    }

    // Fallback: fully random
    return randomChars(12);
  }

  // ---- Public Signup ----

  async apply(storeId: string, data: ApplyAffiliateData) {
    const config = await this.getConfig(storeId);

    // Check if public signup is enabled
    if (!config.publicSignupEnabled) {
      throw new AppError(403, 'SIGNUP_DISABLED', 'Public affiliate signup is currently disabled');
    }

    // Check duplicate email
    const existing = await prisma.affiliate.findUnique({
      where: { storeId_email: { storeId, email: data.email } },
    });
    if (existing) {
      throw new AppError(409, 'DUPLICATE_EMAIL', 'An affiliate with this email already exists');
    }

    const referralCode = await this.generateUniqueReferralCode(storeId, data.name);
    const status = config.autoApprove ? 'approved' : 'pending';
    const approvedAt = config.autoApprove ? new Date() : null;

    const affiliate = await prisma.affiliate.create({
      data: {
        storeId,
        name: data.name,
        email: data.email,
        phone: data.phone,
        instagram: data.instagram,
        tiktok: data.tiktok,
        referralCode,
        status,
        approvedAt,
      },
    });

    logger.info(
      { storeId, affiliateId: affiliate.id, status },
      '[AffiliateService] New affiliate applied'
    );

    void recordAffiliateEvent({
      affiliateId: affiliate.id,
      storeId,
      eventType: 'created',
      toStatus: status,
      details: { source: 'public_signup', autoApprove: config.autoApprove },
    });

    return affiliate;
  }

  // ---- Admin Invite ----

  async create(storeId: string, data: CreateAffiliateData) {
    // Check duplicate email
    const existing = await prisma.affiliate.findUnique({
      where: { storeId_email: { storeId, email: data.email } },
    });
    if (existing) {
      throw new AppError(409, 'DUPLICATE_EMAIL', 'An affiliate with this email already exists');
    }

    const referralCode = await this.generateUniqueReferralCode(storeId, data.name);

    const affiliate = await prisma.affiliate.create({
      data: {
        storeId,
        name: data.name,
        email: data.email,
        phone: data.phone,
        instagram: data.instagram,
        tiktok: data.tiktok,
        referralCode,
        status: 'approved',
        approvedAt: new Date(),
        commissionRate: data.commissionRate,
        notes: data.notes,
      },
    });

    logger.info(
      { storeId, affiliateId: affiliate.id },
      '[AffiliateService] Admin created affiliate'
    );

    void recordAffiliateEvent({
      affiliateId: affiliate.id,
      storeId,
      eventType: 'created',
      toStatus: 'approved',
      details: { source: 'admin_invite' },
    });

    return affiliate;
  }

  // ---- List ----

  async list(storeId: string, options: ListAffiliatesOptions = {}) {
    const { status } = options;
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.AffiliateWhereInput = { storeId };
    if (status) where.status = status;

    const [affiliates, total] = await Promise.all([
      prisma.affiliate.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { referrals: true, payouts: true } },
        },
      }),
      prisma.affiliate.count({ where }),
    ]);

    return {
      affiliates,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ---- Get by ID ----

  async getById(storeId: string, id: string) {
    const affiliate = await prisma.affiliate.findFirst({
      where: { id, storeId },
      include: {
        _count: { select: { referrals: true, payouts: true } },
      },
    });

    if (!affiliate) {
      throw new AppError(404, 'NOT_FOUND', 'Affiliate not found');
    }

    return affiliate;
  }

  // ---- Update ----

  async update(storeId: string, id: string, data: UpdateAffiliateData) {
    await this.getById(storeId, id);

    const affiliate = await prisma.affiliate.update({
      where: { id },
      data: {
        ...(data.commissionRate !== undefined && { commissionRate: data.commissionRate }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
    });

    return affiliate;
  }

  // ---- Status Transitions ----

  async approve(storeId: string, id: string, userId: string) {
    const affiliate = await this.getById(storeId, id);

    if (affiliate.status !== 'pending') {
      throw new AppError(400, 'INVALID_STATUS', 'Only pending affiliates can be approved');
    }

    const updated = await prisma.affiliate.update({
      where: { id },
      data: { status: 'approved', approvedAt: new Date(), approvedBy: userId },
    });

    void recordAffiliateEvent({
      affiliateId: id,
      storeId,
      eventType: 'approve',
      fromStatus: affiliate.status,
      toStatus: 'approved',
      triggeredByUserId: userId,
    });

    return updated;
  }

  async reject(storeId: string, id: string, userId: string) {
    const affiliate = await this.getById(storeId, id);

    if (affiliate.status !== 'pending') {
      throw new AppError(400, 'INVALID_STATUS', 'Only pending affiliates can be rejected');
    }

    const updated = await prisma.affiliate.update({
      where: { id },
      data: { status: 'rejected', approvedBy: userId },
    });

    void recordAffiliateEvent({
      affiliateId: id,
      storeId,
      eventType: 'reject',
      fromStatus: affiliate.status,
      toStatus: 'rejected',
      triggeredByUserId: userId,
    });

    return updated;
  }

  async suspend(storeId: string, id: string, userId: string) {
    const affiliate = await this.getById(storeId, id);

    const updated = await prisma.affiliate.update({
      where: { id },
      data: { status: 'suspended', approvedBy: userId },
    });

    void recordAffiliateEvent({
      affiliateId: id,
      storeId,
      eventType: 'suspend',
      fromStatus: affiliate.status,
      toStatus: 'suspended',
      triggeredByUserId: userId,
    });

    return updated;
  }

  // ---- Delete ----

  async delete(storeId: string, id: string) {
    await this.getById(storeId, id);

    await prisma.affiliate.delete({ where: { id } });
  }

  // ---- Click Tracking ----

  async registerClick(storeId: string, referralCode: string, sessionId: string) {
    const affiliate = await prisma.affiliate.findUnique({
      where: { storeId_referralCode: { storeId, referralCode } },
    });

    if (!affiliate || affiliate.status !== 'approved') {
      throw new AppError(404, 'NOT_FOUND', 'Referral code not found or affiliate not active');
    }

    const config = await this.getConfig(storeId);
    const cookieDurationDays =
      'cookieDurationDays' in config
        ? config.cookieDurationDays
        : CONFIG_DEFAULTS.cookieDurationDays;

    const cookieExpiresAt = new Date();
    cookieExpiresAt.setDate(cookieExpiresAt.getDate() + cookieDurationDays);

    const referral = await prisma.affiliateReferral.create({
      data: {
        storeId,
        affiliateId: affiliate.id,
        referralCode,
        sessionId,
        status: 'clicked',
        cookieExpiresAt,
      },
    });

    logger.info(
      { storeId, referralId: referral.id, affiliateId: affiliate.id },
      '[AffiliateService] Click registered'
    );

    return { referral, cookieExpiresAt };
  }

  // ---- Link Order to Referral ----

  async linkOrderToReferral(storeId: string, orderId: string, referralCode: string) {
    // Find the most recent active clicked referral for this code
    const referral = await prisma.affiliateReferral.findFirst({
      where: {
        storeId,
        referralCode,
        status: 'clicked',
        orderId: null,
        cookieExpiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!referral) {
      logger.info(
        { storeId, orderId, referralCode },
        '[AffiliateService] No active referral found for code'
      );
      return null;
    }

    const updated = await prisma.affiliateReferral.update({
      where: { id: referral.id },
      data: { orderId, status: 'converted', convertedAt: new Date() },
    });

    logger.info(
      { storeId, orderId, referralId: referral.id },
      '[AffiliateService] Order linked to referral'
    );

    return updated;
  }

  // ---- Process Commission ----

  async processCommission(storeId: string, orderId: string) {
    const referral = await prisma.affiliateReferral.findFirst({
      where: { storeId, orderId, status: 'converted', commissionAmount: null },
      include: { affiliate: true },
    });

    if (!referral) {
      logger.info(
        { storeId, orderId },
        '[AffiliateService] No unconverted referral found for commission'
      );
      return null;
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      logger.warn(
        { storeId, orderId },
        '[AffiliateService] Order not found for commission processing'
      );
      return null;
    }

    // Determine commission rate: affiliate-specific or config default
    const config = await this.getConfig(storeId);
    const defaultRate =
      'defaultCommissionRate' in config
        ? Number(config.defaultCommissionRate)
        : CONFIG_DEFAULTS.defaultCommissionRate;
    const rate = referral.affiliate.commissionRate
      ? Number(referral.affiliate.commissionRate)
      : defaultRate;

    const commissionAmount = Math.round((order.total * rate) / 100);

    // Update referral and affiliate balances atomically
    await prisma.$transaction([
      prisma.affiliateReferral.update({
        where: { id: referral.id },
        data: { commissionAmount, status: 'commission_paid' },
      }),
      prisma.affiliate.update({
        where: { id: referral.affiliateId },
        data: {
          totalEarned: { increment: commissionAmount },
          pendingBalance: { increment: commissionAmount },
        },
      }),
    ]);

    logger.info(
      { storeId, orderId, affiliateId: referral.affiliateId, commissionAmount, rate },
      '[AffiliateService] Commission processed'
    );

    void recordAffiliateEvent({
      affiliateId: referral.affiliateId,
      storeId,
      eventType: 'commission_recorded',
      details: { orderId, commissionAmount, rate, referralId: referral.id },
    });

    return { commissionAmount, rate };
  }

  /**
   * Reverse a commission previously paid out for an order. Called when
   * the order is refunded or fully cancelled — the customer gets their
   * money back, so the affiliate doesn't get to keep the commission.
   *
   * Idempotent: if no commission_paid referral exists for this order
   * (e.g. the order was refunded before delivery, or this is a partial
   * refund where commission stays earned), returns null silently. The
   * referral row gets status='refunded' so finance can audit it; the
   * affiliate's totalEarned + pendingBalance get the commission
   * decremented (mirrors the increment in processCommission).
   */
  async reverseCommission(storeId: string, orderId: string) {
    const referral = await prisma.affiliateReferral.findFirst({
      where: { storeId, orderId, status: 'commission_paid' },
    });

    if (!referral || !referral.commissionAmount) {
      return null;
    }

    const amount = referral.commissionAmount ?? 0;

    await prisma.$transaction([
      prisma.affiliateReferral.update({
        where: { id: referral.id },
        data: { status: 'refunded' },
      }),
      prisma.affiliate.update({
        where: { id: referral.affiliateId },
        data: {
          totalEarned: { decrement: amount },
          pendingBalance: { decrement: amount },
        },
      }),
    ]);

    logger.info(
      { storeId, orderId, affiliateId: referral.affiliateId, amount },
      '[AffiliateService] Commission reversed (order refunded)'
    );

    void recordAffiliateEvent({
      affiliateId: referral.affiliateId,
      storeId,
      eventType: 'commission_reversed',
      details: { orderId, amount, referralId: referral.id },
    });

    return { amount };
  }

  // ---- Referrals ----

  async getReferrals(storeId: string, affiliateId: string, options: ListReferralsOptions = {}) {
    await this.getById(storeId, affiliateId);

    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.AffiliateReferralWhereInput = { storeId, affiliateId };

    const [referrals, total] = await Promise.all([
      prisma.affiliateReferral.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.affiliateReferral.count({ where }),
    ]);

    return {
      referrals,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ---- Payouts ----

  async getPayouts(storeId: string, affiliateId: string, options: ListReferralsOptions = {}) {
    await this.getById(storeId, affiliateId);

    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.AffiliatePayoutWhereInput = { storeId, affiliateId };

    const [payouts, total] = await Promise.all([
      prisma.affiliatePayout.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.affiliatePayout.count({ where }),
    ]);

    return {
      payouts,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async createPayout(storeId: string, affiliateId: string, data: CreatePayoutData) {
    const affiliate = await this.getById(storeId, affiliateId);

    if (data.amount <= 0) {
      throw new AppError(400, 'INVALID_AMOUNT', 'Payout amount must be greater than zero');
    }

    const pending = affiliate.pendingBalance;
    if (data.amount > pending) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Payout amount exceeds pending balance');
    }

    const [payout] = await prisma.$transaction([
      prisma.affiliatePayout.create({
        data: {
          storeId,
          affiliateId,
          amount: data.amount,
          method: data.method ?? 'manual',
          status: 'pending',
          notes: data.notes,
        },
      }),
      prisma.affiliate.update({
        where: { id: affiliateId },
        data: {
          pendingBalance: { decrement: data.amount },
          totalPaid: { increment: data.amount },
        },
      }),
    ]);

    logger.info(
      { storeId, affiliateId, payoutId: payout.id, amount: data.amount },
      '[AffiliateService] Payout created'
    );

    void recordAffiliateEvent({
      affiliateId,
      storeId,
      eventType: 'payout_initiated',
      details: { payoutId: payout.id, amount: data.amount, method: payout.method },
    });

    return payout;
  }

  // ---- Stats ----

  async getStats(storeId: string) {
    const [totalAffiliates, activeAffiliates, totalReferrals, conversions, commissionSumResult] =
      await Promise.all([
        prisma.affiliate.count({ where: { storeId } }),
        prisma.affiliate.count({ where: { storeId, status: 'approved' } }),
        prisma.affiliateReferral.count({ where: { storeId } }),
        prisma.affiliateReferral.count({
          where: { storeId, status: { in: ['converted', 'commission_paid'] } },
        }),
        prisma.affiliate.aggregate({
          where: { storeId },
          _sum: { totalPaid: true },
        }),
      ]);

    const commissionPaid = commissionSumResult._sum.totalPaid ?? 0;

    return {
      totalAffiliates,
      activeAffiliates,
      totalReferrals,
      conversions,
      conversionRate: totalReferrals > 0 ? Math.round((conversions / totalReferrals) * 100) : 0,
      commissionPaid,
    };
  }
}

export const affiliateService = new AffiliateService();
