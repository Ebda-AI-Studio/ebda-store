/** Returns assistant tools (plan 4 C2): approve / reject email the shopper, the refund moves money (amount read from state), the policy is a reversible preview. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ToolForbidden,
  effectivePolicy,
  type TurnCtx,
  type ToolSpec,
} from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  ret: {} as Record<string, unknown>,
  preview: {} as Record<string, unknown>,
  storeRow: {} as Record<string, unknown>,
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  rs: {
    getById: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    complete: vi.fn(),
    refundPreview: vi.fn(),
  },
  store: { update: vi.fn() },
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
  storeDb: async () => ({ store: { findUnique: async () => m.storeRow } }),
}));
vi.mock('@api/services/return.service', async () => ({
  ReturnService: m.rs,
  REFUND_METHODS: (await import('@api/lib/refund-methods')).REFUND_METHODS,
}));
vi.mock('@api/services/store.service', () => ({ StoreService: m.store }));

import { returnsTools } from '@api/smart-layer/tools/returns.tools';
import { applyThenUndo } from './helpers/undo-roundtrip';

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
const tool = (n: string): ToolSpec => returnsTools().find(t => t.name === n)!;
const parse = (n: string, a: unknown) => tool(n).args.parse(a) as never;
const baseReturn = (o: Record<string, unknown> = {}) => ({
  id: 'R1',
  returnNumber: 'RET-1',
  status: 'pending',
  order: { orderNumber: 'ORD-1' },
  items: [{}, {}],
  updatedAt: '2026-11-14T10:00:00.000Z',
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.ret = baseReturn();
  m.preview = {
    recordedAmount: 9000,
    storeCreditToWallet: 9500,
    gateway: { available: true, amount: 8000, unavailableReason: null },
  };
  m.rs.getById.mockImplementation(async () => m.ret);
  m.rs.refundPreview.mockImplementation(async () => m.preview);
  m.rs.approve.mockResolvedValue({});
  m.rs.reject.mockResolvedValue({});
  m.rs.complete.mockResolvedValue({});
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.storeRow = { returnWindowDays: 14, returnFeesPaidBy: 'customer' };
});

const decisions = [
  { name: 'return_approve', args: { returnId: 'R1', notes: 'ok' }, svc: 'approve' },
  { name: 'return_reject', args: { returnId: 'R1', reason: 'المنتج مستخدم' }, svc: 'reject' },
  {
    name: 'return_complete_refund',
    args: { returnId: 'R1', refundMethod: 'original' },
    svc: 'complete',
  },
] as const;

describe('return confirm tools', () => {
  it('are confirm class, irreversible, with no inverse and no store id argument', () => {
    for (const c of decisions) {
      const t = tool(c.name);
      expect(t.policy).toBe('confirm');
      expect(t.undo).toBe('irreversible');
      expect(t.inverse).toBeUndefined();
      expect(t.messagesCustomers).toBe(true);
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
    }
    expect(tool('return_complete_refund').money).toBe(true);
  });

  for (const c of decisions) {
    describe(c.name, () => {
      beforeEach(() => {
        if (c.name === 'return_complete_refund') m.ret = baseReturn({ status: 'received' });
      });

      it('preview lists before/after rows and an etag; a hand edit moves the etag', async () => {
        const a = await tool(c.name).preview!(ctx(), parse(c.name, c.args));
        expect(a.rows.length).toBeGreaterThan(0);
        expect(a.etag).toMatch(/^[0-9a-f]{32}$/);
        expect(a.affectedCount).toBe(1);
        m.ret = { ...m.ret, updatedAt: '2026-11-14T11:00:00.000Z' };
        expect((await tool(c.name).preview!(ctx(), parse(c.name, c.args))).etag).not.toBe(a.etag);
      });

      it('apply goes through runAsMerchant as the assistant and calls the route service with the session store', async () => {
        const t = tool(c.name);
        const args = parse(c.name, c.args);
        const r = await t.apply!(ctx(), args, await t.preview!(ctx(), args));
        expect(r.ok).toBe(true);
        expect(m.rs[c.svc]).toHaveBeenCalledTimes(1);
        expect(m.rs[c.svc].mock.calls[0][0]).toBe('S1');
        expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({
          actor: 'assistant',
          phase: 'intent',
          tool: c.name,
        });
      });

      it('a role without the route permission gets ToolForbidden and nothing runs', async () => {
        const t = tool(c.name);
        const args = parse(c.name, c.args);
        const d = await t.preview!(ctx(), args);
        const noPerm = c.name === 'return_complete_refund' ? 'staff' : 'customer';
        await expect(t.apply!(ctx(noPerm), args, d)).rejects.toBeInstanceOf(ToolForbidden);
        expect(m.rs[c.svc]).not.toHaveBeenCalled();
        expect(m.insertAuditLog).not.toHaveBeenCalled();
      });

      it('a plan without the returns feature is refused at preview and at apply', async () => {
        const t = tool(c.name);
        const args = parse(c.name, c.args);
        const d = await t.preview!(ctx(), args);
        m.featureEnabled.mockResolvedValue(false);
        await expect(t.preview!(ctx(), args)).rejects.toBeInstanceOf(Error);
        await expect(t.apply!(ctx(), args, d)).rejects.toBeInstanceOf(ToolForbidden);
        expect(m.rs[c.svc]).not.toHaveBeenCalled();
      });

      it('a role without the permission never gets a card (refused at PREVIEW)', async () => {
        const noPerm = c.name === 'return_complete_refund' ? 'staff' : 'customer';
        await expect(
          tool(c.name).preview!(ctx(noPerm), parse(c.name, c.args))
        ).rejects.toBeInstanceOf(Error);
        expect(m.rs.getById).not.toHaveBeenCalled();
      });

      it('a foreign return id never reaches run (the store-scoped service 404s)', async () => {
        m.rs.getById.mockRejectedValue(new Error('Return request not found'));
        const t = tool(c.name);
        const args = parse(c.name, { ...c.args, returnId: 'FOREIGN' });
        await expect(t.preview!(ctx(), args)).rejects.toThrow('not found');
        await expect(t.apply!(ctx(), args, {} as never)).rejects.toThrow('not found');
        expect(m.rs[c.svc]).not.toHaveBeenCalled();
      });

      it('reports confirm with the customer_message and irreversible reasons', async () => {
        const t = tool(c.name);
        const d = await t.preview!(ctx(), parse(c.name, c.args));
        const { policy, reasons } = effectivePolicy(t, d);
        expect(policy).toBe('confirm');
        expect(reasons).toEqual(expect.arrayContaining(['customer_message', 'irreversible']));
        if (c.name === 'return_complete_refund') expect(reasons).toContain('money');
      });
    });
  }

  it('reject shows the exact reason the customer will read and carries it in the payload', async () => {
    const t = tool('return_reject');
    const d = await t.preview!(
      ctx(),
      parse('return_reject', { returnId: 'R1', reason: 'المنتج مستخدم' })
    );
    expect(d.rows.some(r => r.after === 'المنتج مستخدم')).toBe(true);
    expect(JSON.stringify(d.payload)).toContain('المنتج مستخدم');
    await t.apply!(ctx(), parse('return_reject', { returnId: 'R1', reason: 'المنتج مستخدم' }), d);
    expect(m.rs.reject).toHaveBeenCalledWith('S1', 'R1', 'u1', 'المنتج مستخدم');
  });

  it('approve and reject only act on a pending return', async () => {
    m.ret = baseReturn({ status: 'completed' });
    await expect(
      tool('return_approve').preview!(ctx(), parse('return_approve', { returnId: 'R1' }))
    ).rejects.toThrow(/expected pending/);
  });

  describe('refund amount', () => {
    beforeEach(() => {
      m.ret = baseReturn({ status: 'received' });
    });
    const shown = async (method: string) => {
      const d = await tool('return_complete_refund').preview!(
        ctx(),
        parse('return_complete_refund', { returnId: 'R1', refundMethod: method })
      );
      return d.rows.find(r => r.label.en === 'Amount (EGP)')!.after;
    };

    it('comes from state(): gateway amount, store credit, or the recorded amount, never from args', async () => {
      expect(await shown('original')).toBe('80');
      expect(await shown('store_credit')).toBe('95');
      expect(await shown('bank_transfer')).toBe('90');
      expect(
        tool('return_complete_refund').args.safeParse({
          returnId: 'R1',
          refundMethod: 'original',
          amount: 1,
        }).success
      ).toBe(false);
    });

    it('a gateway method the provider cannot take is refused at preview', async () => {
      m.preview = {
        ...m.preview,
        gateway: { available: false, amount: null, unavailableReason: 'PAYMENT_FULLY_REFUNDED' },
      };
      await expect(shown('original')).rejects.toThrow(/cannot be refunded/);
    });

    it('only a received or inspecting return can be completed', async () => {
      m.ret = baseReturn({ status: 'pending' });
      await expect(shown('original')).rejects.toThrow(/expected received/);
    });

    it('an unknown method is rejected by the schema', () => {
      expect(
        tool('return_complete_refund').args.safeParse({ returnId: 'R1', refundMethod: 'bitcoin' })
          .success
      ).toBe(false);
    });

    it('apply passes the chosen method and no amount to ReturnService.complete', async () => {
      const t = tool('return_complete_refund');
      const args = parse('return_complete_refund', {
        returnId: 'R1',
        refundMethod: 'store_credit',
      });
      await t.apply!(ctx(), args, await t.preview!(ctx(), args));
      expect(m.rs.complete).toHaveBeenCalledWith('S1', 'R1', 'u1', 'store_credit');
    });
  });
});

describe('returns_policy_set', () => {
  it('is a reversible preview whose preview shows before/after and restores the BEFORE values', async () => {
    const t = tool('returns_policy_set');
    expect(t.policy).toBe('preview');
    expect(t.undo).toBe('reversible');
    const args = parse('returns_policy_set', { returnWindowDays: 30 });
    const d = await t.preview!(ctx(), args);
    expect(d.rows[0]).toMatchObject({ before: 14, after: 30 });
    expect((d.payload as { restore: unknown }).restore).toEqual({ returnWindowDays: 14 });
    expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'returns_policy_set',
      args: { returnWindowDays: 14 },
    });
  });

  it('apply goes through StoreService.update as the assistant; staff is forbidden', async () => {
    const t = tool('returns_policy_set');
    const args = parse('returns_policy_set', { returnFeesPaidBy: 'merchant' });
    const d = await t.preview!(ctx(), args);
    await t.apply!(ctx(), args, d);
    expect(m.store.update).toHaveBeenCalledWith('S1', { returnFeesPaidBy: 'merchant' });
    expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({ actor: 'assistant' });
    m.store.update.mockClear();
    await expect(t.apply!(ctx('staff'), args, d)).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it('staff never gets a policy card (refused at PREVIEW)', async () => {
    await expect(
      tool('returns_policy_set').preview!(
        ctx('staff'),
        parse('returns_policy_set', { returnWindowDays: 30 })
      )
    ).rejects.toBeInstanceOf(Error);
  });

  it('the undo of a policy change passes its own validation and is undone by the engine', async () => {
    const r = await applyThenUndo(returnsTools(), tool('returns_policy_set'), {
      returnWindowDays: 30,
    });
    expect(r.undo).toBe('undone');
    m.storeRow = { returnWindowDays: null, returnFeesPaidBy: null };
    const r2 = await applyThenUndo(returnsTools(), tool('returns_policy_set'), {
      returnWindowDays: 30,
    });
    expect(r2.undo).toBe('undone');
  });

  it('0 days means returns not accepted, null clears it, bad values are refused', () => {
    const t = tool('returns_policy_set');
    expect(t.args.safeParse({ returnWindowDays: 0 }).success).toBe(true);
    expect(t.args.safeParse({ returnWindowDays: null }).success).toBe(true);
    expect(t.args.safeParse({ returnWindowDays: -1 }).success).toBe(false);
    expect(t.args.safeParse({ returnFeesPaidBy: 'nobody' }).success).toBe(false);
    expect(t.args.safeParse({}).success).toBe(false);
  });
});
