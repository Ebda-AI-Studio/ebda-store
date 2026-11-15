/** Finance suggest tools (plan 4 E4): one card = one record; no batch apply. */
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
  postManualEntry: vi.fn(),
  applyManualMatch: vi.fn(),
  recordFxRate: vi.fn(),
  latestFxRate: vi.fn(),
  getProfitAnomaly: vi.fn(),
  acknowledgeProfitAnomaly: vi.fn(),
  submit: vi.fn(),
  getProfile: vi.fn(),
  bankTx: new Map<string, Record<string, unknown>>(),
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
vi.mock('@api/lib/report-range', () => ({ storeTimeZone: async () => 'Africa/Cairo' }));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    bankTransaction: {
      findFirst: async ({ where }: { where: { id: string } }) => m.bankTx.get(where.id) ?? null,
    },
    journalEntry: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === 'J1' ? { entryNumber: 7, memo: 'sale' } : null,
    },
  }),
}));
vi.mock('@api/services/accounting/journal.service', () => ({ postManualEntry: m.postManualEntry }));
vi.mock('@api/services/accounting/account.service', () => ({
  listAccountsTree: async () => m.tree,
  createChildAccount: vi.fn(),
}));
vi.mock('@api/services/accounting/bank-reconcile.service', () => ({
  applyManualMatch: m.applyManualMatch,
}));
vi.mock('@api/services/accounting/fx-rate.service', () => ({
  recordFxRate: m.recordFxRate,
  latestFxRate: m.latestFxRate,
}));
vi.mock('@api/services/accounting/profit-anomaly.service', () => ({
  getProfitAnomaly: m.getProfitAnomaly,
  acknowledgeProfitAnomaly: m.acknowledgeProfitAnomaly,
}));
vi.mock('@api/services/accounting/reports.service', () => ({
  balanceSheet: vi.fn(),
  profitAndLoss: vi.fn(),
}));
vi.mock('@api/services/accounting/dashboard-stock', () => ({ dashboardStockValues: vi.fn() }));
vi.mock('@api/services/accounting/tax-report.service', () => ({ generateTaxReport: vi.fn() }));
vi.mock('@api/services/fiscal-document.service', () => ({
  FiscalDocumentService: { list: vi.fn(), getById: vi.fn() },
}));
vi.mock('@api/services/tax-profile.service', () => ({
  TaxProfileService: { get: m.getProfile, submit: m.submit },
}));

