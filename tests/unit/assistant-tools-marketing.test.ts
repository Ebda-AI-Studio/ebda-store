/**
 * Marketing change tools of the Store assistant (plan 4 B6): coupons, bundles, recommendations, abandoned-cart settings.
 * Every tool: a preview with before/after rows + an etag, apply through runAsMerchant (audit actor "assistant", the route's own role gate),
 * an inverse that restores the BEFORE values, and a foreign id that never reaches `run`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  auditLog: vi.fn(),
  coupon: { getById: vi.fn(), create: vi.fn(), update: vi.fn(), toggleActive: vi.fn() },
  createBundle: vi.fn(),
  storeDb: vi.fn(),
  rec: { getRelations: vi.fn(), setProductRelations: vi.fn() },
  cart: { getConfig: vi.fn(), upsertConfig: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: m.auditLog }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/coupon.service', () => ({ CouponService: m.coupon }));
vi.mock('@api/lib/repo-factory', () => ({ storeDb: m.storeDb }));
vi.mock('@api/routes/bundle.routes', () => ({
  createBundle: m.createBundle,
  createSchema: { parse: (x: unknown) => x },
}));
vi.mock('@api/services/recommendation.service', () => ({ recommendationService: m.rec }));
vi.mock('@api/services/abandoned-cart.service', () => ({ abandonedCartService: m.cart }));

import { ToolForbidden } from '@ebda/shared/smart-layer';
import { marketingTools } from '@api/smart-layer/tools/marketing.tools';
import { applyOf, ctxOf, previewOf, toolNamed } from './helpers/assistant-tool-harness';

const tools = marketingTools();
const T = (n: string) => toolNamed(tools, n);
const notFound = () => Object.assign(new Error('Coupon not found'), { statusCode: 404 });

const coupon = {
  id: 'c-1',
  code: 'EID10',
  name: 'Eid',
  nameAr: null,
  type: 'percentage',
  value: 10,
  minOrderAmount: null,
  maxDiscount: null,
  usageLimit: null,
  usageLimitPerUser: null,
  startsAt: null,
  expiresAt: null,
  isActive: true,
  updatedAt: new Date('2026-11-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.auditLog.mockResolvedValue(undefined);
  m.coupon.getById.mockResolvedValue(coupon);
  m.coupon.create.mockResolvedValue({ ...coupon, id: 'c-new', code: 'NEW20' });
  m.coupon.update.mockResolvedValue(coupon);
  m.coupon.toggleActive.mockResolvedValue({ ...coupon, isActive: false });
});

describe('every marketing tool', () => {
  it('is declared, on a marketing capability, with preview policy and no store id argument', () => {
    expect(tools.map(t => t.name).sort()).toEqual(
      [
        'abandoned_cart_settings',
        'bundle_create',
        'coupon_create',
        'coupon_toggle',
        'coupon_update',
        'recommendations_set',
      ].sort()
    );
    for (const t of tools) {
      expect(t.policy).toBe('preview');
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
    }
  });
});

describe('coupon_create', () => {
  const args = { code: 'new20', name: 'New 20', type: 'fixed', value: 20, minOrderEgp: 100 };
  it('previews EGP rows, an etag and flags a price change', async () => {
    const d = await previewOf(T('coupon_create'), args);
    expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(d.changesPrice).toBe(true);
    expect(d.affectedCount).toBe(1);
    expect(d.rows.find(r => r.label.en === 'Discount value')?.after).toBe(20);
    expect(m.coupon.create).not.toHaveBeenCalled();
  });
  it('applies via runAsMerchant: audit actor assistant, value in piasters', async () => {
    const { applied } = await applyOf(T('coupon_create'), args);
    expect(m.insertAuditLog.mock.calls[0]![0].details).toMatchObject({
      actor: 'assistant',
      phase: 'intent',
      tool: 'coupon_create',
    });
    expect(m.coupon.create).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ code: 'NEW20', type: 'fixed', value: 2000, minOrderAmount: 10000 })
    );
    expect(applied.ok).toBe(true);
  });
  it('a percentage must be a whole number from 1 to 100', async () => {
    await expect(
      previewOf(T('coupon_create'), { code: 'X', name: 'x', type: 'percentage', value: 150 })
    ).rejects.toThrow();
  });
  it('undo = deactivate the created coupon (compensating)', async () => {
    const t = T('coupon_create');
    expect(t.undo).toBe('compensating');
    const { draft, applied } = await applyOf(t, args);
    expect(t.inverse!(ctxOf(), args as never, draft, applied)).toEqual({
      tool: 'coupon_toggle',
      args: { couponId: 'c-new', active: false },
    });
  });
  it('a team member without the role gets ToolForbidden and nothing runs', async () => {
    await expect(applyOf(T('coupon_create'), args, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.coupon.create).not.toHaveBeenCalled();
  });
  it('a plan without the coupons feature never gets a card', async () => {
    m.featureEnabled.mockResolvedValue(false);
    await expect(previewOf(T('coupon_create'), args)).rejects.toThrow(/feature/);
  });
});

describe('coupon_toggle', () => {
  it('previews before/after and restores the before value on undo', async () => {
    const t = T('coupon_toggle');
    const args = { couponId: 'c-1', active: false };
    const { draft } = await applyOf(t, args);
    expect(draft.rows[0]).toMatchObject({ before: true, after: false });
    expect(draft.changesPrice).toBe(true);
    expect(m.coupon.toggleActive).toHaveBeenCalledWith('s1', 'c-1');
    expect(t.inverse!(ctxOf(), args as never, draft, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'coupon_toggle',
      args: { couponId: 'c-1', active: true },
    });
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
  });
  it('is a no-op when the coupon is already in the asked state', async () => {
    const { draft } = await applyOf(T('coupon_toggle'), { couponId: 'c-1', active: true });
    expect(draft.affectedCount).toBe(0);
    expect(m.coupon.toggleActive).not.toHaveBeenCalled();
  });
  it('a foreign coupon id throws at preview and never reaches run', async () => {
    m.coupon.getById.mockRejectedValue(notFound());
    await expect(applyOf(T('coupon_toggle'), { couponId: 'other', active: false })).rejects.toThrow(
      /not found/
    );
    expect(m.coupon.toggleActive).not.toHaveBeenCalled();
    expect(m.insertAuditLog).not.toHaveBeenCalled();
  });
  it('staff are refused at apply', async () => {
    await expect(
      applyOf(T('coupon_toggle'), { couponId: 'c-1', active: false }, 'staff')
    ).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.coupon.toggleActive).not.toHaveBeenCalled();
  });
});

describe('coupon_update', () => {
  const args = { couponId: 'c-1', value: 25, maxDiscountEgp: 50 };
  it('shows before/after rows for exactly the touched fields and a price flag', async () => {
    const d = await previewOf(T('coupon_update'), args);
    expect(d.rows.map(r => r.label.en).sort()).toEqual(['Discount value', 'Maximum discount']);
    expect(d.changesPrice).toBe(true);
    expect(d.payload).toMatchObject({ restore: { value: 10, maxDiscountEgp: null } });
  });
  it('applies through the service in piasters and the inverse restores before values', async () => {
    const t = T('coupon_update');
    const { draft } = await applyOf(t, args);
    expect(m.coupon.update).toHaveBeenCalledWith('s1', 'c-1', {
      value: 25,
      maxDiscount: 5000,
    });
    expect(t.inverse!(ctxOf(), args as never, draft, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'coupon_update',
      args: { couponId: 'c-1', value: 10, maxDiscountEgp: null },
    });
  });
  it('a non-price edit does not flag a price change', async () => {
    const d = await previewOf(T('coupon_update'), { couponId: 'c-1', name: 'Eid 2' });
    expect(d.changesPrice).toBeUndefined();
  });
  it('the etag changes when the coupon is edited by hand', async () => {
    const a = await previewOf(T('coupon_update'), args);
    m.coupon.getById.mockResolvedValue({ ...coupon, updatedAt: new Date('2026-11-02T00:00:00Z') });
    const b = await previewOf(T('coupon_update'), args);
    expect(a.etag).not.toBe(b.etag);
  });
  it('a foreign id never reaches run; staff refused', async () => {
    m.coupon.getById.mockRejectedValue(notFound());
    await expect(applyOf(T('coupon_update'), args)).rejects.toThrow();
    expect(m.coupon.update).not.toHaveBeenCalled();
    m.coupon.getById.mockResolvedValue(coupon);
    await expect(applyOf(T('coupon_update'), args, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
  });
});

describe('bundle_create', () => {
  const pid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const args = {
    name: 'Set',
    slug: 'set',
    pricingType: 'fixed_price',
    pricingValue: 150,
    items: [
      { productId: pid(1), quantity: 1 },
      { productId: pid(2), quantity: 2 },
    ],
  };
  beforeEach(() => {
    m.storeDb.mockResolvedValue({
      product: {
        findMany: vi.fn(async () => [
          { id: pid(1), name: 'A', price: 10000, updatedAt: new Date(0) },
          { id: pid(2), name: 'B', price: 5000, updatedAt: new Date(0) },
        ]),
      },
    });
    m.createBundle.mockResolvedValue({ id: 'b-1' });
  });
  it('previews the components, flags a price change and checks the products as refs', async () => {
    const t = T('bundle_create');
    const d = await previewOf(t, args);
    expect(d.changesPrice).toBe(true);
    expect(d.etag).toBeTruthy();
    expect(t.refs!(args as never)).toEqual([
      { kind: 'product', id: pid(1) },
      { kind: 'product', id: pid(2) },
    ]);
  });
  it('applies through createBundle in piasters with the assistant audit; irreversible', async () => {
    const t = T('bundle_create');
    expect(t.undo).toBe('irreversible');
    await applyOf(t, args);
    expect(m.createBundle).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ pricingType: 'fixed_price', pricingValue: 15000 })
    );
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
  });
  it('a product of another store never reaches run', async () => {
    m.storeDb.mockResolvedValue({ product: { findMany: vi.fn(async () => []) } });
    await expect(applyOf(T('bundle_create'), args)).rejects.toThrow();
    expect(m.createBundle).not.toHaveBeenCalled();
  });
  it('staff refused', async () => {
    await expect(applyOf(T('bundle_create'), args, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.createBundle).not.toHaveBeenCalled();
  });
});

describe('recommendations_set', () => {
  const args = { productId: 'p1', crossSellProductIds: ['p2', 'p3'], upsellProductIds: ['p4'] };
  const rel = (t: string, id: string, position: number) => ({
    id: `r-${id}`,
    type: t,
    position,
    createdAt: new Date(0),
    targetProduct: { id, name: id },
  });
  beforeEach(() => {
    m.rec.getRelations.mockResolvedValue([rel('cross_sell', 'p9', 0)]);
    m.rec.setProductRelations.mockResolvedValue(undefined);
  });
  it('previews before/after lists; refs cover the source and every target', async () => {
    const t = T('recommendations_set');
    const d = await previewOf(t, args);
    expect(d.rows[0]).toMatchObject({ before: ['p9'], after: ['p2', 'p3'] });
    expect(d.affectedCount).toBe(3);
    expect(t.refs!(args as never).map(r => r.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });
  it('applies via setProductRelations; undo restores the previous lists', async () => {
    const t = T('recommendations_set');
    const { draft } = await applyOf(t, args);
    expect(m.rec.setProductRelations).toHaveBeenCalledWith('s1', 'p1', [
      { targetProductId: 'p2', type: 'cross_sell', position: 0 },
      { targetProductId: 'p3', type: 'cross_sell', position: 1 },
      { targetProductId: 'p4', type: 'upsell', position: 0 },
    ]);
    expect(t.inverse!(ctxOf(), args as never, draft, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'recommendations_set',
      args: { productId: 'p1', crossSellProductIds: ['p9'], upsellProductIds: [] },
    });
  });
  it('a product cannot recommend itself; staff refused', async () => {
    await expect(
      previewOf(T('recommendations_set'), { ...args, crossSellProductIds: ['p1'] })
    ).rejects.toThrow();
    await expect(applyOf(T('recommendations_set'), args, 'staff')).rejects.toBeInstanceOf(
      ToolForbidden
    );
  });
});

describe('abandoned_cart_settings', () => {
  const before = {
    step1Enabled: false,
    step1DelayMinutes: 60,
    step2Enabled: false,
    step2DelayMinutes: 1440,
    step3Enabled: false,
    step3DelayMinutes: 4320,
    autoCouponEnabled: false,
    couponDiscountPercent: 10,
    couponMaxDiscount: null,
    couponExpiryHours: 48,
    emailEnabled: false,
    emailDelayMinutes: 60,
  };
  beforeEach(() => {
    m.cart.getConfig.mockResolvedValue(before);
    m.cart.upsertConfig.mockResolvedValue({ ...before, emailEnabled: true });
  });
  const args = { emailEnabled: true, emailDelayMinutes: 120 };
  it('says plainly that enabling sends customer emails on a schedule', async () => {
    const d = await previewOf(T('abandoned_cart_settings'), args);
    expect(d.rows.map(r => r.label.en)).toContain('Customer emails');
    expect(d.rows.find(r => r.label.en === 'Customer emails')?.after).toMatch(/120/);
    expect(d.changesPrice).toBeUndefined();
  });
  it('an auto coupon is a discount: price flag', async () => {
    const d = await previewOf(T('abandoned_cart_settings'), { autoCouponEnabled: true });
    expect(d.changesPrice).toBe(true);
  });
  it('applies via upsertConfig (EGP cap in piasters) and undo restores before values', async () => {
    const t = T('abandoned_cart_settings');
    const a = { ...args, couponMaxDiscountEgp: 30 };
    const { draft } = await applyOf(t, a);
    expect(m.cart.upsertConfig).toHaveBeenCalledWith('s1', {
      emailEnabled: true,
      emailDelayMinutes: 120,
      couponMaxDiscount: 3000,
    });
    expect(t.inverse!(ctxOf(), a as never, draft, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'abandoned_cart_settings',
      args: { emailEnabled: false, emailDelayMinutes: 60, couponMaxDiscountEgp: null },
    });
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
  });
  it('staff refused; a delay outside the allowed range is rejected by the schema', async () => {
    await expect(applyOf(T('abandoned_cart_settings'), args, 'staff')).rejects.toBeInstanceOf(
      ToolForbidden
    );
    expect(T('abandoned_cart_settings').args.safeParse({ emailDelayMinutes: 5 }).success).toBe(
      false
    );
  });
});
