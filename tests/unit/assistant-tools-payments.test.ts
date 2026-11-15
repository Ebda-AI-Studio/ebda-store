/** Payment assistant tools (plan 4 C2): COD and the instalment line. Checkout-visible = confirm; never a provider secret. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ToolForbidden,
  effectivePolicy,
  type TurnCtx,
  type ToolSpec,
} from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  cod: null as Record<string, unknown> | null,
  row: {} as Record<string, unknown>,
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  applyUpdate: vi.fn(),
  storeUpdate: vi.fn(),
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
  storeDb: async () => ({
    store: { findUnique: async () => m.row },
    paymentConfig: { findFirst: async () => m.cod },
  }),
}));
vi.mock('@api/services/store.service', () => ({ StoreService: { update: m.storeUpdate } }));
vi.mock('@api/services/store-payment-config.service', () => ({
  applyStorePaymentConfigUpdate: m.applyUpdate,
}));

import { applyThenUndo } from './helpers/undo-roundtrip';
import { paymentsTools } from '@api/smart-layer/tools/payments.tools';

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
const tool = (n: string): ToolSpec => paymentsTools().find(t => t.name === n)!;
const parse = (n: string, a: unknown) => tool(n).args.parse(a) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.cod = {
    id: 'c1',
    isEnabled: true,
    fixedFee: 1000,
    testMode: false,
    credentials: null,
    connectionTest: null,
    settings: { percentBps: 100 },
  };
  m.row = { settings: {} };
});

describe('payments tools', () => {
  it('no secret, key or store id is accepted or exposed', () => {
    for (const t of paymentsTools()) {
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id|password|apiKey|secret|token/i);
      expect(t.args.safeParse({ apiKey: 'x', enabled: true }).success).toBe(false);
    }
  });

  describe('cod_settings', () => {
    const args = { enabled: false, feeEgp: 20 };
    it('preview: before/after, restore = before values (piasters to EGP), checkout + price', async () => {
      const t = tool('cod_settings');
      const d = await t.preview!(ctx(), parse('cod_settings', args));
      expect(d.rows.map(r => [r.before, r.after])).toEqual([
        [true, false],
        ['10', 20],
      ]);
      expect((d.payload as { restore: unknown }).restore).toEqual({ enabled: true, feeEgp: 10 });
      expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
      expect(effectivePolicy(t, d).reasons).toEqual(expect.arrayContaining(['checkout', 'price']));
    });
    it('apply goes through runAsMerchant as the assistant, fee in piasters, same writer as the route', async () => {
      const t = tool('cod_settings');
      const a = parse('cod_settings', args);
      const r = await t.apply!(ctx(), a, await t.preview!(ctx(), a));
      expect(r.ok).toBe(true);
      expect(m.applyUpdate).toHaveBeenCalledWith(
        'S1',
        'cod',
        expect.objectContaining({ id: 'c1' }),
        { isEnabled: false },
        { updatedBy: 'u1', isEnabled: false, fixedFee: 2000 }
      );
      expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({
        actor: 'assistant',
        phase: 'intent',
        tool: 'cod_settings',
      });
    });
    it('staff is forbidden; hand edit changes the etag; inverse restores; missing COD row is refused', async () => {
      const t = tool('cod_settings');
      const a = parse('cod_settings', args);
      const d = await t.preview!(ctx(), a);
      await expect(t.apply!(ctx('staff'), a, d)).rejects.toBeInstanceOf(ToolForbidden);
      expect(m.applyUpdate).not.toHaveBeenCalled();
      m.cod = { ...m.cod!, fixedFee: 3000 };
      expect((await t.preview!(ctx(), a)).etag).not.toBe(d.etag);
      m.cod = { ...m.cod, fixedFee: 1000 };
      const inv = t.inverse!(ctx(), a, d, { ok: true, etagAfter: 'x' });
      expect(inv).toEqual({ tool: 'cod_settings', args: { enabled: true, feeEgp: 10 } });
      m.cod = null;
      await expect(t.preview!(ctx(), a)).rejects.toThrow(/not set up/);
    });
    it('percent is bounded', () => {
      expect(tool('cod_settings').args.safeParse({ percentBps: 9000 }).success).toBe(false);
    });
  });

  describe('instalments_settings', () => {
    const args = { enabled: true, months: 12, markupPct: 5 };
    it('preview shows before/after; first time restore is remove; checkout flag', async () => {
      const t = tool('instalments_settings');
      const d = await t.preview!(ctx(), parse('instalments_settings', args));
      expect(d.rows).toHaveLength(3);
      expect((d.payload as { restore: unknown }).restore).toEqual({ remove: true });
      expect(effectivePolicy(t, d).reasons).toContain('checkout');
    });
    it('apply writes the validated object; the inverse of a change restores the old object', async () => {
      const t = tool('instalments_settings');
      m.row = { settings: { instalments: { enabled: false, months: 6, markupPct: 2 } } };
      const a = parse('instalments_settings', { enabled: true, minPriceEgp: 100 });
      const d = await t.preview!(ctx(), a);
      await t.apply!(ctx(), a, d);
      expect(m.storeUpdate).toHaveBeenCalledWith('S1', {
        settings: { instalments: { enabled: true, months: 6, markupPct: 2, minPrice: 10000 } },
      });
      const inv = t.inverse!(ctx(), a, d, { ok: true, etagAfter: 'x' });
      expect(inv!.args).toMatchObject({ enabled: false, months: 6, markupPct: 2, minPriceEgp: 0 });
      expect(() => t.args.parse(inv!.args)).not.toThrow();
    });
    it('staff is forbidden; an invalid first-time setting never previews', async () => {
      const t = tool('instalments_settings');
      const a = parse('instalments_settings', { enabled: true });
      await expect(t.preview!(ctx(), a)).rejects.toThrow(/not valid/);
      const ok = parse('instalments_settings', args);
      const d = await t.preview!(ctx(), ok);
      await expect(t.apply!(ctx('staff'), ok, d)).rejects.toBeInstanceOf(ToolForbidden);
      expect(m.storeUpdate).not.toHaveBeenCalled();
      expect(t.args.safeParse({ remove: true, months: 5 }).success).toBe(false);
    });
  });
});

describe('role and plan gates on every tool (mutation targets: roles gate, feature gate)', () => {
  const cases: Array<{ name: string; args: unknown; feature?: boolean }> = [
    { name: 'cod_settings', args: { enabled: false, feeEgp: 20 } },
    { name: 'instalments_settings', args: { enabled: true, months: 12, markupPct: 5 } },
  ];
  for (const c of cases) {
    it(`${c.name}: staff is refused at preview, the card is never built`, async () => {
      await expect(tool(c.name).preview!(ctx('staff'), parse(c.name, c.args))).rejects.toThrow(
        /FORBIDDEN/
      );
    });
    it(`${c.name}: staff is refused at apply and nothing is written`, async () => {
      const t = tool(c.name);
      const a = parse(c.name, c.args);
      const d = await t.preview!(ctx(), a);
      await expect(t.apply!(ctx('staff'), a, d)).rejects.toBeInstanceOf(ToolForbidden);
      expect(m.insertAuditLog).not.toHaveBeenCalled();
    });
    it(`${c.name}: a super admin never acts through it`, async () => {
      await expect(
        tool(c.name).preview!(ctx('super_admin'), parse(c.name, c.args))
      ).rejects.toThrow(/FORBIDDEN/);
    });
    if (c.feature) {
      it(`${c.name}: plan feature off is refused at preview and at apply`, async () => {
        const t = tool(c.name);
        const a = parse(c.name, c.args);
        const d = await t.preview!(ctx(), a);
        m.featureEnabled.mockResolvedValue(false);
        await expect(t.preview!(ctx(), a)).rejects.toThrow(/FORBIDDEN/);
        await expect(t.apply!(ctx(), a, d)).rejects.toBeInstanceOf(ToolForbidden);
      });
    }
    it(`${c.name}: undo through the engine round trip is accepted and its args pass validation`, async () => {
      const t = tool(c.name);
      const r = await applyThenUndo(paymentsTools(), t, c.args);
      expect(r.applied).toBe('applied');
      expect(['undone', 'needs_confirm']).toContain(r.undo);
      const a = parse(c.name, c.args);
      const d = await t.preview!(ctx(), a);
      const inv = t.inverse!(ctx(), a, d, { ok: true, etagAfter: 'x' });
      if (inv) expect(() => t.args.parse(inv.args)).not.toThrow();
    });
  }
});
