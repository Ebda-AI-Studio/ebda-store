/** Engine-level undo of bank_match_suggest (the only finance suggest tool with an inverse); the others are irreversible by declaration. */
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  state: { matchStatus: 'unmatched', matchedJournalEntryId: null as string | null },
  applyManualMatch: vi.fn(),
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: async () => undefined }));
vi.mock('@api/middleware/security', () => ({ auditLog: async () => undefined }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    bankTransaction: {
      findFirst: async () => ({
        id: 'T1',
        date: new Date('2026-11-01T00:00:00Z'),
        description: 'TRANSFER',
        amountFils: 25000,
        direction: 'credit',
        ...m.state,
      }),
    },
    journalEntry: { findFirst: async () => ({ entryNumber: 7, memo: 'sale' }) },
  }),
  storeSmartLayer: vi.fn(),
  storeRepo: vi.fn(),
}));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => undefined }));
vi.mock('@api/services/accounting/bank-reconcile.service', () => ({
  applyManualMatch: async (i: { action: string; journalEntryId?: string }) => {
    m.applyManualMatch(i);
    m.state =
      i.action === 'match'
        ? { matchStatus: 'manual_matched', matchedJournalEntryId: i.journalEntryId! }
        : i.action === 'ignore'
          ? { matchStatus: 'ignored', matchedJournalEntryId: null }
          : { matchStatus: 'unmatched', matchedJournalEntryId: null };
  },
}));

import { financeSuggestTools } from '@api/smart-layer/tools/finance-suggest.tools';
import { applyThenUndo } from './helpers/undo-roundtrip';

const tools = financeSuggestTools();
const bank = tools.find(x => x.name === 'bank_match_suggest')!;

describe('bank_match_suggest undo', () => {
  it('apply then undo restores the unmatched state through the engine', async () => {
    m.state = { matchStatus: 'unmatched', matchedJournalEntryId: null };
    const r = await applyThenUndo(tools, bank, {
      transactionId: 'T1',
      action: 'match',
      journalEntryId: 'J1',
    });
    expect(r.applied).toBe('applied');
    expect(r.undo).toBe('undone');
    expect(m.state.matchStatus).toBe('unmatched');
    expect(m.applyManualMatch).toHaveBeenCalledTimes(2);
  });
  it('the inverse of an ignore and of a re-match validates against the tool schema', () => {
    for (const restore of [
      { matchStatus: 'ignored', matchedJournalEntryId: null },
      { matchStatus: 'manual_matched', matchedJournalEntryId: 'J9' },
      { matchStatus: 'unmatched', matchedJournalEntryId: null },
    ]) {
      const op = bank.inverse!(
        {} as never,
        { transactionId: 'T1', action: 'match', journalEntryId: 'J1' } as never,
        { payload: { restore } } as never,
        { ok: true, etagAfter: 'x' }
      );
      expect(bank.args.safeParse(op!.args).success).toBe(true);
    }
  });
});
