/** Phase E1 assistant tools: billing, onboarding go-live, merchant MCP switch, staff removal and the owner reads. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ToolForbidden,
  effectivePolicy,
  type TurnCtx,
  type ToolSpec,
} from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  changePlan: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  chooseInstapayPlan: vi.fn(),
  goLive: vi.fn(),
  assertVerified: vi.fn(),
  setMcp: vi.fn(),
  getStore: vi.fn(),
  listStaff: vi.fn(),
  removeStaff: vi.fn(),
  storeFind: vi.fn(),
  methodCount: vi.fn(),
  keysFind: vi.fn(),
  storeList: vi.fn(),
  charges: vi.fn(),
  features: vi.fn(),
  plans: [] as Array<Record<string, unknown>>,
  ent: {} as Record<string, unknown>,
  billing: {} as Record<string, unknown>,
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled, getStoreFeatures: m.features },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    store: { findUnique: m.storeFind },
    paymentConfig: { count: m.methodCount },
  }),
}));
vi.mock('@ebda/database', () => ({
  prisma: { merchantApiKey: { findMany: m.keysFind } },
  withUser: async (_u: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/smart-layer/merchant-read', () => ({
  ReadForbidden: class extends Error {},
  callMerchantRead: vi.fn(),
}));
vi.mock('@api/services/setup-guide.service', () => ({ SetupGuideService: {} }));
vi.mock('@api/services/plan.service', () => ({
  planService: { listPlans: async () => m.plans },
}));
vi.mock('@api/services/plan-limit.service', () => ({
  getUsageSummary: async () => ({ entitlements: m.ent, usage: { maxStaff: 1 } }),
}));
vi.mock('@api/services/store.service', () => ({
  StoreService: { getById: m.getStore, setMcpWriteEnabled: m.setMcp, list: m.storeList },
}));
vi.mock('@api/services/onboarding.service', () => ({ OnboardingService: { goLive: m.goLive } }));
vi.mock('@api/middleware/require-verified-email', () => ({
  assertVerifiedEmail: m.assertVerified,
}));
vi.mock('@api/services/billing/account.service', () => ({
  chooseInstapayPlan: m.chooseInstapayPlan,
}));
vi.mock('@api/services/billing/subscription-billing.service', () => ({
  changePlan: m.changePlan,
  cancelSubscription: m.cancel,
  resumeSubscription: m.resume,
  listStoreCharges: m.charges,
  getSubscriptionBillingState: async () => m.billing,
}));
vi.mock('@api/services/staff-members.service', () => ({
  listStaffWithUsers: m.listStaff,
  removeStaffFromStore: m.removeStaff,
}));

import { accountBillingTools } from '@api/smart-layer/tools/account-billing.tools';

const ctx = (role = 'store_admin'): TurnCtx => ({
  product: 'store',
  storeId: 'S1',
  userId: 'u1',
  role,
  locale: 'ar',
  now: 1_800_000_000_000,
  conversationId: 'c1',
  releaseId: 'r',
});
const tool = (n: string): ToolSpec => accountBillingTools().find(t => t.name === n)!;
const parse = (n: string, a: unknown) => tool(n).args.parse(a) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.plans = [
    {
      code: 'basic',
      nameAr: 'بيزيك',
      nameEn: 'Basic',
      priceMonthlyMinor: 149000,
      priceYearlyMinor: 1490000,
      limits: { maxStaff: 2, maxProducts: 100 },
    },
    {
      code: 'growth',
      nameAr: 'جروث',
      nameEn: 'Growth',
      priceMonthlyMinor: 349000,
      priceYearlyMinor: 3490000,
      limits: { maxStaff: 5, maxProducts: 1000 },
    },
  ];
  m.ent = {
    planCode: 'basic',
    planNameAr: 'بيزيك',
    planNameEn: 'Basic',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
    limits: { maxStaff: 2, maxProducts: 100 },
  };
  m.billing = {
    billingInterval: 'monthly',
    pendingPlanCode: null,
    hasPaymentMethod: true,
    billingMethod: 'card',
    overdue: false,
    instapay: { available: true, reference: 'EB-1', amountMinor: 100, pendingClaims: 0 },
  };
  m.getStore.mockResolvedValue({ settings: {} });
  m.storeFind.mockResolvedValue({ status: 'inactive', name: 'متجري', slug: 'mine' });
  m.methodCount.mockResolvedValue(1);
  m.listStaff.mockResolvedValue([
    {
      id: 'ss1',
      createdAt: new Date('2026-10-01'),
      user: { id: 'U9', email: 'Sara@x.com', firstName: 'Sara', lastName: 'A' },
    },
  ]);
});

describe('account + billing tools', () => {
  it('no secret, key or store id is accepted or exposed', () => {
    for (const t of accountBillingTools()) {
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id|password|apiKey|secret|token/i);
      expect(t.args.safeParse({ storeId: 'x', planCode: 'p', interval: 'monthly' }).success).toBe(
        false
      );
    }
  });

  describe('plan_change', () => {
    it('is confirm, money, irreversible with no inverse; the price comes from the catalogue', async () => {
      const t = tool('plan_change');
      expect(t.policy).toBe('confirm');
      expect(t.inverse).toBeUndefined();
      const args = parse('plan_change', { planCode: 'growth' });
      const d = await t.preview!(ctx(), args);
      const price = d.rows.find(r => r.label.en.startsWith('Price'))!;
      expect([price.before, price.after]).toEqual(['1490', '3490']);
      expect(d.rows.some(r => r.label.en === 'Limit: maxStaff')).toBe(true);
      expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
      const eff = effectivePolicy(t, d, {
        cap: { policy: 'confirm', undo: 'irreversible' },
      } as never);
      expect(JSON.stringify(eff)).toMatch(/money/);
    });
    it('an unknown plan never gets a card', async () => {
      await expect(
        tool('plan_change').preview!(ctx(), parse('plan_change', { planCode: 'nope' }))
      ).rejects.toThrow(/no plan/i);
    });
    it('apply runs as the assistant through changePlan; staff are refused', async () => {
      const t = tool('plan_change');
      const args = parse('plan_change', { planCode: 'growth' });
      m.changePlan.mockResolvedValue({ mode: 'upgraded' });
      expect((await t.apply!(ctx(), args, await t.preview!(ctx(), args))).ok).toBe(true);
      expect(m.changePlan).toHaveBeenCalledWith({ storeId: 'S1', planCode: 'growth' });
      expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({ actor: 'assistant' });
      await expect(t.apply!(ctx('staff'), args, {} as never)).rejects.toBeInstanceOf(ToolForbidden);
      await expect(t.apply!(ctx('super_admin'), args, {} as never)).rejects.toBeInstanceOf(
        ToolForbidden
      );
      expect(m.changePlan).toHaveBeenCalledTimes(1);
    });
  });

  it('cancel / resume are confirm + money and call the billing service', async () => {
    for (const [n, fn] of [
      ['subscription_cancel', m.cancel],
      ['subscription_resume', m.resume],
    ] as const) {
      const t = tool(n);
      expect(t.policy).toBe('confirm');
      expect(t.money).toBe(true);
      expect(t.inverse).toBeUndefined();
      const d = await t.preview!(ctx(), parse(n, {}));
      expect(d.rows.length).toBeGreaterThan(0);
      fn.mockResolvedValue({});
      await t.apply!(ctx(), parse(n, {}), d);
      expect(fn).toHaveBeenCalledWith({ storeId: 'S1' });
      await expect(t.apply!(ctx('staff'), parse(n, {}), d)).rejects.toBeInstanceOf(ToolForbidden);
    }
  });

  describe('instapay_plan_choose', () => {
    it('shows the catalogue price, starts the payment and returns the billing screen for the receipt', async () => {
      const t = tool('instapay_plan_choose');
      expect(t.policy).toBe('confirm');
      const args = parse('instapay_plan_choose', { planCode: 'growth', interval: 'yearly' });
      const d = await t.preview!(ctx(), args);
      expect(d.rows.find(r => r.label.en.startsWith('Price'))!.after).toBe('34900');
      m.chooseInstapayPlan.mockResolvedValue({ reference: 'EB-9' });
      const r = await t.apply!(ctx(), args, d);
      expect(m.chooseInstapayPlan).toHaveBeenCalledWith({
        storeId: 'S1',
        planCode: 'growth',
        interval: 'yearly',
      });
      expect(r.result).toMatchObject({
        instapay: { reference: 'EB-9' },
        uploadReceiptAt: '/stores/S1/billing',
      });
      expect(t.args.safeParse({ planCode: 'growth', interval: 'yearly', amount: 1 }).success).toBe(
        false
      );
    });
  });

  describe('store_go_live', () => {
    it('previews status inactive -> active, flags checkout, checks the verified e-mail at apply', async () => {
      const t = tool('store_go_live');
      expect(t.policy).toBe('confirm');
      const d = await t.preview!(ctx(), parse('store_go_live', {}));
      expect(d.rows[0]).toMatchObject({ before: 'inactive', after: 'active' });
      expect(d.touchesCheckout).toBe(true);
      m.goLive.mockResolvedValue({ id: 'S1' });
      await t.apply!(ctx(), parse('store_go_live', {}), d);
      expect(m.assertVerified).toHaveBeenCalledWith({ userId: 'u1', role: 'store_admin' });
      expect(m.goLive).toHaveBeenCalledWith('S1');
    });
    it('an unverified e-mail stops it before goLive', async () => {
      m.assertVerified.mockRejectedValueOnce(new Error('EMAIL_NOT_VERIFIED'));
      const t = tool('store_go_live');
      await expect(
        t.apply!(
          ctx(),
          parse('store_go_live', {}),
          await t.preview!(ctx(), parse('store_go_live', {}))
        )
      ).rejects.toThrow(/EMAIL_NOT_VERIFIED/);
      expect(m.goLive).not.toHaveBeenCalled();
    });
  });

  describe('merchant_mcp_write_switch', () => {
    it('toggles the non-secret switch, needs the merchant_mcp feature, and the inverse restores it', async () => {
      const t = tool('merchant_mcp_write_switch');
      expect(t.policy).toBe('confirm');
      expect(t.undo).toBe('reversible');
      const args = parse('merchant_mcp_write_switch', { enabled: false });
      const d = await t.preview!(ctx(), args);
      expect(d.rows[0]).toMatchObject({ before: true, after: false });
      m.setMcp.mockResolvedValue(false);
      await t.apply!(ctx(), args, d);
      expect(m.setMcp).toHaveBeenCalledWith('S1', false);
      expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
        tool: 'merchant_mcp_write_switch',
        args: { enabled: true },
      });
      m.featureEnabled.mockResolvedValue(false);
      await expect(t.apply!(ctx(), args, d)).rejects.toBeInstanceOf(ToolForbidden);
    });
  });

  describe('staff_remove', () => {
    it('is confirm + deletes, irreversible; resolves the member by e-mail in THIS store', async () => {
      const t = tool('staff_remove');
      expect(t.policy).toBe('confirm');
      expect(t.deletes).toBe(true);
      expect(t.inverse).toBeUndefined();
      const args = parse('staff_remove', { email: ' sara@x.com ' });
      const d = await t.preview!(ctx(), args);
      expect(d.rows[0].before).toContain('Sara');
      m.removeStaff.mockResolvedValue({ membershipId: 'ss1' });
      await t.apply!(ctx(), args, d);
      expect(m.listStaff).toHaveBeenCalledWith('S1');
      expect(m.removeStaff).toHaveBeenCalledWith('S1', 'U9');
    });
    it('an e-mail that is not on this store never reaches run', async () => {
      const t = tool('staff_remove');
      const args = parse('staff_remove', { email: 'other@y.com' });
      await expect(t.preview!(ctx(), args)).rejects.toThrow(/no staff member/i);
      await expect(t.apply!(ctx(), args, {} as never)).rejects.toThrow();
      expect(m.removeStaff).not.toHaveBeenCalled();
    });
    it('staff cannot remove staff', async () => {
      const t = tool('staff_remove');
      await expect(
        t.apply!(ctx('staff'), parse('staff_remove', { email: 'sara@x.com' }), {} as never)
      ).rejects.toBeInstanceOf(ToolForbidden);
    });
  });

  describe('owner reads', () => {
    const run = (n: string, c = ctx()) =>
      (tool(n) as { read: (c: TurnCtx, a: unknown) => Promise<unknown> }).read(c, {});
    it('are free, read-only and refuse a role without the owner permission', async () => {
      for (const n of [
        'billing_overview',
        'billing_invoices',
        'list_my_stores',
        'merchant_mcp_status',
      ]) {
        expect(tool(n).policy).toBe('free');
        await expect(run(n, ctx('staff'))).rejects.toThrow();
      }
    });
    it('billing_overview reports plan, usage and InstaPay state in EGP', async () => {
      expect(await run('billing_overview')).toMatchObject({
        plan: { code: 'basic' },
        billing: { instapay: { amountEgp: '1' } },
      });
    });
    it('billing_invoices reads this store charges', async () => {
      m.charges.mockResolvedValue([{ id: 'c1' }]);
      expect(await run('billing_invoices')).toEqual([{ id: 'c1' }]);
      expect(m.charges).toHaveBeenCalledWith('S1', 10);
    });
    it('my_features lists enabled and disabled keys for any store member', async () => {
      m.features.mockResolvedValue({ coupons: true, wallet: false });
      expect(await run('my_features', ctx('staff'))).toMatchObject({
        enabled: ['coupons'],
        disabled: ['wallet'],
      });
    });
    it('list_my_stores lists the owner stores', async () => {
      m.storeList.mockResolvedValue({
        meta: { total: 1 },
        stores: [{ id: 'S1', name: 'n', slug: 's', status: 'active', _count: { products: 2 } }],
      });
      await run('list_my_stores');
      expect(m.storeList).toHaveBeenCalledWith({ ownerId: 'u1', page: 1, limit: 10 });
    });
    it('merchant_mcp_status never selects the key hash', async () => {
      m.keysFind.mockResolvedValue([{ id: 'k1', name: 'laptop', prefix: 'mk_ab' }]);
      const r = (await run('merchant_mcp_status')) as { writeEnabled: boolean };
      expect(r.writeEnabled).toBe(true);
      expect(m.keysFind.mock.calls[0][0].select.keyHash).toBeUndefined();
      expect(m.keysFind.mock.calls[0][0].where).toEqual({ storeId: 'S1' });
    });
  });
});
