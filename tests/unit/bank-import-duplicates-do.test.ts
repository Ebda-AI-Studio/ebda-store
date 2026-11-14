/**
 * ACCT-AUDIT-6: a bank import on a DO store stores every genuinely repeated line (two identical POS charges are two charges),
 * and `imported` counts only the rows this import stored; lines an earlier statement already holds are counted apart.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const created: Array<Record<string, any>> = [];
const existing = vi.hoisted(() => ({ hashes: [] as string[] }));

vi.mock('@ebda/database', () => ({ withStore: vi.fn(), prisma: {} }));
vi.mock('../../apps/api/src/services/accounting/assert-store-owns', () => ({
  assertStoreOwns: vi.fn(),
  assertStoreOwnsInTenantScope: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeRepo: vi.fn(async () => ({ backend: 'do' })),
  storeMoney: vi.fn(async () => null),
  storeDb: vi.fn(async () => ({
    bankTransaction: {
      findMany: vi.fn(async (a: { where: { rowHash?: { in: string[] } } }) =>
        (a.where.rowHash?.in ?? [])
          .filter(h => existing.hashes.includes(h))
          .map(rowHash => ({ rowHash }))
      ),
      count: vi.fn(async () => 0),
    },
    bankStatement: { findFirst: vi.fn(async () => ({ glAccountId: 'gl' })) },
    journalLine: { findMany: vi.fn(async () => []) },
  })),
  storeWriter: vi.fn(async () => ({
    bankStatement: {
      create: vi.fn(() => Promise.resolve({ id: 's' })),
      update: vi.fn(async () => ({})),
    },
    bankTransaction: {
      updateMany: vi.fn(async () => ({})),
      createMany: vi.fn((a: { data: Array<Record<string, any>> }) => {
        created.push(...a.data);
        return Promise.resolve({ count: a.data.length });
      }),
    },
    $transaction: vi.fn(async () => undefined),
  })),
}));

import { importBankStatement } from '../../apps/api/src/services/accounting/bank-reconcile.service';
import { parseStatementCsv } from '../../apps/api/src/services/accounting/bank-statement-parser';

const csv = Buffer.from(
  'date,description,amount\n2026-11-01,POS purchase,-50.00\n2026-11-01,POS purchase,-50.00\n2026-11-02,Sale,75.00',
  'utf-8'
);
const input = {
  storeId: 's1',
  glAccountId: 'gl',
  fileName: 'n.csv',
  buffer: csv,
  fileType: 'csv' as const,
};

beforeEach(() => {
  created.length = 0;
  existing.hashes = [];
});

describe('bank import on a DO store: repeated lines and the imported count', () => {
  it('stores both identical lines and reports 3 imported', async () => {
    const r = await importBankStatement(input);
    expect(created).toHaveLength(3);
    expect(r).toMatchObject({ imported: 3, alreadyImported: 0 });
  });

  it('lines an earlier statement already holds are skipped and counted, not reported as imported', async () => {
    existing.hashes = [parseStatementCsv(csv).rows[2].rowHash];
    const r = await importBankStatement(input);
    expect(created).toHaveLength(2);
    expect(r).toMatchObject({ imported: 2, alreadyImported: 1 });
  });
});
