/** journal_entry_suggest logic with the role gate stubbed open (the real gate is closed, see assistant-tools-finance-suggest.test.ts): one apply posts exactly one entry. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { effectivePolicy, type TurnCtx, type ToolSpec } from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({ postManualEntry: vi.fn(), tree: {} as Record<string, unknown[]> }));
vi.mock('@api/mcp/run-as-merchant', () => ({
  MerchantForbidden: class extends Error {},
  assertMerchantMay: async () => undefined,
  runAsMerchant: async (_g: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  runInStoreCtx: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/accounting/journal.service', () => ({ postManualEntry: m.postManualEntry }));
vi.mock('@api/services/accounting/account.service', () => ({
  listAccountsTree: async () => m.tree,
  createChildAccount: vi.fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({ storeDb: vi.fn() }));
vi.mock('@api/lib/report-range', () => ({ storeTimeZone: async () => 'Africa/Cairo' }));
vi.mock('@api/services/accounting/bank-reconcile.service', () => ({}));
vi.mock('@api/services/accounting/fx-rate.service', () => ({}));
vi.mock('@api/services/accounting/profit-anomaly.service', () => ({}));
vi.mock('@api/services/accounting/reports.service', () => ({}));
vi.mock('@api/services/accounting/tax-report.service', () => ({}));
vi.mock('@api/services/accounting/dashboard-stock', () => ({}));
vi.mock('@api/services/fiscal-document.service', () => ({ FiscalDocumentService: {} }));
vi.mock('@api/services/tax-profile.service', () => ({ TaxProfileService: {} }));

import { journalEntrySuggest } from '@api/smart-layer/tools/finance-suggest.tools';

const ctx: TurnCtx = {
  product: 'store',
  storeId: 'S1',
  userId: 'u1',
  role: 'store_admin',
  locale: 'ar',
  now: 1,
  conversationId: 'c',
  releaseId: 'r',
};
const j = (): ToolSpec => journalEntrySuggest;
const node = (id: string, code: string, isActive = true) => ({
  id,
  code,
  nameEn: code,
  nameAr: code,
  type: 'asset',
  isSystem: true,
  isActive,
  children: [],
});
const entry = {
  memoAr: 'تسوية',
  lines: [
    { accountId: 'A1', debitEgp: 100.5 },
    { accountId: 'A2', creditEgp: 100.5 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.postManualEntry.mockResolvedValue({ id: 'E1' });
  m.tree = { assets: [node('A1', '1010'), node('A2', '4000'), node('OFF', '1020', false)] };
});

describe('journal_entry_suggest logic', () => {
  it('one apply posts exactly one entry, in piasters, EGP', async () => {
    const args = j().args.parse(entry) as never;
    const d = await j().preview!(ctx, args);
    expect(d.affectedCount).toBe(1);
    expect(effectivePolicy(j(), d).reasons).toEqual(
      expect.arrayContaining(['declared', 'money', 'irreversible'])
    );
    expect(j().inverse).toBeUndefined();
    await j().apply!(ctx, args, d);
    expect(m.postManualEntry).toHaveBeenCalledTimes(1);
    expect(m.postManualEntry.mock.calls[0][0].lines).toEqual([
      expect.objectContaining({ accountId: 'A1', debit: 10050, credit: 0, currency: 'EGP' }),
      expect.objectContaining({ accountId: 'A2', debit: 0, credit: 10050, currency: 'EGP' }),
    ]);
  });
  it('an unbalanced, disabled-account or foreign-account entry never reaches run', async () => {
    const bad = (lines: unknown) => j().preview!(ctx, j().args.parse({ lines }) as never);
    await expect(
      bad([
        { accountId: 'A1', debitEgp: 5 },
        { accountId: 'A2', creditEgp: 6 },
      ])
    ).rejects.toThrow(/must equal/);
    await expect(
      bad([
        { accountId: 'OFF', debitEgp: 5 },
        { accountId: 'A2', creditEgp: 5 },
      ])
    ).rejects.toThrow(/disabled/);
    await expect(
      bad([
        { accountId: 'FOREIGN', debitEgp: 5 },
        { accountId: 'A2', creditEgp: 5 },
      ])
    ).rejects.toThrow();
    expect(m.postManualEntry).not.toHaveBeenCalled();
  });
});
