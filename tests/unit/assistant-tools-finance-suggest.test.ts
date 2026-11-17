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

import {
  financeSuggestTools,
  journalEntrySuggest,
} from '@api/smart-layer/tools/finance-suggest.tools';

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
const t = (name: string): ToolSpec =>
  [...financeSuggestTools(), journalEntrySuggest].find(x => x.name === name)!;
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

describe('journal_entry_suggest is closed to every merchant role until the route allows owners', () => {
  const j = () => journalEntrySuggest;
  it('an owner (store_admin) is refused at preview and at apply; nothing is posted', async () => {
    const args = j().args.parse(entry) as never;
    await expect(j().preview!(ctx('store_admin'), args)).rejects.toThrow(/FORBIDDEN/);
    await expect(j().apply!(ctx('store_admin'), args, {} as never)).rejects.toBeInstanceOf(
      ToolForbidden
    );
    await expect(j().preview!(ctx('staff'), args)).rejects.toThrow(/FORBIDDEN/);
    expect(m.postManualEntry).not.toHaveBeenCalled();
  });
  it('the args schema rejects a list of entries', () => {
    expect(j().args.safeParse([entry, entry]).success).toBe(false);
    expect(j().args.safeParse({ entries: [entry] }).success).toBe(false);
    expect(financeSuggestTools().some(x => /batch|bulk/i.test(x.name))).toBe(false);
    expect(financeSuggestTools().some(x => x.name === 'journal_entry_suggest')).toBe(false);
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
  const profile = {
    status: 'none',
    taxRegistrationNumber: '123',
    legalName: 'X Co',
    documents: [{ id: 'd1' }],
    submittedAt: null,
  };
  it('vat_registration_submit is confirm + irreversible and refuses an incomplete profile', async () => {
    const v = t('vat_registration_submit');
    expect(v.policy).toBe('confirm');
    expect(v.undo).toBe('irreversible');
    m.getProfile.mockResolvedValue({
      ...profile,
      taxRegistrationNumber: null,
      legalName: null,
      documents: [],
    });
    await expect(v.preview!(ctx(), v.args.parse({ attest: true }) as never)).rejects.toThrow();
    m.getProfile.mockResolvedValue(profile);
    const args = v.args.parse({ attest: true }) as never;
    const d = await v.preview!(ctx(), args);
    await v.apply!(ctx(), args, d);
    expect(m.submit).toHaveBeenCalledWith('S1', { userId: 'u1' });
  });
  it('the legal statement is a card row and part of the hashed payload; without the attestation the tool refuses', async () => {
    const v = t('vat_registration_submit');
    m.getProfile.mockResolvedValue(profile);
    expect(v.args.safeParse({}).success).toBe(false);
    expect(v.args.safeParse({ attest: false }).success).toBe(false);
    const d = await v.preview!(ctx(), v.args.parse({ attest: true }) as never);
    const row = d.rows.find(r => String(r.after).includes('مسجّلة في ضريبة القيمة المضافة'));
    expect(row).toBeTruthy();
    expect(String(row!.after)).toContain('registered for VAT with the Egyptian Tax Authority');
    expect(JSON.stringify(d.payload)).toContain('مسجّلة في ضريبة القيمة المضافة');
    expect(JSON.stringify(d.payload)).toContain('attest');
    expect(await v.preview!(ctx(), { attest: false } as never).catch(() => 'refused')).toBe(
      'refused'
    );
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

describe('Ruling SL-E4-1', () => {
  it('the raw journal entry tool is built but never offered (the route is super_admin only)', () => {
    expect(financeSuggestTools().some(x => x.name === 'journal_entry_suggest')).toBe(false);
    expect(journalEntrySuggest.name).toBe('journal_entry_suggest');
  });
});

// ---- gates of EVERY tool: staff at preview, staff at apply, plan feature off ------------------------------------------------------------
const GOOD: Record<string, unknown> = {
  account_add: { parentId: 'A1', code: '101010', nameEn: 'Petty' },
  bank_match_suggest: { transactionId: 'T1', action: 'ignore' },
  fx_rate_set: { currency: 'USD', rate: 48.5 },
  profit_anomaly_ack: { anomalyId: 'N1' },
  vat_registration_submit: { attest: true },
};
const FEATURE: Record<string, boolean> = {
  account_add: true,
  bank_match_suggest: true,
  fx_rate_set: true,
  profit_anomaly_ack: true,
  vat_registration_submit: false,
};

describe.each(Object.keys(GOOD))('%s gates', name => {
  beforeEach(() => {
    m.bankTx.set('T1', bankRow('T1'));
    m.getProfitAnomaly.mockResolvedValue({
      id: 'N1',
      metric: 'm',
      severity: 'p0',
      deltaPercent: 1,
      acknowledged: false,
    });
    m.latestFxRate.mockResolvedValue(null);
    m.getProfile.mockResolvedValue({
      status: 'none',
      taxRegistrationNumber: '123',
      legalName: 'X',
      documents: [{ id: 'd' }],
      submittedAt: null,
    });
  });
  const args = () => t(name).args.parse(GOOD[name]) as never;
  it('staff never gets a card', async () => {
    await expect(t(name).preview!(ctx('staff'), args())).rejects.toThrow(/FORBIDDEN/);
  });
  it('staff is refused at apply and nothing runs', async () => {
    await expect(t(name).apply!(ctx('staff'), args(), {} as never)).rejects.toBeInstanceOf(
      ToolForbidden
    );
    for (const fn of [m.applyManualMatch, m.recordFxRate, m.acknowledgeProfitAnomaly, m.submit])
      expect(fn).not.toHaveBeenCalled();
  });
  it.runIf(FEATURE[name])(
    'a store without the plan feature is refused at preview and apply',
    async () => {
      m.featureEnabled.mockResolvedValue(false);
      await expect(t(name).preview!(ctx(), args())).rejects.toThrow(/FORBIDDEN/);
      await expect(t(name).apply!(ctx(), args(), {} as never)).rejects.toBeInstanceOf(
        ToolForbidden
      );
    }
  );
});

describe.each([
  ['finance_overview', {}, true],
  ['finance_profit_and_loss', {}, true],
  ['finance_balance_sheet', {}, true],
  ['finance_vat_report', { from: '2026-10-01', to: '2026-10-31' }, true],
  ['bank_unmatched_list', {}, true],
  ['profit_anomalies_list', {}, true],
  ['invoices_list', {}, false],
  ['invoice_get', { documentId: 'D1' }, false],
])('%s read gates', (name, a, hasFeature) => {
  const run = (role: string) => t(name).read!(ctx(role), t(name).args.parse(a) as never);
  it('a customer role is refused', async () => {
    await expect(run('customer')).rejects.toThrow(/forbidden/);
  });
  it('staff is refused where the route is owner-only', async () => {
    if (name.startsWith('invoice')) return; // routes allow staff
    await expect(run('staff')).rejects.toThrow(/forbidden/);
  });
  it.runIf(hasFeature)('a store without the plan feature is refused', async () => {
    m.featureEnabled.mockResolvedValue(false);
    await expect(run('store_admin')).rejects.toThrow(/forbidden/);
  });
});
