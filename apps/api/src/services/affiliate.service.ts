import { randomBytes, randomUUID } from 'crypto';
import { prisma, Prisma, hasTenantContext, withMoneyTx } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { storeDb, storeMoney } from '../lib/repo-factory';
import { opKey } from '../lib/money-idempotency';
import logger from '../lib/logger';
import { recordAffiliateEvent, affiliateEventCreate } from './affiliate-event.service';

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
  minPayoutAmount: 50000, // 500 EGP in piastres
  autoApprove: false,
  publicSignupEnabled: true,
};

/**
 * Run a commission money write atomically.
 *
 * Both production callers (the Inngest order-status-changed and order-refunded
 * fanouts) wrap the service in `runInTenantContext`, and `$transaction` is not
 * proxied onto that ambient transaction (see `hasTenantContext`): the old
 * `prisma.$transaction([...])` therefore ran the balance writes on a second,
 * GUC-less connection that committed independently of the tenant tx. Inside a
 * tenant context the ambient transaction already makes the writes atomic, so
 * use it; outside one, open a transaction of our own.
 */
function inAffiliateMoneyTx<T>(fn: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return hasTenantContext()
    ? fn(prisma as unknown as Prisma.TransactionClient)
    : withMoneyTx(prisma, fn);
}

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
    const config = await (
      await storeDb(storeId)
    ).affiliateConfig.findUnique({
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

    await recordAffiliateEvent({
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

    await recordAffiliateEvent({
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
    // the store's own backend (NEON-ZERO); the `prisma` proxy for a Postgres store
    const affiliate = await (
      await storeDb(storeId)
    ).affiliate.findFirst({
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
      where: { id, storeId },
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
      where: { id, storeId },
      data: { status: 'approved', approvedAt: new Date(), approvedBy: userId },
    });

    await recordAffiliateEvent({
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
      where: { id, storeId },
      data: { status: 'rejected', approvedBy: userId },
    });

    await recordAffiliateEvent({
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
      where: { id, storeId },
      data: { status: 'suspended', approvedBy: userId },
    });

    await recordAffiliateEvent({
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

    await prisma.affiliate.delete({ where: { id, storeId } });
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
      where: { id: referral.id, storeId },
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
    // A store on its Durable Object (Ruling CF-JOBS-4): reads follow the backend, the claim + balances + event are ONE section.
    const money = await storeMoney(storeId);
    const rdb = await storeDb(storeId);
    const referral = await rdb.affiliateReferral.findFirst({
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

    const order = await rdb.order.findUnique({ where: { id: orderId, storeId } });
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

    // Claim-then-credit (#618). The findFirst above is only a fast path: two
    // duplicate `order/status-changed` deliveries can both pass it. The
    // conditional updateMany is the real guard — Postgres serialises the two
    // UPDATEs on the referral's row lock and re-checks the WHERE against the
    // winner's committed row, so the loser matches 0 rows and never reaches
    // the balance increment. Both writes share one transaction, so a failed
    // credit also un-claims the referral.
    const claimed = money
      ? (await money.affiliateCommission({ referralId: referral.id, commissionAmount, rate }))
          .claimed
      : await inAffiliateMoneyTx(async db => {
          const claim = await db.affiliateReferral.updateMany({
            where: { id: referral.id, storeId, status: 'converted', commissionAmount: null },
            data: { commissionAmount, status: 'commission_paid' },
          });
          if (claim.count !== 1) return false;
          await db.affiliate.update({
            where: { id: referral.affiliateId, storeId },
            data: {
              totalEarned: { increment: commissionAmount },
              pendingBalance: { increment: commissionAmount },
            },
          });
          // The audit row rides the same transaction as the credit (#1590), and
          // only the claim winner writes it — a skipped duplicate moved no money.
          await affiliateEventCreate(
            {
              affiliateId: referral.affiliateId,
              storeId,
              eventType: 'commission_recorded',
              details: { orderId, commissionAmount, rate, referralId: referral.id },
            },
            db
          );
          return true;
        });

    if (!claimed) {
      logger.info(
        { storeId, orderId, referralId: referral.id },
        '[AffiliateService] Commission already processed by a concurrent run — skipped'
      );
      return null;
    }

    logger.info(
      { storeId, orderId, affiliateId: referral.affiliateId, commissionAmount, rate },
      '[AffiliateService] Commission processed'
    );

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
    const money = await storeMoney(storeId);
    if (money) {
      // one section on the Durable Object: referral -> refunded, balances back, event row
      const r = await money.affiliateReverse({ orderId });
      return r.amount === null ? null : { amount: r.amount };
    }
    const referral = await prisma.affiliateReferral.findFirst({
      where: { storeId, orderId, status: 'commission_paid' },
    });

    if (!referral || !referral.commissionAmount) {
      return null;
    }

    const amount = referral.commissionAmount ?? 0;

    // Same claim-then-debit guard as processCommission (#618): a duplicate
    // refund delivery that also passed the findFirst matches 0 rows here and
    // cannot decrement the affiliate twice.
    const claimed = await inAffiliateMoneyTx(async db => {
      const claim = await db.affiliateReferral.updateMany({
        where: { id: referral.id, storeId, status: 'commission_paid' },
        data: { status: 'refunded' },
      });
      if (claim.count !== 1) return false;
      await db.affiliate.update({
        where: { id: referral.affiliateId, storeId },
        data: {
          totalEarned: { decrement: amount },
          pendingBalance: { decrement: amount },
        },
      });
      // Audit row in the same transaction as the debit (#1590).
      await affiliateEventCreate(
        {
          affiliateId: referral.affiliateId,
          storeId,
          eventType: 'commission_reversed',
          details: { orderId, amount, referralId: referral.id },
        },
        db
      );
      return true;
    });

    if (!claimed) {
      logger.info(
        { storeId, orderId, referralId: referral.id },
        '[AffiliateService] Commission already reversed by a concurrent run — skipped'
      );
      return null;
    }

    logger.info(
      { storeId, orderId, affiliateId: referral.affiliateId, amount },
      '[AffiliateService] Commission reversed (order refunded)'
    );

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

    const db = await storeDb(storeId); // the store's own backend (NEON-ZERO); the `prisma` proxy for a Postgres store
    const [payouts, total] = await Promise.all([
      db.affiliatePayout.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      db.affiliatePayout.count({ where }),
    ]);

    return {
      payouts,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async createPayout(
    storeId: string,
    affiliateId: string,
    data: CreatePayoutData,
    /** The client's Idempotency-Key, already validated: same key -> the same payout, never a second (review M-6). */
    idempotencyKey?: string
  ) {
    // A store on its Durable Object (NEON-ZERO): the affiliate row, the debit, the payout and its event are ONE section there;
    // the balance is re-checked inside it, so the refusals are the same (404 / INVALID_AMOUNT / INSUFFICIENT_BALANCE).
    const money = await storeMoney(storeId);
    if (money) {
      if (data.amount <= 0) {
        throw new AppError(400, 'INVALID_AMOUNT', 'Payout amount must be greater than zero');
      }
      // keyed: the DO mints the id inside the section (an id minted here would differ per retry and the replay would refuse
      // it as a reused key); unkeyed: the id is minted here, as on Postgres
      const { payout } = await money.affiliatePayout(
        {
          affiliateId,
          amount: data.amount,
          method: data.method ?? 'manual',
          notes: data.notes ?? null,
          ...(idempotencyKey ? {} : { payoutId: randomUUID() }),
        },
        // a keyed section replays its first answer (the first payout), whatever this call's body says
        idempotencyKey ? opKey(`payout:${storeId}:${affiliateId}`, idempotencyKey) : undefined
      );
      logger.info(
        { storeId, affiliateId, payoutId: payout.id, amount: data.amount },
        '[AffiliateService] Payout created'
      );
      return payout;
    }
    const affiliate = await this.getById(storeId, affiliateId);

    if (data.amount <= 0) {
      throw new AppError(400, 'INVALID_AMOUNT', 'Payout amount must be greater than zero');
    }

    const pending = affiliate.pendingBalance;
    if (data.amount > pending) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Payout amount exceeds pending balance');
    }

    // On the request's tenant transaction (affiliate routes run under
    // tenantContext), not a second GUC-less `$transaction` — see
    // inAffiliateMoneyTx. The balance check above is a plain read, so the
    // debit re-checks it atomically: two concurrent payouts that each fit the
    // balance on their own cannot both be paid out of it.
    // Id minted here so the audit row in the same transaction names the payout.
    const payoutId = randomUUID();
    const method = data.method ?? 'manual';
    const payout = await inAffiliateMoneyTx(async db => {
      const debit = await db.affiliate.updateMany({
        where: { id: affiliateId, storeId, pendingBalance: { gte: data.amount } },
        data: {
          pendingBalance: { decrement: data.amount },
          totalPaid: { increment: data.amount },
        },
      });
      if (debit.count !== 1) {
        throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Payout amount exceeds pending balance');
      }
      const created = await db.affiliatePayout.create({
        data: {
          id: payoutId,
          storeId,
          affiliateId,
          amount: data.amount,
          method,
          status: 'pending',
          notes: data.notes,
        },
      });
      // Audit row in the same transaction as the debit (#1590).
      await affiliateEventCreate(
        {
          affiliateId,
          storeId,
          eventType: 'payout_initiated',
          details: { payoutId, amount: data.amount, method },
        },
        db
      );
      return created;
    });

    logger.info(
      { storeId, affiliateId, payoutId: payout.id, amount: data.amount },
      '[AffiliateService] Payout created'
    );

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
