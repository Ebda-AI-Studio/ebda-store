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
  updateBundle: vi.fn(),
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
  updateBundle: m.updateBundle,
  updateSchema: { parse: (x: unknown) => x },
}));
vi.mock('@api/services/recommendation.service', () => ({ recommendationService: m.rec }));
vi.mock('@api/services/abandoned-cart.service', () => ({ abandonedCartService: m.cart }));

import { ToolForbidden, effectivePolicy } from '@ebda/shared/smart-layer';
import { marketingTools } from '@api/smart-layer/tools/marketing.tools';
import { applyOf, ctxOf, previewOf, toolNamed } from './helpers/assistant-tool-harness';
import { applyThenUndo } from './helpers/undo-roundtrip';

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
        'abandoned_cart_emails_set',
        'abandoned_cart_settings',
        'bundle_create',
        'bundle_set_active',
        'coupon_create',
        'coupon_toggle',
        'coupon_update',
        'recommendations_set',
      ].sort()
    );
    for (const t of tools) {
      expect(t.policy).toBe(t.name === 'abandoned_cart_emails_set' ? 'confirm' : 'preview');
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
    const { draft, applied } = await applyOf(t, args);
    expect(draft.rows[0]).toMatchObject({ before: true, after: false });
    expect(draft.changesPrice).toBe(true);
    expect(m.coupon.toggleActive).toHaveBeenCalledWith('s1', 'c-1');
    expect(t.inverse!(ctxOf(), args as never, draft, applied)).toEqual({
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
    const { draft, applied } = await applyOf(t, args);
    expect(m.coupon.update).toHaveBeenCalledWith('s1', 'c-1', {
      value: 25,
      maxDiscount: 5000,
    });
    expect(t.inverse!(ctxOf(), args as never, draft, applied)).toEqual({
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
      bundle: {
        findFirst: vi.fn(async () => ({
          id: 'b-1',
          name: 'Set',
          isActive: true,
          updatedAt: new Date(0),
        })),
      },
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
  it('applies through createBundle in piasters with the assistant audit; undo switches it off', async () => {
    const t = T('bundle_create');
    expect(t.undo).toBe('compensating');
    await applyOf(t, args);
    expect(m.createBundle).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ pricingType: 'fixed_price', pricingValue: 15000 })
    );
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
    const { draft, applied } = await applyOf(t, args);
    expect(t.inverse!(ctxOf(), args as never, draft, applied)).toEqual({
      tool: 'bundle_set_active',
      args: { bundleId: 'b-1', active: false },
    });
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

describe('bundle_set_active', () => {
  const found = { id: 'b-1', name: 'Set', isActive: true, updatedAt: new Date(0) };
  const dbWith = (row: unknown) =>
    m.storeDb.mockResolvedValue({ bundle: { findFirst: vi.fn(async () => row) } });
  it('switches off via updateBundle, flags price, and undo switches it back on', async () => {
    dbWith(found);
    const t = T('bundle_set_active');
    const args = { bundleId: 'b-1', active: false };
    const { draft, applied } = await applyOf(t, args);
    expect(draft.rows[0]).toMatchObject({ before: true, after: false });
    expect(draft.changesPrice).toBe(true);
    expect(m.updateBundle).toHaveBeenCalledWith('s1', 'b-1', { isActive: false });
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
    expect(t.inverse!(ctxOf(), args as never, draft, applied)).toEqual({
      tool: 'bundle_set_active',
      args: { bundleId: 'b-1', active: true },
    });
  });
  it('a foreign bundle never reaches run; staff refused', async () => {
    dbWith(null);
    await expect(
      applyOf(T('bundle_set_active'), { bundleId: 'x', active: false })
    ).rejects.toThrow();
    expect(m.updateBundle).not.toHaveBeenCalled();
    dbWith(found);
    await expect(
      applyOf(T('bundle_set_active'), { bundleId: 'b-1', active: false }, 'staff')
    ).rejects.toBeInstanceOf(ToolForbidden);
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
    const { draft, applied } = await applyOf(t, args);
    expect(m.rec.setProductRelations).toHaveBeenCalledWith('s1', 'p1', [
      { targetProductId: 'p2', type: 'cross_sell', position: 0 },
      { targetProductId: 'p3', type: 'cross_sell', position: 1 },
      { targetProductId: 'p4', type: 'upsell', position: 0 },
    ]);
    expect(t.inverse!(ctxOf(), args as never, draft, applied)).toEqual({
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

describe('abandoned cart: the coupon settings tool and the e-mail tool are split', () => {
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
    m.cart.upsertConfig.mockResolvedValue(before);
  });

  it('the preview tool refuses every e-mail / reminder key (schema and describe)', async () => {
    const t = T('abandoned_cart_settings');
    for (const k of [
      { emailEnabled: true },
      { emailDelayMinutes: 120 },
      { step1Enabled: true },
      { step2DelayMinutes: 30 },
      { step3Enabled: true },
    ])
      expect(t.args.safeParse(k).success).toBe(false);
    // defence in depth: even a call that skipped the schema never builds a card
    await expect(previewOf(t, { emailEnabled: true })).rejects.toThrow(/abandoned_cart_emails_set/);
    expect(m.cart.upsertConfig).not.toHaveBeenCalled();
  });

  it('the coupon settings tool changes only the coupon, flags a price change, applies in piasters and undoes', async () => {
    const t = T('abandoned_cart_settings');
    const a = { autoCouponEnabled: true, couponMaxDiscountEgp: 30 };
    const { draft, applied } = await applyOf(t, a);
    expect(draft.changesPrice).toBe(true);
    expect(m.cart.upsertConfig).toHaveBeenCalledWith('s1', {
      autoCouponEnabled: true,
      couponMaxDiscount: 3000,
    });
    expect(t.inverse!(ctxOf(), a as never, draft, applied)).toEqual({
      tool: 'abandoned_cart_settings',
      args: { autoCouponEnabled: false, couponMaxDiscountEgp: null },
    });
    expect(effectivePolicy(t, draft).policy).toBe('confirm'); // a discount
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
  });

  it('the e-mail tool is confirm-class and flagged messagesCustomers, and the card says shoppers will be e-mailed', async () => {
    const t = T('abandoned_cart_emails_set');
    expect(t.policy).toBe('confirm');
    expect(t.messagesCustomers).toBe(true);
    const d = await previewOf(t, { emailEnabled: true, emailDelayMinutes: 120 });
    expect(effectivePolicy(t, d).reasons).toContain('customer_message');
    expect(d.summary.en).toMatch(/e-mail shoppers/);
    expect(d.rows.find(r => r.label.en === 'Customer emails')).toMatchObject({
      before: false,
      after: true,
    });
  });

  it('the e-mail tool applies through upsertConfig and its undo restores the switches (exact args pass validation)', async () => {
    const t = T('abandoned_cart_emails_set');
    const a = { emailEnabled: true, step1Enabled: true };
    const { draft, applied } = await applyOf(t, a);
    expect(m.cart.upsertConfig).toHaveBeenCalledWith('s1', a);
    const inv = t.inverse!(ctxOf(), a as never, draft, applied)!;
    expect(inv).toEqual({
      tool: 'abandoned_cart_emails_set',
      args: { emailEnabled: false, step1Enabled: false },
    });
    expect(t.args.safeParse(inv.args).success).toBe(true);
  });

  it('the e-mail tool refuses the coupon keys', () => {
    expect(T('abandoned_cart_emails_set').args.safeParse({ autoCouponEnabled: true }).success).toBe(
      false
    );
  });
});

describe('coupon edits a shopper can feel at checkout escalate to confirm', () => {
  const toolFor = (n: string) => T(n);
  const policyOf = async (name: string, args: unknown) => {
    const t = toolFor(name);
    return effectivePolicy(t, await previewOf(t, args)).reasons;
  };
  it.each([
    [
      'reviving an expired coupon (expiresAt)',
      { couponId: 'c-1', expiresAt: '2027-12-31T00:00:00Z' },
    ],
    ['changing the start date', { couponId: 'c-1', startsAt: '2026-12-01T00:00:00Z' }],
    ['removing the expiry', { couponId: 'c-1', expiresAt: null }],
    ['making it unlimited (usageLimit)', { couponId: 'c-1', usageLimit: null }],
    ['per-customer limit', { couponId: 'c-1', usageLimitPerUser: 5 }],
    ['renaming the code', { couponId: 'c-1', code: 'eid20' }],
    ['changing the minimum order', { couponId: 'c-1', minOrderEgp: 0 }],
  ])('coupon_update: %s', async (_n, args) => {
    const r = await policyOf('coupon_update', args);
    expect(r).toContain('checkout');
  });
  it('a price change also reports price', async () => {
    expect(await policyOf('coupon_update', { couponId: 'c-1', value: 50 })).toEqual(
      expect.arrayContaining(['price', 'checkout'])
    );
  });
  it('a harmless edit (the name) stays a preview', async () => {
    const t = toolFor('coupon_update');
    const d = await previewOf(t, { couponId: 'c-1', name: 'Eid sale', nameAr: 'تخفيضات العيد' });
    expect(effectivePolicy(t, d)).toEqual({ policy: 'preview', reasons: [] });
  });
  it('the card shows the code as run stores it (uppercase)', async () => {
    const d = await previewOf(T('coupon_update'), { couponId: 'c-1', code: 'eid20' });
    expect(d.rows.find(r => r.label.en === 'Coupon code')?.after).toBe('EID20');
    await applyOf(T('coupon_update'), { couponId: 'c-1', code: 'eid20' });
    expect(m.coupon.update).toHaveBeenCalledWith('s1', 'c-1', { code: 'EID20' });
    const c = await previewOf(T('coupon_create'), {
      code: 'new20',
      name: 'n',
      type: 'percentage',
      value: 20,
    });
    expect(c.rows.find(r => r.label.en === 'Coupon code')?.after).toBe('NEW20');
  });
  it('switching a coupon on or off is a checkout change; a free-shipping coupon too (no price)', async () => {
    const t = T('coupon_toggle');
    const d = await previewOf(t, { couponId: 'c-1', active: false });
    expect(effectivePolicy(t, d).reasons).toEqual(expect.arrayContaining(['checkout', 'price']));
    m.coupon.getById.mockResolvedValue({ ...coupon, type: 'free_shipping', isActive: false });
    const f = await previewOf(t, { couponId: 'c-1', active: true });
    expect(f.touchesCheckout).toBe(true);
    expect(f.changesPrice).toBeUndefined();
    expect(effectivePolicy(t, f).policy).toBe('confirm');
  });
  it('a no-op toggle stays a preview', async () => {
    const t = T('coupon_toggle');
    const d = await previewOf(t, { couponId: 'c-1', active: true });
    expect(effectivePolicy(t, d).policy).toBe('preview');
  });
});

describe('the undo args of every update tool pass their own tool validation (the card is refused otherwise)', () => {
  it('coupon_update restores nulls into nullable fields', async () => {
    m.coupon.getById.mockResolvedValue({ ...coupon, nameAr: null, startsAt: null });
    const t = T('coupon_update');
    const a = { couponId: 'c-1', nameAr: 'x', startsAt: '2026-12-01T00:00:00Z', usageLimit: 3 };
    const { draft, applied } = await applyOf(t, a);
    const inv = t.inverse!(ctxOf(), a as never, draft, applied)!;
    expect(inv.args).toEqual({ couponId: 'c-1', nameAr: null, startsAt: null, usageLimit: null });
    expect(t.args.safeParse(inv.args).success).toBe(true);
  });
  it('recommendations_set restores empty lists', async () => {
    m.rec.getRelations.mockResolvedValue([]);
    const t = T('recommendations_set');
    const a = { productId: 'p1', crossSellProductIds: ['p2'] };
    const { draft, applied } = await applyOf(t, a);
    const inv = t.inverse!(ctxOf(), a as never, draft, applied)!;
    expect(t.args.safeParse(inv.args).success).toBe(true);
  });
});

/** The engine's own journal: preview -> (confirm) -> apply -> undo, with the real etag and approval checks (no hand-made etagAfter). */
describe('applyThenUndo: every create tool of this slice, through the real engine', () => {
  beforeEach(() => {
    m.coupon.getById.mockResolvedValue({ ...coupon, id: 'c-new', isActive: true });
    m.storeDb.mockResolvedValue({
      bundle: {
        findFirst: vi.fn(async () => ({
          id: 'b-1',
          name: 'Set',
          isActive: true,
          updatedAt: new Date(0),
        })),
      },
      product: {
        findMany: vi.fn(async () => [
          { id: 'p-1', name: 'A', price: 10000, updatedAt: new Date(0) },
        ]),
      },
    });
    m.createBundle.mockResolvedValue({ id: 'b-1' });
  });
  it('coupon_create: applied, and the undo (switch off) reaches its confirm card', async () => {
    const r = await applyThenUndo(tools, T('coupon_create'), {
      code: 'NEW20',
      name: 'n',
      type: 'percentage',
      value: 20,
    });
    expect(r.applied).toBe('applied');
    expect(r.undo).toBe('needs_confirm');
    expect(r.card).toBeTruthy();
  });
  it('bundle_create: applied, undo (switch off) needs its confirm card', async () => {
    const r = await applyThenUndo(tools, T('bundle_create'), {
      name: 'Set',
      slug: 'set',
      pricingType: 'fixed_price',
      pricingValue: 90,
      items: [{ productId: 'p-1', quantity: 1 }],
    });
    expect(r.applied).toBe('applied');
    expect(r.undo).toBe('needs_confirm');
  });
  it('recommendations_set (a same-tool undo) is undone', async () => {
    m.rec.getRelations.mockResolvedValue([]);
    const r = await applyThenUndo(tools, T('recommendations_set'), {
      productId: 'p1',
      crossSellProductIds: ['p2'],
    });
    expect(r).toMatchObject({ applied: 'applied', undo: 'undone' });
  });
});

describe('every marketing tool: role, plan feature and impersonation gates (real refusals, not mocks of the refusal)', () => {
  type Case = {
    tool: string;
    args: unknown;
    feature: boolean;
    run: () => ReturnType<typeof vi.fn>;
    read: () => ReturnType<typeof vi.fn> | null;
  };
  const cases: Case[] = [
    {
      tool: 'coupon_create',
      args: { code: 'A1', name: 'n', type: 'percentage', value: 10 },
      feature: true,
      run: () => m.coupon.create,
      read: () => null,
    },
    {
      tool: 'coupon_toggle',
      args: { couponId: 'c-1', active: false },
      feature: true,
      run: () => m.coupon.toggleActive,
      read: () => m.coupon.getById,
    },
    {
      tool: 'coupon_update',
      args: { couponId: 'c-1', name: 'zz' },
      feature: true,
      run: () => m.coupon.update,
      read: () => m.coupon.getById,
    },
    {
      tool: 'bundle_create',
      args: {
        name: 'S',
        slug: 's',
        pricingType: 'fixed_price',
        pricingValue: 5,
        items: [{ productId: 'p-1', quantity: 1 }],
      },
      feature: true,
      run: () => m.createBundle,
      read: () => m.storeDb,
    },
    {
      tool: 'bundle_set_active',
      args: { bundleId: 'b-1', active: false },
      feature: true,
      run: () => m.updateBundle,
      read: () => m.storeDb,
    },
    {
      tool: 'recommendations_set',
      args: { productId: 'p1', crossSellProductIds: ['p2'] },
      feature: true,
      run: () => m.rec.setProductRelations,
      read: () => m.rec.getRelations,
    },
    {
      tool: 'abandoned_cart_settings',
      args: { autoCouponEnabled: true },
      feature: true,
      run: () => m.cart.upsertConfig,
      read: () => m.cart.getConfig,
    },
    {
      tool: 'abandoned_cart_emails_set',
      args: { emailEnabled: true },
      feature: true,
      run: () => m.cart.upsertConfig,
      read: () => m.cart.getConfig,
    },
  ];
  beforeEach(() => {
    m.storeDb.mockResolvedValue({
      bundle: {
        findFirst: vi.fn(async () => ({
          id: 'b-1',
          name: 'S',
          isActive: true,
          updatedAt: new Date(0),
        })),
      },
      product: {
        findMany: vi.fn(async () => [{ id: 'p-1', name: 'A', price: 1, updatedAt: new Date(0) }]),
      },
    });
    m.cart.getConfig.mockResolvedValue({
      couponMaxDiscount: null,
      emailEnabled: false,
      autoCouponEnabled: false,
    });
    m.rec.getRelations.mockResolvedValue([]);
  });
  const untouched = (c: Case) => {
    expect(c.run()).not.toHaveBeenCalled();
    expect(m.insertAuditLog).not.toHaveBeenCalled();
  };
  describe.each(cases)('$tool', c => {
    it.each(['staff', 'customer'])(
      '%s is refused at PREVIEW: no card, nothing read',
      async role => {
        await expect(previewOf(T(c.tool), c.args, role)).rejects.toThrow(/FORBIDDEN/);
        if (c.read()) expect(c.read()).not.toHaveBeenCalled();
        untouched(c);
      }
    );
    it('staff is refused at APPLY with ToolForbidden and nothing runs', async () => {
      await expect(applyOf(T(c.tool), c.args, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
      untouched(c);
    });
    it('a super admin (impersonation) is refused at preview and at apply', async () => {
      await expect(previewOf(T(c.tool), c.args, 'super_admin')).rejects.toThrow(/FORBIDDEN/);
      await expect(applyOf(T(c.tool), c.args, 'super_admin')).rejects.toBeInstanceOf(ToolForbidden);
      untouched(c);
    });
    it('plan feature off: refused at preview, and at apply if it flips after the card', async () => {
      m.featureEnabled.mockResolvedValue(false);
      await expect(previewOf(T(c.tool), c.args)).rejects.toThrow(/feature/);
      m.featureEnabled.mockResolvedValue(true);
      const t = T(c.tool);
      const draft = await previewOf(t, c.args);
      m.featureEnabled.mockResolvedValue(false);
      await expect(t.apply!(ctxOf(), c.args as never, draft)).rejects.toBeInstanceOf(ToolForbidden);
      untouched(c);
    });
  });
});
