/**
 * Affiliate Program Unit Tests
 *
 * Tests referral code generation, commission calculation,
 * status transitions, and payout validation using the
 * AffiliateService implementation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('@api/lib/store-operational', () => ({
  STORE_NOT_OPERATIONAL: 'STORE_NOT_OPERATIONAL',
  isStoreOperational: (s: unknown) => s === 'active',
  storeOperational: async () => true,
  storeMayMessageCustomers: async () => true,
  assertStoreOperational: async () => undefined,
  activeStoreIds: async () => ({ has: () => true }) as unknown as Set<string>,
  requireOperationalStore: (_q: unknown, _r: unknown, next: () => void) => next(),
}));
import { affiliateService } from '@api/services/affiliate.service';
import { prisma, withMoneyTx } from '@ebda/database';
import { AppError } from '@api/middleware/error-handler';

// ==========================================
// Mock prisma + dependencies
// ==========================================

vi.mock('@ebda/database', () => ({
  prisma: {
    affiliateConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    affiliate: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      aggregate: vi.fn(),
    },
    affiliateReferral: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    affiliatePayout: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    order: {
      findUnique: vi.fn(),
    },
    affiliateEvent: {
      create: vi.fn((args: unknown) => ({ __affiliateEventCreate: args })),
    },
    $transaction: vi.fn(),
  },
  Prisma: {},
  hasTenantContext: vi.fn(() => false),
  withMoneyTx: vi.fn((client: unknown, fn: (tx: unknown) => unknown) => fn(client)),
}));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isEnabled: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@api/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ==========================================
// Test Data
// ==========================================

const STORE_ID = 'store-test-123';

const mockConfig = {
  storeId: STORE_ID,
  defaultCommissionRate: 10,
  cookieDurationDays: 30,
  minPayoutAmount: 5000,
  autoApprove: false,
  publicSignupEnabled: true,
};

const mockAffiliate = {
  id: 'affiliate-1',
  storeId: STORE_ID,
  name: 'Jane Influencer',
  email: 'jane@example.com',
  referralCode: 'jane1234',
  status: 'pending',
  totalEarned: 0,
  pendingBalance: 0,
  totalPaid: 0,
  commissionRate: null,
  instagram: null,
  tiktok: null,
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  approvedAt: null,
  approvedBy: null,
  phone: null,
  _count: { referrals: 0, payouts: 0 },
};

// ==========================================
// Tests
// ==========================================

describe('AffiliateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: config returns mockConfig
    vi.mocked(prisma.affiliateConfig.findUnique).mockResolvedValue(mockConfig as any);
  });

  // ---- 1. Referral code uniqueness ----

  describe('referral code generation', () => {
    it('generates a unique code on each apply call', async () => {
      // First call: no duplicate found
      vi.mocked(prisma.affiliate.findUnique)
        .mockResolvedValueOnce(null) // code is unique
        .mockResolvedValueOnce(null); // duplicate email check passes

      vi.mocked(prisma.affiliate.create)
        .mockResolvedValueOnce({ ...mockAffiliate, referralCode: 'jane1111' } as any)
        .mockResolvedValueOnce({
          ...mockAffiliate,
          id: 'affiliate-2',
          email: 'bob@example.com',
          referralCode: 'bobx2222',
        } as any);

      const a1 = await affiliateService.apply(STORE_ID, {
        name: 'Jane',
        email: 'jane@example.com',
      });

      // Reset and apply again for a different affiliate
      vi.mocked(prisma.affiliate.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.affiliate.create).mockResolvedValue({
        ...mockAffiliate,
        id: 'affiliate-2',
        email: 'bob@example.com',
        referralCode: 'bobx2222',
      } as any);

      const a2 = await affiliateService.apply(STORE_ID, {
        name: 'Bob',
        email: 'bob@example.com',
      });

      expect(a1.referralCode).toBeDefined();
      expect(a2.referralCode).toBeDefined();
      expect(a1.referralCode).not.toBe(a2.referralCode);
    });
  });

  // ---- 2. Commission: 10% of 1000 piastres = 100 piastres ----

  describe('commission calculation', () => {
    it('calculates 10% commission on a 1000 piastres order', async () => {
      const referral = {
        id: 'ref-1',
        storeId: STORE_ID,
        affiliateId: 'affiliate-1',
        referralCode: 'jane1234',
        status: 'converted',
        commissionAmount: null,
        affiliate: { ...mockAffiliate, commissionRate: null },
      };

      const order = { id: 'order-1', storeId: STORE_ID, total: 1000 };

      vi.mocked(prisma.affiliateReferral.findFirst).mockResolvedValue(referral as any);
      vi.mocked(prisma.order.findUnique).mockResolvedValue(order as any);
      vi.mocked(prisma.affiliateReferral.updateMany).mockResolvedValue({ count: 1 } as any);

      const result = await affiliateService.processCommission(STORE_ID, 'order-1');

      expect(result).not.toBeNull();
      expect(result!.commissionAmount).toBe(100); // 10% of 1000
      expect(result!.rate).toBe(10);
    });

    // ---- 3. Custom commission rate overrides default ----

    it('uses affiliate-specific rate instead of default', async () => {
      const referral = {
        id: 'ref-2',
        storeId: STORE_ID,
        affiliateId: 'affiliate-2',
        referralCode: 'vip1234',
        status: 'converted',
        commissionAmount: null,
        affiliate: { ...mockAffiliate, commissionRate: 20 }, // custom 20%
      };

      const order = { id: 'order-2', storeId: STORE_ID, total: 1000 };

      vi.mocked(prisma.affiliateReferral.findFirst).mockResolvedValue(referral as any);
      vi.mocked(prisma.order.findUnique).mockResolvedValue(order as any);
      vi.mocked(prisma.affiliateReferral.updateMany).mockResolvedValue({ count: 1 } as any);

      const result = await affiliateService.processCommission(STORE_ID, 'order-2');

      expect(result!.commissionAmount).toBe(200); // 20% of 1000
      expect(result!.rate).toBe(20);
    });
  });

  // ---- 4. Status transitions ----

  describe('status transitions', () => {
    it('approves a pending affiliate', async () => {
      vi.mocked(prisma.affiliate.findFirst).mockResolvedValue({
        ...mockAffiliate,
        status: 'pending',
      } as any);
      vi.mocked(prisma.affiliate.update).mockResolvedValue({
        ...mockAffiliate,
        status: 'approved',
      } as any);

      const result = await affiliateService.approve(STORE_ID, 'affiliate-1', 'admin-1');

      expect(prisma.affiliate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'approved' }),
        })
      );
      expect(result.status).toBe('approved');
    });

    it('rejects a pending affiliate', async () => {
      vi.mocked(prisma.affiliate.findFirst).mockResolvedValue({
        ...mockAffiliate,
        status: 'pending',
      } as any);
      vi.mocked(prisma.affiliate.update).mockResolvedValue({
        ...mockAffiliate,
        status: 'rejected',
      } as any);

      const result = await affiliateService.reject(STORE_ID, 'affiliate-1', 'admin-1');

      expect(result.status).toBe('rejected');
    });

    it('suspends an approved affiliate', async () => {
      const approved = { ...mockAffiliate, status: 'approved' };
      vi.mocked(prisma.affiliate.findFirst).mockResolvedValue(approved as any);
      vi.mocked(prisma.affiliate.update).mockResolvedValue({
        ...approved,
        status: 'suspended',
      } as any);

      const result = await affiliateService.suspend(STORE_ID, 'affiliate-1', 'admin-1');

      expect(result.status).toBe('suspended');
    });
  });

  // ---- 5. Invalid transitions ----

  describe('invalid status transitions', () => {
    it('rejects approve when affiliate is already approved (not pending)', async () => {
      vi.mocked(prisma.affiliate.findFirst).mockResolvedValue({
        ...mockAffiliate,
        status: 'approved',
      } as any);

      await expect(affiliateService.approve(STORE_ID, 'affiliate-1', 'admin-1')).rejects.toThrow(
        'Only pending affiliates can be approved'
      );
    });

    it('rejects reject when affiliate is already rejected (not pending)', async () => {
      vi.mocked(prisma.affiliate.findFirst).mockResolvedValue({
        ...mockAffiliate,
        status: 'rejected',
      } as any);

      await expect(affiliateService.reject(STORE_ID, 'affiliate-1', 'admin-1')).rejects.toThrow(
        'Only pending affiliates can be rejected'
      );
    });
  });

  // ---- 6. Payout validation ----

  describe('payout validation', () => {
    it("throws INSUFFICIENT_BALANCE when amount exceeds affiliate's pending balance", async () => {
      const affiliate = { ...mockAffiliate, status: 'approved', pendingBalance: 500 };
      vi.mocked(prisma.affiliate.findFirst).mockResolvedValue(affiliate as any);

      await expect(
        affiliateService.createPayout(STORE_ID, 'affiliate-1', { amount: 1000 })
      ).rejects.toThrow('Payout amount exceeds pending balance');
    });

    it('creates a payout when amount is within pending balance', async () => {
      const affiliate = { ...mockAffiliate, status: 'approved', pendingBalance: 5000 };
      vi.mocked(prisma.affiliate.findFirst).mockResolvedValue(affiliate as any);

      const mockPayout = {
        id: 'payout-1',
        storeId: STORE_ID,
        affiliateId: 'affiliate-1',
        amount: 2000,
        method: 'bank_transfer',
        status: 'pending',
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.affiliate.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(prisma.affiliatePayout.create).mockResolvedValue(mockPayout as any);

      const result = await affiliateService.createPayout(STORE_ID, 'affiliate-1', {
        amount: 2000,
        method: 'bank_transfer',
      });

      expect(result).toEqual(mockPayout);
    });

    it('rejects a payout of zero or negative amount', async () => {
      const affiliate = { ...mockAffiliate, status: 'approved', pendingBalance: 5000 };
      vi.mocked(prisma.affiliate.findFirst).mockResolvedValue(affiliate as any);

      await expect(
        affiliateService.createPayout(STORE_ID, 'affiliate-1', { amount: 0 })
      ).rejects.toThrow('Payout amount must be greater than zero');
    });
  });

  // #1590 — the audit row for each affiliate MONEY movement is written on the
  // SAME transaction client as the balance change, so it commits (or rolls
  // back) with it instead of being queued after the request and dropped on a
  // 5xx. Outside a tenant context that client is withMoneyTx's own tx — an
  // audit row written on the bare client would commit on its own.
  describe('money movements write their audit row atomically', () => {
    function txClient() {
      const tx = {
        affiliate: {
          update: vi.fn(async () => ({})),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        affiliateReferral: { updateMany: vi.fn(async () => ({ count: 1 })) },
        affiliatePayout: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data })),
        },
        affiliateEvent: { create: vi.fn(async () => ({ id: 'evt-1' })) },
      };
      vi.mocked(withMoneyTx).mockImplementationOnce(((_c: unknown, fn: (t: unknown) => unknown) =>
        fn(tx)) as any);
      return tx;
    }
    const auditOn = (tx: ReturnType<typeof txClient>, eventType: string) =>
      (tx.affiliateEvent.create.mock.calls as unknown as [{ data: { eventType: string } }][]).find(
        ([args]) => args.data.eventType === eventType
      )?.[0];

    it('processCommission', async () => {
      vi.mocked(prisma.affiliateReferral.findFirst).mockResolvedValue({
        id: 'ref-1',
        affiliateId: 'affiliate-1',
        status: 'converted',
        commissionAmount: null,
        affiliate: { ...mockAffiliate, commissionRate: null },
      } as any);
      vi.mocked(prisma.order.findUnique).mockResolvedValue({ id: 'o', total: 1000 } as any);
      const tx = txClient();
      await affiliateService.processCommission(STORE_ID, 'o');
      expect(auditOn(tx, 'commission_recorded')).toBeDefined();
      expect(prisma.affiliateEvent.create).not.toHaveBeenCalled();
    });

    it('reverseCommission', async () => {
      vi.mocked(prisma.affiliateReferral.findFirst).mockResolvedValue({
        id: 'ref-1',
        affiliateId: 'affiliate-1',
        status: 'commission_paid',
        commissionAmount: 100,
      } as any);
      const tx = txClient();
      await affiliateService.reverseCommission(STORE_ID, 'o');
      expect(auditOn(tx, 'commission_reversed')).toBeDefined();
      expect(prisma.affiliateEvent.create).not.toHaveBeenCalled();
    });

    it('createPayout — the audit row names the payout it created', async () => {
      vi.mocked(prisma.affiliate.findFirst).mockResolvedValue({
        ...mockAffiliate,
        status: 'approved',
        pendingBalance: 5000,
      } as any);
      const tx = txClient();
      await affiliateService.createPayout(STORE_ID, 'affiliate-1', { amount: 1000 });
      const audit = auditOn(tx, 'payout_initiated') as
        | { data: { details: { payoutId: string } } }
        | undefined;
      expect(audit).toBeDefined();
      const payoutId = (tx.affiliatePayout.create.mock.calls[0] as any)[0].data.id;
      expect(payoutId).toEqual(expect.any(String));
      expect(audit!.data.details.payoutId).toBe(payoutId);
      expect(prisma.affiliateEvent.create).not.toHaveBeenCalled();
    });
  });
});
