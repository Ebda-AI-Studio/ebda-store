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
  previewChangePlan: vi.fn(),
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
  getPlan: vi.fn(),
  vat: { enabled: false, rate: 0, mode: 'exclusive' } as Record<string, unknown>,
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
  planService: { listPlans: async () => m.plans, getPlan: m.getPlan },
}));
vi.mock('@api/services/platform-vat.service', () => ({ getPlatformVat: async () => m.vat }));
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
  previewChangePlan: m.previewChangePlan,
  cancelSubscription: m.cancel,
  resumeSubscription: m.resume,
  listStoreCharges: m.charges,
  getSubscriptionBillingState: async () => m.billing,
}));
vi.mock('@api/services/staff-members.service', () => ({
  listStaffWithUsers: m.listStaff,
  removeStaffFromStore: m.removeStaff,
}));

import { applyThenUndo, roundTripCtx } from './helpers/undo-roundtrip';
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
  // no proration quote by default (the card falls back to the catalogue price); the G35 test below sets one
  m.previewChangePlan.mockRejectedValue(new Error('no quote'));
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
  m.vat = { enabled: false, rate: 0, mode: 'exclusive' };
  m.getPlan.mockImplementation(async (code: string) => m.plans.find(p => p.code === code));
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
      const price = d.rows.find(r => r.label.en.startsWith('Price ('))!;
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
    it('E1-PLAN-1: an upgrade never calls the charging service; apply returns the payment screen link', async () => {
      const t = tool('plan_change');
      const args = parse('plan_change', { planCode: 'growth' });
      const d = await t.preview!(ctx(), args);
      const r = await t.apply!(ctx(), args, d);
      expect(r.ok).toBe(true);
      expect(m.changePlan).not.toHaveBeenCalled();
      expect(r.result).toMatchObject({ charged: false, paymentScreen: '/stores/S1/billing' });
      expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({ actor: 'assistant' });
    });
    it('a downgrade stays a confirm card that calls changePlan and shows no charge', async () => {
      m.ent = { ...m.ent, planCode: 'growth', planNameEn: 'Growth', planNameAr: 'جروث' };
      const t = tool('plan_change');
      const args = parse('plan_change', { planCode: 'basic' });
      const d = await t.preview!(ctx(), args);
      expect(d.rows.some(r => r.label.en === 'Total in EGP')).toBe(false);
      m.changePlan.mockResolvedValue({ mode: 'scheduled' });
      await t.apply!(ctx(), args, d);
      expect(m.changePlan).toHaveBeenCalledWith({ storeId: 'S1', planCode: 'basic' });
    });
    it('the upgrade card shows net, VAT and total from the platform VAT (exclusive 14%)', async () => {
      m.vat = { enabled: true, rate: 14, mode: 'exclusive' };
      const d = await tool('plan_change').preview!(
        ctx(),
        parse('plan_change', { planCode: 'growth' })
      );
      const by = (en: string) => d.rows.find(r => r.label.en === en)!.after;
      expect([by('Price before VAT in EGP'), by('VAT in EGP'), by('Total in EGP')]).toEqual([
        '3490',
        '488.6',
        '3978.6',
      ]);
      expect(d.summary.en).toContain('3978.6');
    });
    it('G35-PRORATE-1: the upgrade card charges the prorated difference from the proration seam', async () => {
      m.previewChangePlan.mockResolvedValue({
        planCode: 'growth',
        interval: 'monthly',
        quote: {
          kind: 'upgrade',
          remainingDays: 12,
          periodDays: 30,
          charge: { totalMinor: 79600, netMinor: 69825, vatMinor: 9775, vat: null },
        },
      });
      const d = await tool('plan_change').preview!(
        ctx(),
        parse('plan_change', { planCode: 'growth' })
      );
      const by = (en: string) => d.rows.find(r => r.label.en === en)!.after;
      expect(by('Total in EGP')).toBe('796');
      expect(d.summary.en).toContain('796 EGP');
      expect(d.summary.en).toContain('days left');
      expect(m.previewChangePlan).toHaveBeenCalledWith({
        storeId: expect.any(String),
        planCode: 'growth',
      });
    });
    it('turning VAT on between the card and the press changes the etag (state fingerprint)', async () => {
      const args = parse('plan_change', { planCode: 'growth' });
      const a = await tool('plan_change').preview!(ctx(), args);
      m.vat = { enabled: true, rate: 14, mode: 'exclusive' };
      const b = await tool('plan_change').preview!(ctx(), args);
      expect(b.etag).not.toBe(a.etag);
    });
    it('the current plan price comes from the plan record, so a hidden plan is not 0', async () => {
      m.ent = { ...m.ent, planCode: 'legacy' };
      m.plans.push({
        code: 'legacy',
        nameAr: 'ق',
        nameEn: 'Legacy',
        priceMonthlyMinor: 500000,
        priceYearlyMinor: 5000000,
        limits: {},
      });
      const hidden = m.plans.pop()!;
      m.getPlan.mockImplementation(async (code: string) =>
        code === 'legacy' ? hidden : m.plans.find(p => p.code === code)
      );
      const d = await tool('plan_change').preview!(
        ctx(),
        parse('plan_change', { planCode: 'growth' })
      );
      expect(d.rows.find(r => r.label.en.startsWith('Price ('))!.before).toBe('5000');
      expect(d.rows.some(r => r.label.en === 'Total in EGP')).toBe(false); // 3490 < 5000: a downgrade
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
    it('an unverified e-mail is refused at PREVIEW, before any card', async () => {
      m.assertVerified.mockRejectedValueOnce(new Error('EMAIL_NOT_VERIFIED'));
      await expect(
        tool('store_go_live').preview!(ctx(), parse('store_go_live', {}))
      ).rejects.toThrow(/EMAIL_NOT_VERIFIED/);
    });
    it('an unverified e-mail at APPLY (changed after the card) stops it before goLive', async () => {
      const t = tool('store_go_live');
      const draft = await t.preview!(ctx(), parse('store_go_live', {}));
      m.assertVerified.mockRejectedValueOnce(new Error('EMAIL_NOT_VERIFIED'));
      await expect(t.apply!(ctx(), parse('store_go_live', {}), draft)).rejects.toThrow(
        /EMAIL_NOT_VERIFIED/
      );
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
    it('merchant_mcp_status reports the write switch and never lists or returns a key', async () => {
      const r = (await run('merchant_mcp_status')) as Record<string, unknown>;
      expect(r.writeEnabled).toBe(true);
      expect(JSON.stringify(r)).not.toMatch(/keyHash|prefix|ebdam_/);
      expect(m.keysFind).not.toHaveBeenCalled();
    });
  });

  describe('gates on every tool (each fails when its gate is removed)', () => {
    const argsFor: Record<string, unknown> = {
      plan_change: { planCode: 'growth' },
      subscription_cancel: {},
      subscription_resume: {},
      instapay_plan_choose: { planCode: 'growth', interval: 'monthly' },
      store_go_live: {},
      merchant_mcp_write_switch: { enabled: false },
      staff_remove: { email: 'sara@x.com' },
    };
    for (const [n, a] of Object.entries(argsFor)) {
      it(`${n}: staff is refused at PREVIEW (no card) and at APPLY (ToolForbidden); super admin too`, async () => {
        const t = tool(n);
        const args = parse(n, a);
        const draft = await t.preview!(ctx(), args);
        for (const role of ['staff', 'customer']) {
          await expect(t.preview!(ctx(role), args)).rejects.toBeInstanceOf(Error);
          await expect(t.apply!(ctx(role), args, draft)).rejects.toBeInstanceOf(ToolForbidden);
        }
        await expect(t.apply!(ctx('super_admin'), args, draft)).rejects.toBeInstanceOf(
          ToolForbidden
        );
        expect(
          m.changePlan.mock.calls.length + m.cancel.mock.calls.length + m.resume.mock.calls.length
        ).toBe(0);
        expect(m.chooseInstapayPlan).not.toHaveBeenCalled();
        expect(m.goLive).not.toHaveBeenCalled();
        expect(m.setMcp).not.toHaveBeenCalled();
        expect(m.removeStaff).not.toHaveBeenCalled();
      });
    }
    it('the plan feature gates: staff_accounts off refuses staff_remove, merchant_mcp off refuses the MCP switch (preview and apply)', async () => {
      m.featureEnabled.mockImplementation(
        async (_s: string, k: string) => k !== 'staff_accounts' && k !== 'merchant_mcp'
      );
      for (const [n, a] of [
        ['staff_remove', { email: 'sara@x.com' }],
        ['merchant_mcp_write_switch', { enabled: false }],
      ] as const) {
        const t = tool(n);
        await expect(t.preview!(ctx(), parse(n, a))).rejects.toBeInstanceOf(Error);
        await expect(t.apply!(ctx(), parse(n, a), {} as never)).rejects.toBeInstanceOf(
          ToolForbidden
        );
      }
      expect(m.removeStaff).not.toHaveBeenCalled();
      expect(m.setMcp).not.toHaveBeenCalled();
    });
    it('merchant_mcp_status needs the merchant_mcp feature', async () => {
      m.featureEnabled.mockResolvedValue(false);
      await expect(
        (
          tool('merchant_mcp_status') as { read: (c: TurnCtx, a: unknown) => Promise<unknown> }
        ).read(ctx(), {})
      ).rejects.toThrow();
      expect(m.keysFind).not.toHaveBeenCalled();
    });
    it('instapay_plan_choose shows the VAT amount from the platform VAT', async () => {
      m.vat = { enabled: true, rate: 14, mode: 'exclusive' };
      const d = await tool('instapay_plan_choose').preview!(
        ctx(),
        parse('instapay_plan_choose', { planCode: 'growth', interval: 'monthly' })
      );
      expect(d.rows.find(r => r.label.en === 'VAT in EGP')!.after).toBe('488.6');
      expect(d.summary.en).toContain('3978.6');
    });
  });

  describe('undo at the engine level', () => {
    it('merchant_mcp_write_switch: undo args pass the tool own validation and the undo needs a confirm card', async () => {
      const t = tool('merchant_mcp_write_switch');
      const r = await applyThenUndo(accountBillingTools(), t, { enabled: false }, roundTripCtx());
      expect(r.applied).toBe('applied');
      expect(r.undo).toBe('undone');
      const args = parse('merchant_mcp_write_switch', { enabled: false });
      const d = await t.preview!(ctx(), args);
      const inv = t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })!;
      expect(t.args.safeParse(inv.args).success).toBe(true);
    });
  });
});
