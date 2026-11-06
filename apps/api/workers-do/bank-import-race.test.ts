import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createDoClient } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { isP2002 } from '../src/lib/prisma-errors';

// Ruling NZ-FEAT-1 (review of #469, I-1): the bank import's race guard on the REAL StoreDO SQLite (workerd). Two overlapping imports
// both read "these row hashes are new"; each then writes ONE batch (statement + createMany). The loser's batch hits the
// (store_id, row_hash) unique: the DO answers P2002 through the RPC (the error `importBankStatement` maps to 409
// BANK_IMPORT_CONFLICT via `isP2002`) and NOTHING of the losing batch stays: no statement row, not even its new lines.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const clientFor = (storeId: string) => {
  const stub = e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
  return createDoClient(
    q => stub.query(storeId, q as never),
    m => stub.mutate(storeId, m as never)
  ) as any;
};

describe('bank statement import race on the StoreDO', () => {
  it('the losing batch is a P2002 (-> 409) and leaves no statement and no line behind', async () => {
    const storeId = 'bank-race-1';
    const c = clientFor(storeId);
    const account = await c.account.create({
      data: { storeId, code: '1030', nameEn: 'Bank', type: 'asset', isSystem: true },
    });
    const line = (statementId: string, rowHash: string, amountFils: number) => ({
      statementId,
      storeId,
      date: new Date('2026-01-10T00:00:00Z'),
      description: rowHash,
      amountFils,
      direction: 'debit',
      externalRef: rowHash,
      rowHash,
      matchStatus: 'unmatched',
      confidence: 0,
    });
    // the exact batch shape importBankStatement writes on a DO store
    const batch = (statementId: string, rows: Array<[string, number]>) =>
      c.$transaction([
        c.bankStatement.create({
          data: {
            id: statementId,
            storeId,
            glAccountId: account.id,
            fileName: `${statementId}.csv`,
            status: 'pending',
          },
          select: { id: true },
        }),
        c.bankTransaction.createMany({ data: rows.map(([h, a]) => line(statementId, h, a)) }),
      ]);

    // import A wins
    await batch('stmt-a', [
      ['h1', 100],
      ['h2', 200],
    ]);
    // import B read before A committed, so it still carries h2 (plus a genuinely new h3)
    let err: unknown;
    try {
      await batch('stmt-b', [
        ['h2', 200],
        ['h3', 300],
      ]);
    } catch (x) {
      err = x;
    }
    expect(err, 'the losing batch must fail').toBeDefined();
    expect((err as { code?: string }).code).toBe('P2002');
    expect(isP2002(err), 'the service maps exactly this error to 409 BANK_IMPORT_CONFLICT').toBe(
      true
    );

    // nothing of B: no statement, not even its new line h3 (the whole batch rolled back)
    expect(await c.bankStatement.findMany({ where: { storeId }, select: { id: true } })).toEqual([
      { id: 'stmt-a' },
    ]);
    const lines = await c.bankTransaction.findMany({
      where: { storeId },
      select: { rowHash: true, statementId: true },
      orderBy: { rowHash: 'asc' },
    });
    expect(lines).toEqual([
      { rowHash: 'h1', statementId: 'stmt-a' },
      { rowHash: 'h2', statementId: 'stmt-a' },
    ]);
  });
});
