/** Marketing confirm-class tools (plan 4 C2): promotion_create, promotion_toggle, coupon_delete. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  promo: { getById: vi.fn(), create: vi.fn(), toggleActive: vi.fn() },
  coupon: { getById: vi.fn(), delete: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/promotion.service', () => ({ PromotionService: m.promo }));
vi.mock('@api/services/coupon.service', () => ({ CouponService: m.coupon }));

import { ToolForbidden, effectivePolicy } from '@ebda/shared/smart-layer';
import { marketingConfirmTools } from '@api/smart-layer/tools/marketing-confirm.tools';
import { applyOf, ctxOf, previewOf, toolNamed } from './helpers/assistant-tool-harness';

const tools = marketingConfirmTools();
const T = (n: string) => toolNamed(tools, n);
const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });
const cap = { policy: 'confirm', undo: 'reversible' } as never;

const promo = {
  id: 'pr1',
  name: 'Eid',
  type: 'percentage',
  value: 20,
  isActive: true,
  scopeProductIds: [],
  startsAt: null,
  expiresAt: null,
  updatedAt: new Date(0),
};
const coupon = {
  id: 'c1',
  code: 'EID10',
  name: 'Eid',
  type: 'fixed',
  value: 5000,
  isActive: true,
  usageCount: 3,
  updatedAt: new Date(0),
};

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.promo.getById.mockResolvedValue(promo);
  m.promo.create.mockResolvedValue({ id: 'pr-new' });
  m.promo.toggleActive.mockResolvedValue({ ...promo, isActive: false });
  m.coupon.getById.mockResolvedValue(coupon);
  m.coupon.delete.mockResolvedValue(undefined);
});

describe('declarations', () => {
  it('all three are confirm-class, with no store id argument', () => {
    expect(tools.map(t => t.name).sort()).toEqual([
      'coupon_delete',
      'promotion_create',
      'promotion_toggle',
    ]);
    for (const t of tools) {
      expect(t.policy).toBe('confirm');
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
    }
  });
});

describe('promotion_create', () => {
  const args = {
    name: 'Eid',
    type: 'fixed',
    value: 15.5,
    minOrderEgp: 100,
    scopeProductIds: ['p1'],
  };
  it('shows the scope and amount exactly; flags price + checkout', async () => {
    const d = await previewOf(T('promotion_create'), args);
    expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(d.changesPrice).toBe(true);
    expect(d.touchesCheckout).toBe(true);
    expect(d.rows.find(r => r.label.en === 'Discount')?.after).toBe('15.5 EGP');
    expect(d.rows.find(r => r.label.en === 'Applies to')?.after).toEqual(['p1']);
    const reasons = effectivePolicy(T('promotion_create'), d, { cap }).reasons;
    expect(reasons).toEqual(expect.arrayContaining(['price', 'checkout']));
  });
  it('an unscoped promotion says "all products"', async () => {
    const d = await previewOf(T('promotion_create'), { name: 'x', type: 'percentage', value: 10 });
    expect(d.rows.find(r => r.label.en === 'Applies to')?.after).toBe('all products');
  });
  it('applies in piasters through PromotionService with the assistant audit; refs are products', async () => {
    const t = T('promotion_create');
    await applyOf(t, args);
    expect(m.promo.create).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'fixed',
        value: 1550,
        minOrderAmount: 10000,
        scopeProductIds: ['p1'],
      })
    );
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
    expect(t.refs!(args as never)).toEqual([{ kind: 'product', id: 'p1' }]);
  });
  it('undo switches the new promotion off', async () => {
    const t = T('promotion_create');
    expect(t.undo).toBe('compensating');
    const { draft, applied } = await applyOf(t, args);
    expect(t.inverse!(ctxOf(), args as never, draft, applied)).toEqual({
      tool: 'promotion_toggle',
      args: { promotionId: 'pr-new', active: false },
    });
  });
  it('a percentage above 100 never gets a card; staff cannot apply', async () => {
    await expect(
      previewOf(T('promotion_create'), { name: 'x', type: 'percentage', value: 120 })
    ).rejects.toThrow();
    await expect(applyOf(T('promotion_create'), args, 'staff')).rejects.toBeInstanceOf(
      ToolForbidden
    );
    expect(m.promo.create).not.toHaveBeenCalled();
  });
});

describe('promotion_toggle', () => {
  const args = { promotionId: 'pr1', active: false };
  it('reads the discount from state, not from args, and restores on undo', async () => {
    const t = T('promotion_toggle');
    const { draft } = await applyOf(t, { ...args, value: 99 } as never);
    expect(draft.rows.find(r => r.label.en === 'Discount')?.after).toBe('20%');
    expect(m.promo.toggleActive).toHaveBeenCalledWith('s1', 'pr1');
    expect(t.inverse!(ctxOf(), args as never, draft, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'promotion_toggle',
      args: { promotionId: 'pr1', active: true },
    });
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
  });
  it('is a no-op when already in that state; foreign id never reaches run; staff refused', async () => {
    await applyOf(T('promotion_toggle'), { promotionId: 'pr1', active: true });
    expect(m.promo.toggleActive).not.toHaveBeenCalled();
    m.promo.getById.mockRejectedValue(notFound());
    await expect(applyOf(T('promotion_toggle'), args)).rejects.toThrow();
    m.promo.getById.mockResolvedValue(promo);
    await expect(applyOf(T('promotion_toggle'), args, 'staff')).rejects.toBeInstanceOf(
      ToolForbidden
    );
    expect(m.promo.toggleActive).not.toHaveBeenCalled();
  });
});

describe('coupon_delete', () => {
  const args = { couponId: 'c1' };
  it('is a flagged delete with the exact coupon listed, and declares no inverse', async () => {
    const t = T('coupon_delete');
    expect(t.deletes).toBe(true);
    expect(t.undo).toBe('irreversible');
    expect(t.inverse).toBeUndefined();
    const d = await previewOf(t, args);
    expect(d.rows[0]!.before).toBe('EID10 (Eid) 50 EGP');
    expect(d.affectedCount).toBe(1);
    expect(effectivePolicy(t, d, { cap }).reasons).toContain('delete');
  });
  it('deletes through CouponService with the assistant audit', async () => {
    await applyOf(T('coupon_delete'), args);
    expect(m.coupon.delete).toHaveBeenCalledWith('s1', 'c1');
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
  });
  it('a foreign id never reaches run; staff and a missing plan feature are refused', async () => {
    m.coupon.getById.mockRejectedValue(notFound());
    await expect(applyOf(T('coupon_delete'), args)).rejects.toThrow();
    expect(m.coupon.delete).not.toHaveBeenCalled();
    m.coupon.getById.mockResolvedValue(coupon);
    await expect(applyOf(T('coupon_delete'), args, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
    m.featureEnabled.mockResolvedValue(false);
    await expect(previewOf(T('coupon_delete'), args)).rejects.toThrow(/feature/);
    expect(m.coupon.delete).not.toHaveBeenCalled();
  });
});
