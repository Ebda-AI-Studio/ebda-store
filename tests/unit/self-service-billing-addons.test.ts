/**
 * SELF-SERVICE gaps A8 + A9 (money, risky): a store owner buys an add-on or an AI top-up pack with a card, the
 * entitlement is granted exactly once per payment, a failed payment grants nothing, cancel ends it at the period end,
 * staff are refused, and the confirm step is a single-use token bound to the previewed payload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  claimEvent: vi.fn(),
  markFailed: vi.fn(),
  assertPayable: vi.fn(),
  chargeFor: vi.fn(),
  createCheckout: vi.fn(),
  events: [] as Array<Record<string, any>>,
  storeRow: {
    name: 'Shop',
    plan: 'starter',
    settings: {},
    owner: { email: 'm@x.test', firstName: 'M' },
  } as any,
  sub: null as any,
  features: {} as Record<string, boolean>,
  countAiUsage: vi.fn(),
  aiStoreToday: vi.fn(),
  alert: vi.fn(),
}));

vi.mock('@api/services/billing/subscription-billing.service', () => ({
  claimEvent: h.claimEvent,
  markFailedUnlessSettled: h.markFailed,
  settleCharge: vi.fn(),
  chargeAndSettle: vi.fn(),
}));
vi.mock('@api/services/billing/account.service', () => ({
  assertPayableStore: h.assertPayable,
  isBillableStoreId: async () => true,
}));
vi.mock('@api/services/billing/charge-amount', () => ({ chargeFor: h.chargeFor }));
vi.mock('@api/services/billing/index', () => ({
  getBillingProvider: () => ({ name: 'kashier', createCheckoutForSubscription: h.createCheckout }),
  resolveTrialCardMode: () => 'card_on_file',
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async (_s: string, k: string) => h.features[k] === true },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.alert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ countAiUsage: h.countAiUsage }));
vi.mock('@api/lib/ai/gemini-keys', () => ({ geminiKeyCount: () => 1 }));
vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  assertStoreAiEnabled: async () => undefined,
}));
vi.mock('@api/lib/money-idempotency', () => ({
  idempotencyKeyOf: (v?: string) => v,
  withIdempotencyKey: async (_s: string, key: string | undefined, fn: () => Promise<unknown>) => {
    if (!key) {
      const { AppError } = await import('@api/middleware/error-handler');
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'needs a key');
    }
    return { replayed: false, value: await fn() };
  },
}));
vi.mock('@api/config', () => ({
  config: {
    adminUrl: 'https://admin.test',
    apiUrl: 'https://api.test',
    encryptionKey: 'a'.repeat(64),
  },
}));

const fakeTx = () => ({
  billingEvent: {
    findMany: async ({ where }: any) =>
      h.events.filter(
        e =>
          e.storeId === where.storeId &&
          e.status === 'succeeded' &&
          (!where.forPeriodEnd?.gt || e.forPeriodEnd > where.forPeriodEnd.gt) &&
          (!where.planCode ||
            (where.planCode.startsWith
              ? e.planCode.startsWith(where.planCode.startsWith)
              : e.planCode === where.planCode))
      ),
    findFirst: async ({ where }: any) =>
      h.events
        .filter(
          e =>
            e.storeId === where.storeId &&
            (where.planCode === undefined ||
              (typeof where.planCode === 'string'
                ? e.planCode === where.planCode
                : e.planCode.startsWith(where.planCode.startsWith))) &&
            (where.status === undefined || e.status === where.status) &&
            (where.relatedEventId === undefined || e.relatedEventId === where.relatedEventId) &&
            (where.idempotencyKey === undefined || e.idempotencyKey === where.idempotencyKey) &&
            e.id !== where.id?.not &&
            (where.forPeriodEnd?.gt === undefined || e.forPeriodEnd > where.forPeriodEnd.gt)
        )
        .sort((a, b) => b.forPeriodEnd - a.forPeriodEnd)[0] ?? null,
    createMany: vi.fn(async () => ({ count: 1 })),
    updateMany: vi.fn(async () => ({ count: 1 })),
    create: vi.fn(async () => ({})),
  },
  manualPaymentClaim: { count: async () => 0 },
  store: { findUnique: async () => h.storeRow },
  storeSubscription: { findUnique: async () => h.sub },
  storeFeature: {
    findFirst: vi.fn(async () => null),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
});
let tx = fakeTx();
vi.mock('@ebda/database', () => ({
  prisma: { aiUsage: { count: (...a: unknown[]) => h.aiStoreToday(...a) } },
  withStore: async (_id: string, fn: (t: unknown) => unknown) => fn(tx),
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
}));

const NOW = new Date('2026-11-14T10:00:00.000Z');
const DAY = 86_400_000;
const ev = (over: Record<string, any>) => ({
  id: 'e0',
  storeId: 's1',
  type: 'upgrade',
  status: 'succeeded',
  planCode: 'addon:feature:floating_widget',
  forPeriodEnd: new Date(NOW.getTime() + 10 * DAY),
  raw: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.events = [];
  h.features = {};
  h.sub = { status: 'active', providerPaymentMethodRef: 'tok' };
  h.chargeFor.mockResolvedValue({ totalMinor: 9900, netMinor: 9900, vatMinor: 0, vat: null });
  h.claimEvent.mockResolvedValue('11111111-1111-4111-8111-111111111111');
  h.createCheckout.mockResolvedValue({
    redirectUrl: 'https://pay.test/x',
    providerSessionId: 'ps',
  });
  h.assertPayable.mockResolvedValue(undefined);
  h.countAiUsage.mockResolvedValue(0);
  h.aiStoreToday.mockResolvedValue(0);
  tx = fakeTx();
});

describe('catalog', () => {
  it('feature add-ons are real, visible Business-baseline registry keys with integer positive prices', async () => {
    const { ADDON_CATALOG } = await import('@api/services/billing/addon-catalog');
    const { FEATURE_REGISTRY, PLAN_BASELINE } = await import('@ebda/shared');
    for (const a of Object.values(ADDON_CATALOG)) {
      expect(Number.isSafeInteger(a.priceMinor) && a.priceMinor > 0).toBe(true);
      if (a.kind === 'feature') {
        const def = (FEATURE_REGISTRY as any)[a.featureKey!];
        expect(PLAN_BASELINE.enterprise).toContain(a.featureKey);
        expect(def?.hidden).not.toBe(true);
      }
    }
  });
  it('plan codes round-trip and a plan code is never an add-on', async () => {
    const { skuOfPlanCode, planCodeOfSku } = await import('@api/services/billing/addon-catalog');
    expect(skuOfPlanCode(planCodeOfSku('feature:floating_widget'))).toBe('feature:floating_widget');
    expect(skuOfPlanCode('growth')).toBeNull();
    expect(skuOfPlanCode('addon:feature:nope')).toBeNull();
  });
});

describe('grant: exactly the term paid for, stacked, never invented', () => {
  it('a first payment grants 30 days from now and tells the feature cache to drop', async () => {
    const { applyAddonGrant } = await import('@api/services/billing/addon-grant');
    const effects: any[] = [];
    await applyAddonGrant(
      tx as any,
      { id: 'e1', storeId: 's1', planCode: 'addon:feature:floating_widget' } as any,
      NOW,
      effects
    );
    const call = (tx.billingEvent.updateMany as any).mock.calls[0][0];
    expect(call.data.forPeriodEnd).toEqual(new Date(NOW.getTime() + 30 * DAY));
    expect(call.where).toMatchObject({ id: 'e1', storeId: 's1' });
    expect(effects).toEqual([{ kind: 'addon_granted', storeId: 's1' }]);
  });
  it('a second payment while a term is running starts where the first ends', async () => {
    const { applyAddonGrant } = await import('@api/services/billing/addon-grant');
    h.events = [ev({ id: 'e0' })];
    await applyAddonGrant(
      tx as any,
      { id: 'e1', storeId: 's1', planCode: 'addon:feature:floating_widget' } as any,
      NOW,
      []
    );
    const call = (tx.billingEvent.updateMany as any).mock.calls[0][0];
    expect(call.data.forPeriodEnd).toEqual(new Date(NOW.getTime() + 40 * DAY));
  });
  it('an unknown add-on code grants nothing and asks for the money back', async () => {
    const { applyAddonGrant } = await import('@api/services/billing/addon-grant');
    const effects: any[] = [];
    await applyAddonGrant(
      tx as any,
      { id: 'e1', storeId: 's1', planCode: 'addon:feature:gone' } as any,
      NOW,
      effects
    );
    expect(tx.billingEvent.updateMany).not.toHaveBeenCalled();
    expect(effects).toEqual([{ kind: 'addon_unapplied', storeId: 's1', billingEventId: 'e1' }]);
  });
  it('a failing grant write is not swallowed (the payment transaction rolls back and is retried)', async () => {
    const { applyAddonGrant } = await import('@api/services/billing/addon-grant');
    (tx.billingEvent.updateMany as any).mockRejectedValueOnce(new Error('db down'));
    await expect(
      applyAddonGrant(
        tx as any,
        { id: 'e1', storeId: 's1', planCode: 'addon:feature:floating_widget' } as any,
        NOW,
        []
      )
    ).rejects.toThrow('db down');
  });
});

describe('entitlement read: only a succeeded, unexpired, unrefunded payment counts', () => {
  it('lists active sku terms and ignores expired ones', async () => {
    const { activeAddons } = await import('@api/services/billing/addon-grant');
    h.events = [
      ev({ id: 'a' }),
      ev({
        id: 'b',
        planCode: 'addon:feature:customer_wallet_checkout',
        forPeriodEnd: new Date(NOW.getTime() - DAY),
      }),
    ];
    const out = await activeAddons(tx as any, 's1', NOW);
    expect(out.map(a => a.sku)).toEqual(['feature:floating_widget']);
  });
});

describe('purchase: confirm token, idempotency, ledger row', () => {
  const ctx = { storeId: 's1', userId: 'u1' };
  it('preview quotes the integer total and mints a token; no row, no provider call', async () => {
    const { previewAddon } = await import('@api/services/billing/addons.service');
    const p = await previewAddon({ ...ctx, sku: 'feature:floating_widget' });
    expect(p.totalMinor).toBe(9900);
    expect(typeof p.confirmToken).toBe('string');
    expect(h.claimEvent).not.toHaveBeenCalled();
    expect(h.createCheckout).not.toHaveBeenCalled();
  });
  it('an InstaPay payment already waiting for approval blocks a second purchase of the same add-on', async () => {
    const { previewAddon } = await import('@api/services/billing/addons.service');
    (tx as any).manualPaymentClaim.count = async () => 1;
    await expect(previewAddon({ ...ctx, sku: 'feature:floating_widget' })).rejects.toMatchObject({
      code: 'ADDON_AWAITING_CONFIRMATION',
    });
    expect(h.claimEvent).not.toHaveBeenCalled();
  });
  it('checkout without a token charges nothing', async () => {
    const { purchaseAddon } = await import('@api/services/billing/addons.service');
    await expect(
      purchaseAddon({
        ...ctx,
        sku: 'feature:floating_widget',
        confirmToken: undefined,
        idempotencyKey: 'k-1234567',
      })
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(h.claimEvent).not.toHaveBeenCalled();
  });
  it('a token minted for another add-on, another store or another user is refused', async () => {
    const { previewAddon, purchaseAddon } = await import('@api/services/billing/addons.service');
    const p = await previewAddon({ ...ctx, sku: 'feature:floating_widget' });
    await expect(
      purchaseAddon({
        ...ctx,
        sku: 'feature:customer_wallet_checkout',
        confirmToken: p.confirmToken,
        idempotencyKey: 'k-1234567',
      })
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      purchaseAddon({
        storeId: 's2',
        userId: 'u1',
        sku: 'feature:floating_widget',
        confirmToken: p.confirmToken,
        idempotencyKey: 'k-1234567',
      })
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      purchaseAddon({
        storeId: 's1',
        userId: 'u2',
        sku: 'feature:floating_widget',
        confirmToken: p.confirmToken,
        idempotencyKey: 'k-1234567',
      })
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(h.claimEvent).not.toHaveBeenCalled();
  });
  it('a price that moved after the preview invalidates the token', async () => {
    const { previewAddon, purchaseAddon } = await import('@api/services/billing/addons.service');
    const p = await previewAddon({ ...ctx, sku: 'feature:floating_widget' });
    h.chargeFor.mockResolvedValue({ totalMinor: 11286, netMinor: 9900, vatMinor: 1386, vat: {} });
    await expect(
      purchaseAddon({
        ...ctx,
        sku: 'feature:floating_widget',
        confirmToken: p.confirmToken,
        idempotencyKey: 'k-1234567',
      })
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(h.createCheckout).not.toHaveBeenCalled();
  });
  it('a confirmed purchase writes ONE pending ledger row (integer piastres, idempotency key) and opens the hosted card page', async () => {
    const { previewAddon, purchaseAddon } = await import('@api/services/billing/addons.service');
    const p = await previewAddon({ ...ctx, sku: 'feature:floating_widget' });
    const out = await purchaseAddon({
      ...ctx,
      sku: 'feature:floating_widget',
      confirmToken: p.confirmToken,
      idempotencyKey: 'k-1234567',
    });
    expect(out.redirectUrl).toBe('https://pay.test/x');
    expect(h.claimEvent).toHaveBeenCalledTimes(1);
    const claim = h.claimEvent.mock.calls[0][0];
    expect(claim).toMatchObject({
      storeId: 's1',
      type: 'upgrade',
      planCode: 'addon:feature:floating_widget',
      amountMinor: 9900,
    });
    expect(claim.idempotencyKey).toContain('k-1234567');
    expect(Number.isInteger(claim.amountMinor)).toBe(true);
    expect(h.createCheckout.mock.calls[0][0]).toMatchObject({
      amountMinor: 9900,
      merchantOrderId: '11111111-1111-4111-8111-111111111111',
    });
  });
  it('the same token cannot be used twice', async () => {
    const { previewAddon, purchaseAddon } = await import('@api/services/billing/addons.service');
    const p = await previewAddon({ ...ctx, sku: 'feature:floating_widget' });
    const args = {
      ...ctx,
      sku: 'feature:floating_widget',
      confirmToken: p.confirmToken,
      idempotencyKey: 'k-1234567',
    };
    await purchaseAddon(args);
    await expect(purchaseAddon({ ...args, idempotencyKey: 'k-7654321' })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    expect(h.claimEvent).toHaveBeenCalledTimes(1);
  });
  it('an add-on the plan already includes is not sold twice', async () => {
    const { previewAddon } = await import('@api/services/billing/addons.service');
    h.features['floating_widget'] = true;
    await expect(previewAddon({ ...ctx, sku: 'feature:floating_widget' })).rejects.toMatchObject({
      code: 'ALREADY_INCLUDED',
    });
  });
  it('a provider failure marks the row failed and grants nothing', async () => {
    const { previewAddon, purchaseAddon } = await import('@api/services/billing/addons.service');
    h.createCheckout.mockRejectedValue(new Error('gateway down'));
    const p = await previewAddon({ ...ctx, sku: 'feature:floating_widget' });
    await expect(
      purchaseAddon({
        ...ctx,
        sku: 'feature:floating_widget',
        confirmToken: p.confirmToken,
        idempotencyKey: 'k-1234567',
      })
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(h.markFailed).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.stringContaining('checkout_error')
    );
  });
  it('an unknown sku is a 404 before any quote', async () => {
    const { previewAddon } = await import('@api/services/billing/addons.service');
    await expect(previewAddon({ ...ctx, sku: 'feature:nope' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('cancel at period end', () => {
  it('cancel keeps access until the paid term ends (the ledger row itself is covered in the review test)', async () => {
    const { cancelAddon } = await import('@api/services/billing/addons.service');
    h.events = [ev({ id: 'e0' })];
    const out = await cancelAddon({ storeId: 's1', sku: 'feature:floating_widget' });
    expect(out.effectiveAt).toEqual(h.events[0].forPeriodEnd);
  });
  it('nothing running -> 409, an AI pack has no renewal to cancel', async () => {
    const { cancelAddon } = await import('@api/services/billing/addons.service');
    await expect(
      cancelAddon({ storeId: 's1', sku: 'feature:floating_widget' })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(cancelAddon({ storeId: 's1', sku: 'ai:topup_300' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('A9 AI top-up raises the STORE cap only; platform caps still apply', () => {
  it('the store daily cap is refused at 150 with no pack, allowed with a running +300 pack', async () => {
    const { assertAiQuota } = await import('@api/lib/ai-quota');
    h.aiStoreToday.mockResolvedValue(150);
    await expect(assertAiQuota({ storeId: 's1' })).rejects.toMatchObject({
      code: 'AI_QUOTA_STORE_DAILY_EXCEEDED',
    });
    h.events = [
      ev({ planCode: 'addon:ai:topup_300', forPeriodEnd: new Date(Date.now() + 10 * DAY) }),
    ];
    await expect(assertAiQuota({ storeId: 's1' })).resolves.toBeUndefined();
  });
  it('an expired pack raises nothing', async () => {
    const { assertAiQuota } = await import('@api/lib/ai-quota');
    h.aiStoreToday.mockResolvedValue(150);
    h.events = [ev({ planCode: 'addon:ai:topup_300', forPeriodEnd: new Date(Date.now() - DAY) })];
    await expect(assertAiQuota({ storeId: 's1' })).rejects.toMatchObject({
      code: 'AI_QUOTA_STORE_DAILY_EXCEEDED',
    });
  });
  it('the platform global daily cap still stops a store that bought a pack', async () => {
    const { assertAiQuota } = await import('@api/lib/ai-quota');
    h.events = [
      ev({ planCode: 'addon:ai:topup_1000', forPeriodEnd: new Date(Date.now() + 10 * DAY) }),
    ];
    h.countAiUsage.mockResolvedValue(10_000);
    await expect(assertAiQuota({ storeId: 's1' })).rejects.toMatchObject({
      code: 'AI_QUOTA_DAILY_EXCEEDED',
    });
  });
  it('the refusal names the self-service path', async () => {
    const { assertAiQuota } = await import('@api/lib/ai-quota');
    h.aiStoreToday.mockResolvedValue(150);
    await expect(assertAiQuota({ storeId: 's1' })).rejects.toThrow(/Add-ons/);
  });
  it('the allowance shows base, extra, used and remaining', async () => {
    process.env.AI_DAILY_REQUEST_CAP = '2000'; // a platform that can back the pack
    const { storeAiAllowance } = await import('@api/lib/ai-quota');
    h.aiStoreToday.mockResolvedValue(100);
    h.events = [
      ev({ planCode: 'addon:ai:topup_300', forPeriodEnd: new Date(Date.now() + 10 * DAY) }),
    ];
    expect(await storeAiAllowance('s1')).toMatchObject({
      baseCap: 150,
      extra: 300,
      cap: 450,
      used: 100,
      remaining: 350,
    });
    delete process.env.AI_DAILY_REQUEST_CAP;
  });
  it('P6: with the platform at 450 a +1000 store stops at its 225 share; the next store still gets its first call', async () => {
    const { assertAiQuota } = await import('@api/lib/ai-quota');
    h.events = [
      ev({ planCode: 'addon:ai:topup_1000', forPeriodEnd: new Date(Date.now() + 10 * DAY) }),
    ];
    h.countAiUsage.mockResolvedValue(225); // store A alone has used 225 of the shared 450
    h.aiStoreToday.mockResolvedValue(225);
    await expect(assertAiQuota({ storeId: 's1' })).rejects.toMatchObject({
      code: 'AI_QUOTA_STORE_DAILY_EXCEEDED',
    });
    // store B: no pack, nothing used today, the shared pool is only half spent
    h.events = [];
    h.aiStoreToday.mockResolvedValue(0);
    await expect(assertAiQuota({ storeId: 's2' })).resolves.toBeUndefined();
  });
  it('P6: pack-funded calls pause at 70% of the pool, base-slice calls of other stores keep working', async () => {
    const { assertAiQuota } = await import('@api/lib/ai-quota');
    h.countAiUsage.mockResolvedValue(320); // 70% of 450 is 315
    h.events = [
      ev({ planCode: 'addon:ai:topup_300', forPeriodEnd: new Date(Date.now() + 10 * DAY) }),
    ];
    h.aiStoreToday.mockResolvedValue(160); // past its 150 base slice: this call is pack-funded
    await expect(assertAiQuota({ storeId: 's1' })).rejects.toMatchObject({
      code: 'AI_QUOTA_DAILY_EXCEEDED',
    });
    h.aiStoreToday.mockResolvedValue(100); // still inside the base slice: unaffected by the reserve
    await expect(assertAiQuota({ storeId: 's1' })).resolves.toBeUndefined();
    h.events = [];
    h.aiStoreToday.mockResolvedValue(10); // another store, no pack
    await expect(assertAiQuota({ storeId: 's3' })).resolves.toBeUndefined();
  });
  it('P6 at the prod cap (1800/day, 54000/month): +300 is sold, +1000 is refused (listing is covered in addons-list-history)', async () => {
    process.env.AI_DAILY_REQUEST_CAP = '1800';
    process.env.AI_MONTHLY_REQUEST_CAP = '54000';
    try {
      const { previewAddon } = await import('@api/services/billing/addons.service');
      const ctx = { storeId: 's1', userId: 'u1' };
      // a store may use half the day: 900. 150 base + 300 = 450 fits; 150 + 1000 = 1150 does not.
      await expect(previewAddon({ ...ctx, sku: 'ai:topup_300' })).resolves.toMatchObject({
        sku: 'ai:topup_300',
      });
      await expect(previewAddon({ ...ctx, sku: 'ai:topup_1000' })).rejects.toMatchObject({
        code: 'AI_CAPACITY_UNAVAILABLE',
      });
    } finally {
      delete process.env.AI_DAILY_REQUEST_CAP;
      delete process.env.AI_MONTHLY_REQUEST_CAP;
    }
  });
  it('P6 at a 450 cap (the old default): no top-up is sold', async () => {
    process.env.AI_DAILY_REQUEST_CAP = '450';
    try {
      const { previewAddon } = await import('@api/services/billing/addons.service');
      const ctx = { storeId: 's1', userId: 'u1' };
      for (const sku of ['ai:topup_300', 'ai:topup_1000'])
        await expect(previewAddon({ ...ctx, sku })).rejects.toMatchObject({
          code: 'AI_CAPACITY_UNAVAILABLE',
        });
    } finally {
      delete process.env.AI_DAILY_REQUEST_CAP;
    }
  });
  it('P6: a top-up the platform cannot back is not sold (nothing charged); with enough capacity it is', async () => {
    const { previewAddon } = await import('@api/services/billing/addons.service');
    const ctx = { storeId: 's1', userId: 'u1' };
    await expect(previewAddon({ ...ctx, sku: 'ai:topup_300' })).rejects.toMatchObject({
      code: 'AI_CAPACITY_UNAVAILABLE',
    });
    expect(h.claimEvent).not.toHaveBeenCalled();
    process.env.AI_DAILY_REQUEST_CAP = '2000';
    await expect(previewAddon({ ...ctx, sku: 'ai:topup_300' })).resolves.toMatchObject({
      sku: 'ai:topup_300',
    });
    delete process.env.AI_DAILY_REQUEST_CAP;
  });
});

describe('routes: owner only, tenant from the path, key required', () => {
  const svc = vi.hoisted(() => ({
    listAddons: vi.fn(),
    previewAddon: vi.fn(),
    purchaseAddon: vi.fn(),
    cancelAddon: vi.fn(),
    resumeAddon: vi.fn(),
  }));
  let app: Express;
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@api/services/billing/addons.service', () => svc);
    vi.doMock('@api/middleware/auth', async () => {
      const real =
        await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
      return {
        ...real,
        authenticate: (req: any, _res: any, next: any) => {
          req.user = { userId: 'u1', role: req.header('x-role') ?? 'store_admin' };
          next();
        },
        rejectImpersonated: (_q: any, _s: any, n: any) => n(),
      };
    });
    vi.doMock('@api/middleware/require-mfa', () => ({
      requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
    }));
    vi.doMock('@api/middleware/store-access', () => ({
      requireStoreAccess: (req: any, res: any, next: any) =>
        req.params.storeId === 'store-a' ? next() : res.status(404).json({ success: false }),
    }));
    vi.doMock('@api/middleware/security', () => ({ auditLog: vi.fn() }));
    Object.values(svc).forEach(f => (f as any).mockReset());
    svc.listAddons.mockResolvedValue({ addons: [], ai: {} });
    svc.previewAddon.mockResolvedValue({ confirmToken: 'tttttttttttt' });
    svc.purchaseAddon.mockResolvedValue({ redirectUrl: 'https://pay.test', billingEventId: 'e' });
    svc.cancelAddon.mockResolvedValue({ effectiveAt: null });
    svc.resumeAddon.mockResolvedValue(undefined);
    const router = (await import('@api/routes/addons.routes')).default;
    const { errorHandler } = await import('@api/middleware/error-handler');
    app = express();
    app.use(express.json());
    app.use('/stores/:storeId/billing/addons', router);
    app.use(errorHandler as any);
  });
  const base = '/stores/store-a/billing/addons';
  it('staff and customers are refused on every write', async () => {
    for (const role of ['staff', 'customer']) {
      expect(
        (
          await request(app)
            .post(`${base}/preview`)
            .set('x-role', role)
            .send({ sku: 'feature:floating_widget' })
        ).status
      ).toBe(403);
      expect(
        (
          await request(app)
            .post(`${base}/checkout`)
            .set('x-role', role)
            .set('Idempotency-Key', 'k-1234567')
            .send({ sku: 'feature:floating_widget', confirmToken: 'tttttttttttt' })
        ).status
      ).toBe(403);
      expect(
        (await request(app).post(`${base}/feature:floating_widget/cancel`).set('x-role', role))
          .status
      ).toBe(403);
    }
    expect(svc.purchaseAddon).not.toHaveBeenCalled();
    expect(svc.cancelAddon).not.toHaveBeenCalled();
  });
  it('the store owner buys; the store id is the path id, never the body', async () => {
    const res = await request(app)
      .post(`${base}/checkout`)
      .set('Idempotency-Key', 'k-1234567')
      .send({ sku: 'feature:floating_widget', confirmToken: 'tttttttttttt' });
    expect(res.status).toBe(201);
    const forged = await request(app)
      .post(`${base}/checkout`)
      .set('Idempotency-Key', 'k-1234567')
      .send({ sku: 'feature:floating_widget', confirmToken: 'tttttttttttt', storeId: 'store-b' });
    expect(forged.status).toBe(400);
    expect(svc.purchaseAddon).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: 'store-a', userId: 'u1', idempotencyKey: 'k-1234567' })
    );
  });
  it('another store is 404 and nothing is bought', async () => {
    const res = await request(app)
      .post('/stores/store-b/billing/addons/checkout')
      .set('Idempotency-Key', 'k-1234567')
      .send({ sku: 'feature:floating_widget', confirmToken: 'tttttttttttt' });
    expect(res.status).toBe(404);
    expect(svc.purchaseAddon).not.toHaveBeenCalled();
  });
  it('checkout without an Idempotency-Key is a 400 and buys nothing', async () => {
    const res = await request(app)
      .post(`${base}/checkout`)
      .send({ sku: 'feature:floating_widget', confirmToken: 'tttttttttttt' });
    expect(res.status).toBe(400);
    expect(svc.purchaseAddon).not.toHaveBeenCalled();
  });
  it('a body with extra fields is refused (Zod strict)', async () => {
    const res = await request(app)
      .post(`${base}/preview`)
      .send({ sku: 'feature:floating_widget', priceMinor: 1 });
    expect(res.status).toBe(400);
    expect(svc.previewAddon).not.toHaveBeenCalled();
  });
});
