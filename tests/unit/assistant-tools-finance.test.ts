/** Finance assistant tools (plan 4 C2): expense_add (confirm class, money, irreversible). */
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
  createExpense: vi.fn(),
  getSupplier: vi.fn(),
  tree: {} as Record<string, unknown[]>,
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
vi.mock('@api/lib/jobs/store-db', () => ({
  runInStoreCtx: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/accounting/expense.service', () => ({ createExpense: m.createExpense }));
vi.mock('@api/services/accounting/supplier.service', () => ({ getSupplier: m.getSupplier }));
vi.mock('@api/services/accounting/account.service', () => ({
  listAccountsTree: async () => m.tree,
}));

import { financeTools } from '@api/smart-layer/tools/finance.tools';

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
const t = (): ToolSpec => financeTools().find(x => x.name === 'expense_add')!;
const node = (id: string, code: string, type: string) => ({
  id,
  code,
  nameEn: `acct ${code}`,
  nameAr: `حساب ${code}`,
  type,
  isSystem: true,
  isActive: true,
  children: [],
});
const good = {
  expenseAccountId: 'E1',
  paidFromAccountId: 'B1',
  amountEgp: 250.5,
  taxAmountEgp: 35.07,
  expenseDate: '2026-11-10',
  notesAr: 'فاتورة النت',
};
const parse = (a: unknown) => t().args.parse(a) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.createExpense.mockResolvedValue({ id: 'X1' });
  m.getSupplier.mockResolvedValue(null);
  m.tree = {
    assets: [node('B1', '1010', 'asset'), node('INV', '1200', 'asset')],
    expenses: [node('E1', '5100', 'expense')],
  };
});

describe('expense_add', () => {
  it('is confirm-class, money, irreversible, with no inverse and no store id argument', () => {
    expect(t().policy).toBe('confirm');
    expect(t().money).toBe(true);
    expect(t().undo).toBe('irreversible');
    expect(t().inverse).toBeUndefined();
    expect(JSON.stringify(t().jsonSchema)).not.toMatch(/store_?id/i);
  });

  it('the card shows the exact EGP amounts and a confirm-class tool built with money reports it', async () => {
    const d = await t().preview!(ctx(), parse(good));
    const text = JSON.stringify(d.rows);
    expect(text).toContain('"250.5"');
    expect(text).toContain('"35.07"');
    expect(text).toContain('"285.57"');
    expect(d.affectedCount).toBe(1);
    expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
    const e = effectivePolicy(t(), d);
    expect(e.policy).toBe('confirm');
    expect(e.reasons).toEqual(expect.arrayContaining(['declared', 'money', 'irreversible']));
  });

  it('apply goes through runAsMerchant as the assistant and creates a draft in piasters', async () => {
    const args = parse(good);
    const d = await t().preview!(ctx(), args);
    const r = await t().apply!(ctx(), args, d);
    expect(r.ok).toBe(true);
    expect(m.createExpense).toHaveBeenCalledTimes(1);
    expect(m.createExpense.mock.calls[0][0]).toMatchObject({
      storeId: 'S1',
      createdBy: 'u1',
      expenseAccountId: 'E1',
      paidFromAccountId: 'B1',
      amount: 25050,
      taxAmount: 3507,
    });
    expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({
      actor: 'assistant',
      phase: 'intent',
      tool: 'expense_add',
    });
  });

  it('staff gets ToolForbidden, and a store without the accounting feature does too', async () => {
    const args = parse(good);
    const d = await t().preview!(ctx(), args);
    await expect(t().apply!(ctx('staff'), args, d)).rejects.toBeInstanceOf(ToolForbidden);
    m.featureEnabled.mockResolvedValue(false);
    await expect(t().apply!(ctx(), args, d)).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.createExpense).not.toHaveBeenCalled();
  });

  it('a foreign account or supplier, or a non cash/bank paid-from, never reaches run', async () => {
    await expect(
      t().preview!(ctx(), parse({ ...good, expenseAccountId: 'FOREIGN' }))
    ).rejects.toThrow();
    await expect(
      t().preview!(ctx(), parse({ ...good, paidFromAccountId: 'INV' }))
    ).rejects.toThrow();
    await expect(
      t().preview!(ctx(), parse({ ...good, supplierId: 'FOREIGN-SUP' }))
    ).rejects.toThrow();
    expect(m.createExpense).not.toHaveBeenCalled();
  });

  it('rejects bad amounts and dates at the edge and carries no way to set currency, status or posting', () => {
    for (const bad of [
      { ...good, amountEgp: 0 },
      { ...good, amountEgp: -5 },
      { ...good, expenseDate: '10/11/2026' },
      { ...good, expenseDate: '2026-13-45' },
      { ...good, currency: 'USD' },
      { ...good, status: 'posted' },
    ])
      expect(t().args.safeParse(bad).success).toBe(false);
  });

  it('an account renamed by hand changes the etag', async () => {
    const a = await t().preview!(ctx(), parse(good));
    m.tree = { ...m.tree, expenses: [{ ...node('E1', '5100', 'expense'), nameAr: 'غيرتها' }] };
    expect((await t().preview!(ctx(), parse(good))).etag).not.toBe(a.etag);
  });
});