import { financeSuggestTools } from '@api/smart-layer/tools/finance-suggest.tools';

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
const t = (name: string): ToolSpec => financeSuggestTools().find(x => x.name === name)!;
const node = (id: string, code: string, type: string, isActive = true) => ({
  id,
  code,
  nameEn: `acct ${code}`,
  nameAr: `حساب ${code}`,
  type,
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
const bankRow = (id: string, status = 'unmatched', je: string | null = null) => ({
  id,
  date: new Date('2026-11-01T00:00:00Z'),
  description: 'TRANSFER',
  amountFils: 25000,
  direction: 'credit',
  matchStatus: status,
  matchedJournalEntryId: je,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.postManualEntry.mockResolvedValue({ id: 'E1' });
  m.applyManualMatch.mockResolvedValue({ id: 'T1' });
  m.tree = {
    assets: [node('A1', '1010', 'asset'), node('OFF', '1020', 'asset', false)],
    revenue: [node('A2', '4000', 'revenue')],
  };
  m.bankTx.clear();
});

describe('journal_entry_suggest', () => {
  const j = () => t('journal_entry_suggest');
  it('there is no tool that posts more than one journal entry per apply', async () => {
    expect(j().args.safeParse([entry, entry]).success).toBe(false);
    expect(j().args.safeParse({ entries: [entry] }).success).toBe(false);
    expect(financeSuggestTools().some(x => /batch|bulk/i.test(x.name))).toBe(false);
    const args = j().args.parse(entry) as never;
    const d = await j().preview!(ctx(), args);
    expect(d.affectedCount).toBe(1);
    expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
    await j().apply!(ctx(), args, d);
    expect(m.postManualEntry).toHaveBeenCalledTimes(1);
    const call = m.postManualEntry.mock.calls[0][0];
    expect(call.lines).toEqual([
      expect.objectContaining({ accountId: 'A1', debit: 10050, credit: 0, currency: 'EGP' }),
      expect.objectContaining({ accountId: 'A2', debit: 0, credit: 10050, currency: 'EGP' }),
    ]);
    expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({
      actor: 'assistant',
      tool: 'journal_entry_suggest',
    });
  });
  it('is confirm, money, irreversible, no inverse; an unbalanced, disabled or foreign line never reaches run', async () => {
    const d = await j().preview!(ctx(), j().args.parse(entry) as never);
    const e = effectivePolicy(j(), d);
    expect(e.reasons).toEqual(expect.arrayContaining(['declared', 'money', 'irreversible']));
    expect(j().inverse).toBeUndefined();
    const bad = (lines: unknown) => j().preview!(ctx(), j().args.parse({ lines }) as never);
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
  it('staff and a store without accounting get ToolForbidden at apply', async () => {
    const args = j().args.parse(entry) as never;
    const d = await j().preview!(ctx(), args);
    await expect(j().apply!(ctx('staff'), args, d)).rejects.toBeInstanceOf(ToolForbidden);
    m.featureEnabled.mockResolvedValue(false);
    await expect(j().apply!(ctx(), args, d)).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.postManualEntry).not.toHaveBeenCalled();
  });
});

describe('bank_match_suggest', () => {
  const b = () => t('bank_match_suggest');
  it('a reconciliation suggestion for 30 lines produces 30 separate cards, none auto-applied', async () => {
    for (let i = 0; i < 30; i++) m.bankTx.set(`T${i}`, bankRow(`T${i}`));
    expect(
      b().args.safeParse({ transactions: [{ transactionId: 'T1', action: 'ignore' }] }).success
    ).toBe(false);
    const cards = [];
    for (let i = 0; i < 30; i++) {
      cards.push(
        await b().preview!(
          ctx(),
          b().args.parse({ transactionId: `T${i}`, action: 'match', journalEntryId: 'J1' }) as never
        )
      );
    }
    expect(cards).toHaveLength(30);
    expect(cards.every(c => c.affectedCount === 1)).toBe(true);
    expect(new Set(cards.map(c => JSON.stringify(c.payload))).size).toBe(30);
    expect(m.applyManualMatch).not.toHaveBeenCalled();
  });
  it('apply matches exactly one line as the assistant; the inverse restores the before state', async () => {
    m.bankTx.set('T1', bankRow('T1'));
    const args = b().args.parse({
      transactionId: 'T1',
      action: 'match',
      journalEntryId: 'J1',
    }) as never;
    const d = await b().preview!(ctx(), args);
    expect(d.rows.map(r => r.before)).toContain('unmatched');
    await b().apply!(ctx(), args, d);
    expect(m.applyManualMatch).toHaveBeenCalledTimes(1);
    expect(m.applyManualMatch).toHaveBeenCalledWith({
      storeId: 'S1',
      transactionId: 'T1',
      action: 'match',
      journalEntryId: 'J1',
    });
    expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({ actor: 'assistant' });
    expect(b().inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'bank_match_suggest',
      args: { transactionId: 'T1', action: 'unmatch' },
    });
    m.bankTx.set('T2', bankRow('T2', 'manual_matched', 'J9'));
    const a2 = b().args.parse({ transactionId: 'T2', action: 'ignore' }) as never;
    const d2 = await b().preview!(ctx(), a2);
    expect(b().inverse!(ctx(), a2, d2, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'bank_match_suggest',
      args: { transactionId: 'T2', action: 'match', journalEntryId: 'J9' },
    });
  });
  it('a foreign transaction or journal entry never reaches run; staff is forbidden', async () => {
    m.bankTx.set('T1', bankRow('T1'));
    await expect(
      b().preview!(ctx(), b().args.parse({ transactionId: 'NOPE', action: 'ignore' }) as never)
    ).rejects.toThrow();
    await expect(
      b().preview!(
        ctx(),
        b().args.parse({ transactionId: 'T1', action: 'match', journalEntryId: 'FOREIGN' }) as never
      )
    ).rejects.toThrow();
    await expect(
      b().preview!(ctx(), b().args.parse({ transactionId: 'T1', action: 'match' }) as never)
    ).rejects.toThrow();
    const args = b().args.parse({ transactionId: 'T1', action: 'ignore' }) as never;
    const d = await b().preview!(ctx(), args);
    await expect(b().apply!(ctx('staff'), args, d)).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.applyManualMatch).not.toHaveBeenCalled();
  });
});

describe('fx, anomaly and VAT submit', () => {
  it('fx_rate_set records ONE rate, shows before/after, is irreversible without an inverse', async () => {
    m.latestFxRate.mockResolvedValue({ id: 'R0', rate: '47', rateDate: new Date('2026-11-01') });
    const f = t('fx_rate_set');
    const args = f.args.parse({ currency: 'USD', rate: 48.5 }) as never;
    const d = await f.preview!(ctx(), args);
    expect(d.rows[0]).toMatchObject({ before: '47', after: '48.5' });
    expect(f.inverse).toBeUndefined();
    await f.apply!(ctx(), args, d);
    expect(m.recordFxRate).toHaveBeenCalledTimes(1);
    expect(f.args.safeParse({ currency: 'EGP', rate: 1 }).success).toBe(false);
  });
  it('profit_anomaly_ack resolves the anomaly in this store only', async () => {
    const a = t('profit_anomaly_ack');
    m.getProfitAnomaly.mockResolvedValueOnce(null);
    await expect(a.preview!(ctx(), a.args.parse({ anomalyId: 'X' }) as never)).rejects.toThrow();
    m.getProfitAnomaly.mockResolvedValue({
      id: 'N1',
      metric: 'margin_drop',
      severity: 'p0',
      deltaPercent: -41.2,
      acknowledged: false,
    });
    const args = a.args.parse({ anomalyId: 'N1' }) as never;
    const d = await a.preview!(ctx(), args);
    expect(d.affectedCount).toBe(1);
    await a.apply!(ctx(), args, d);
    expect(m.acknowledgeProfitAnomaly).toHaveBeenCalledWith('S1', 'N1', 'u1');
  });
  it('vat_registration_submit is confirm + irreversible and refuses an incomplete profile', async () => {
    const v = t('vat_registration_submit');
    expect(v.policy).toBe('confirm');
    expect(v.undo).toBe('irreversible');
    m.getProfile.mockResolvedValue({
      status: 'none',
      taxRegistrationNumber: null,
      legalName: null,
      documents: [],
      submittedAt: null,
    });
    await expect(v.preview!(ctx(), {} as never)).rejects.toThrow();
    m.getProfile.mockResolvedValue({
      status: 'none',
      taxRegistrationNumber: '123',
      legalName: 'X Co',
      documents: [{ id: 'd1' }],
      submittedAt: null,
    });
    const d = await v.preview!(ctx(), {} as never);
    await v.apply!(ctx(), {} as never, d);
    expect(m.submit).toHaveBeenCalledWith('S1', { userId: 'u1' });
  });
});

describe('every tool', () => {
  it('has no store id argument and reads are free', () => {
    for (const x of financeSuggestTools())
      expect(JSON.stringify(x.jsonSchema)).not.toMatch(/store_?id/i);
    expect(t('finance_overview').policy).toBe('free');
    expect(t('invoices_list').policy).toBe('free');
  });
});
