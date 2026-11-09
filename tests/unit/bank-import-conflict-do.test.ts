/**
 * Ruling NZ-FEAT-1 (re-review M-4): two imports of overlapping bank files on a DO store both read "not imported yet"; the second
 * atomic batch then hits the (store_id, row_hash) unique and rolls back whole. That is a 409 BANK_IMPORT_CONFLICT the merchant
 * can retry, never a 500. Deterministic: the race is forced by the mocks (the read sees nothing, the batch reports P2002).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const transaction = vi.fn();
const autoMatchReads = vi.fn();

vi.mock('@ebda/database', () => ({ withStore: vi.fn(), prisma: {} }));
vi.mock('../../apps/api/src/services/accounting/assert-store-owns', () => ({
  assertStoreOwns: vi.fn(),
  assertStoreOwnsInTenantScope: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeRepo: vi.fn(async () => ({ backend: 'do' })),
  storeMoney: vi.fn(async () => null),
  storeDb: vi.fn(async () => ({
    bankTransaction: { findMany: vi.fn(async () => []) },
    bankStatement: { findFirst: autoMatchReads },
  })),
  storeWriter: vi.fn(async () => ({
    bankStatement: { create: vi.fn(() => Promise.resolve({ id: 's' })) },
    bankTransaction: { createMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    $transaction: transaction,
  })),
}));

import { importBankStatement } from '../../apps/api/src/services/accounting/bank-reconcile.service';

const csv = Buffer.from(
  [
    'Date,Description,Debit,Credit,Reference',
    '2026-01-10,Rent,100.000,,R1',
    '2026-01-11,Sale,,50.000,R2',
  ].join('\n'),
  'utf-8'
);
const input = {
  storeId: 's1',
  glAccountId: 'gl-1',
  fileName: 'jan.csv',
  buffer: csv,
  fileType: 'csv' as const,
};

describe('bank statement import on a DO store: concurrent overlap', () => {
  beforeEach(() => {
    transaction.mockReset();
    autoMatchReads.mockReset();
  });

  it('answers 409 BANK_IMPORT_CONFLICT when the batch loses the row-hash race, and runs no auto-match', async () => {
    transaction.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed on the fields: (store_id,row_hash)'), {
        code: 'P2002',
      })
    );
    await expect(importBankStatement(input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'BANK_IMPORT_CONFLICT',
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(autoMatchReads).not.toHaveBeenCalled();
  });

  it('any other batch failure is not disguised as a conflict', async () => {
    transaction.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'P2003' }));
    await expect(importBankStatement(input)).rejects.toThrow('boom');
  });
});
