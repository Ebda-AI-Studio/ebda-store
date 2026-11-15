/** Shipping assistant tools (plan 4 C2): rates, checkout delivery, carrier switches. Checkout-visible = confirm; no secrets; foreign ids never reach `run`. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ToolForbidden,
  effectivePolicy,
  type TurnCtx,
  type ToolSpec,
} from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  rates: [] as Array<Record<string, unknown>>,
  carriers: [] as Array<Record<string, unknown>>,
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  getAreaRatesByIds: vi.fn(),
  updateAreaRate: vi.fn(),
  storeUpdate: vi.fn(),
  upsertCarrierConfig: vi.fn(),
  getPublicCarrierConfigs: vi.fn(),
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
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ store: { findUnique: async () => m.row } }),
}));
vi.mock('@api/services/store.service', () => ({ StoreService: { update: m.storeUpdate } }));
vi.mock('@api/services/shipping.service', () => ({
  ShippingService: { getAreaRatesByIds: m.getAreaRatesByIds, updateAreaRate: m.updateAreaRate },
}));
vi.mock('@api/services/shipping-carrier.service', () => ({
  shippingCarrierService: {
    upsertCarrierConfig: m.upsertCarrierConfig,
    getPublicCarrierConfigs: m.getPublicCarrierConfigs,
  },
}));
vi.mock('@api/services/carriers/carrier-connection.service', () => ({
  assertMayConfigureCarrier: vi.fn(),
}));

import { shippingTools } from '@api/smart-layer/tools/shipping.tools';

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
const tool = (n: string): ToolSpec => shippingTools().find(t => t.name === n)!;
const parse = (n: string, a: unknown) => tool(n).args.parse(a) as never;
const R1 = {
  id: 'r1',
  governorate: 'Cairo',
  governorateAr: 'القاهرة',
  area: 'Nasr City',
  areaAr: 'مدينة نصر',
  deliveryFee: 5000,
  freeShippingThreshold: null,
  isActive: true,
  updatedAt: new Date('2026-11-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.rates = [R1];
  m.getAreaRatesByIds.mockImplementation(async (_s: string, ids: string[]) =>
    m.rates.filter(r => ids.includes(r.id as string))
  );
  m.updateAreaRate.mockResolvedValue({ id: 'r1' });
  m.getPublicCarrierConfigs.mockImplementation(async () => m.carriers);
  m.carriers = [{ carrier: 'bosta', enabled: true, isDefault: false }];
  m.row = {
    settings: {
      minimumOrderFils: 10000,
      deliveryDays: { min: 1, max: 3 },
      checkoutDelivery: { windows: { enabled: true, items: [] }, daysAhead: 2 },
    },
  };
});

describe('shipping tools', () => {
  it('exposes the planned tools, none taking a store id or a secret', () => {
    const ts = shippingTools();
    expect(ts.map(t => t.name).sort()).toEqual(
      ['carrier_settings', 'checkout_delivery_set', 'shipping_rate_set'].sort()
    );
    for (const t of ts) {
      expect(t.undo).toBe('reversible');
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id|password|apiKey|secret|token/i);
    }
    expect(
      tool('carrier_settings').args.safeParse({ carrier: 'bosta', apiKey: 'k', enabled: true })
        .success
    ).toBe(false);
  });

  describe('shipping_rate_set', () => {
    const args = { rates: [{ rateId: 'r1', deliveryFeeEgp: 60.5, freeShippingOverEgp: 1000 }] };
    it('preview: before/after in EGP, etag, restore = before values, checkout + price flags', async () => {
      const d = await tool('shipping_rate_set').preview!(ctx(), parse('shipping_rate_set', args));
      expect(d.rows.map(r => [r.before, r.after])).toEqual([
        ['50', 60.5],
        [null, 1000],
      ]);
      expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
      expect((d.payload as { restore: unknown }).restore).toEqual({
        rates: [{ rateId: 'r1', deliveryFeeEgp: 50, freeShippingOverEgp: null }],
      });
      expect(d.touchesCheckout).toBe(true);
      expect(d.changesPrice).toBe(true);
      expect(effectivePolicy(tool('shipping_rate_set'), d).reasons).toEqual(
        expect.arrayContaining(['checkout', 'price'])
      );
    });
    it('a 25-item change has affectedCount 25 and escalates as bulk', async () => {
      m.rates = Array.from({ length: 25 }, (_, i) => ({ ...R1, id: `r${i}` }));
      const a = { rates: m.rates.map(r => ({ rateId: r.id as string, isActive: false })) };
      const d = await tool('shipping_rate_set').preview!(ctx(), parse('shipping_rate_set', a));
      expect(d.affectedCount).toBe(25);
      expect(effectivePolicy(tool('shipping_rate_set'), d).reasons).toContain('bulk');
      expect(d.changesPrice).toBeUndefined();
    });
    it('apply goes through runAsMerchant as the assistant, fee converted to piasters', async () => {
      const t = tool('shipping_rate_set');
      const a = parse('shipping_rate_set', args);
      const r = await t.apply!(ctx(), a, await t.preview!(ctx(), a));
      expect(r.ok).toBe(true);
      expect(m.updateAreaRate).toHaveBeenCalledWith('S1', 'r1', {
        deliveryFee: 6050,
        freeShippingThreshold: 100000,
      });
      expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({
        actor: 'assistant',
        phase: 'intent',
        tool: 'shipping_rate_set',
      });
    });
    it('staff gets ToolForbidden at apply and nothing runs', async () => {
      const t = tool('shipping_rate_set');
      const a = parse('shipping_rate_set', args);
      const d = await t.preview!(ctx(), a);
      await expect(t.apply!(ctx('staff'), a, d)).rejects.toBeInstanceOf(ToolForbidden);
      expect(m.updateAreaRate).not.toHaveBeenCalled();
    });
    it('the inverse restores the before values through the same tool', async () => {
      const t = tool('shipping_rate_set');
      const a = parse('shipping_rate_set', args);
      const d = await t.preview!(ctx(), a);
      const inv = t.inverse!(ctx(), a, d, { ok: true, etagAfter: 'x' });
      expect(inv).toEqual({
        tool: 'shipping_rate_set',
        args: { rates: [{ rateId: 'r1', deliveryFeeEgp: 50, freeShippingOverEgp: null }] },
      });
      expect(() => t.args.parse(inv!.args)).not.toThrow();
    });
    it('a foreign id never reaches run', async () => {
      const t = tool('shipping_rate_set');
      const a = parse('shipping_rate_set', { rates: [{ rateId: 'foreign', isActive: false }] });
      await expect(t.preview!(ctx(), a)).rejects.toThrow(/not found/);
      await expect(t.apply!(ctx(), a, {} as never)).rejects.toThrow(/not found/);
      expect(m.updateAreaRate).not.toHaveBeenCalled();
    });
    it('a hand edit changes the etag; an empty change or duplicate area is refused', async () => {
      const t = tool('shipping_rate_set');
      const a = parse('shipping_rate_set', args);
      const e1 = (await t.preview!(ctx(), a)).etag;
      m.rates = [{ ...R1, deliveryFee: 7000 }];
      expect((await t.preview!(ctx(), a)).etag).not.toBe(e1);
      expect(t.args.safeParse({ rates: [{ rateId: 'r1' }] }).success).toBe(false);
      expect(
        t.args.safeParse({
          rates: [
            { rateId: 'r1', isActive: true },
            { rateId: 'r1', isActive: false },
          ],
        }).success
      ).toBe(false);
    });
  });

  describe('checkout_delivery_set', () => {
    const args = { minimumOrderEgp: 250.5, daysAhead: 5, deliveryOffDays: [5, 6] };
    it('preview shows before/after, restore is the before values, touches checkout', async () => {
      const t = tool('checkout_delivery_set');
      const d = await t.preview!(ctx(), parse('checkout_delivery_set', args));
      expect(d.rows.map(r => [r.before, r.after])).toEqual([
        [100, 250.5],
        [null, [5, 6]],
        [2, 5],
      ]);
      expect((d.payload as { restore: unknown }).restore).toEqual({
        minimumOrderEgp: 100,
        deliveryOffDays: null,
        daysAhead: 2,
      });
      expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
      expect(effectivePolicy(t, d).reasons).toContain('checkout');
    });
    it('apply writes the route keys in piasters and keeps the merchant windows', async () => {
      const t = tool('checkout_delivery_set');
      const a = parse('checkout_delivery_set', args);
      await t.apply!(ctx(), a, await t.preview!(ctx(), a));
      expect(m.storeUpdate).toHaveBeenCalledWith('S1', {
        settings: {
          minimumOrderFils: 25050,
          deliveryOffDays: [5, 6],
          checkoutDelivery: { windows: { enabled: true, items: [] }, daysAhead: 5 },
        },
      });
      expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({ actor: 'assistant' });
    });
    it('staff is forbidden; the inverse is the same tool with the before values; bad input refused', async () => {
      const t = tool('checkout_delivery_set');
      const a = parse('checkout_delivery_set', args);
      const d = await t.preview!(ctx(), a);
      await expect(t.apply!(ctx('staff'), a, d)).rejects.toBeInstanceOf(ToolForbidden);
      expect(m.storeUpdate).not.toHaveBeenCalled();
      const inv = t.inverse!(ctx(), a, d, { ok: true, etagAfter: 'x' });
      expect(inv!.tool).toBe('checkout_delivery_set');
      expect(() => t.args.parse(inv!.args)).not.toThrow();
      expect(t.args.safeParse({ daysAhead: 99 }).success).toBe(false);
      expect(t.args.safeParse({ deliveryDays: { min: 5, max: 1 } }).success).toBe(false);
      expect(t.args.safeParse({}).success).toBe(false);
    });
  });

  describe('carrier_settings', () => {
    const args = { carrier: 'bosta', enabled: false };
    it('preview, apply via the carrier service, plan gate, inverse; never a credential', async () => {
      const t = tool('carrier_settings');
      const a = parse('carrier_settings', args);
      const d = await t.preview!(ctx(), a);
      expect(d.rows[0]).toMatchObject({ before: true, after: false });
      expect((d.payload as { restore: unknown }).restore).toEqual({
        carrier: 'bosta',
        enabled: true,
      });
      await t.apply!(ctx(), a, d);
      expect(m.upsertCarrierConfig).toHaveBeenCalledWith('S1', 'bosta', { enabled: false });
      expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({ actor: 'assistant' });
      const inv = t.inverse!(ctx(), a, d, { ok: true, etagAfter: 'x' });
      expect(inv).toEqual({ tool: 'carrier_settings', args: { carrier: 'bosta', enabled: true } });
      expect(JSON.stringify(d)).not.toMatch(/credential/i);
    });
    it('staff is forbidden and a plan without shipping_carriers is refused', async () => {
      const t = tool('carrier_settings');
      const a = parse('carrier_settings', args);
      const d = await t.preview!(ctx(), a);
      await expect(t.apply!(ctx('staff'), a, d)).rejects.toBeInstanceOf(ToolForbidden);
      m.featureEnabled.mockResolvedValue(false);
      await expect(t.preview!(ctx(), a)).rejects.toThrow();
      expect(m.upsertCarrierConfig).not.toHaveBeenCalled();
    });
  });
});
