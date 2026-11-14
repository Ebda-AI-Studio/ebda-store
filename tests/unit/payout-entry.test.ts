/**
 * ACCT-AUDIT-11: a gateway payout (net of its fee) and a COD remittance are booked as ONE balanced entry through the real DO
 * manual-journal code: DR bank (net) + DR bank fees (fee) / CR the cash-in-transit account (gross), so the bank deposit ties.
 */
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../../packages/repo/src/do/money-ops';
import { MoneyError } from '../../packages/repo/src/do/sync-sql';
import { opKey } from '../../apps/api/src/lib/money-idempotency';
import { buildPayoutLines } from '../../apps/api/src/services/accounting/payout.service';

const ACCTS: Array<[string, string, string]> = [
  ['1000', 'Cash Online', 'asset'],
  ['1020', 'Cash COD', 'asset'],
  ['1030', 'Bank Main', 'asset'],
  ['5800', 'Bank Fees', 'expense'],
];
function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  raw.exec(`INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES ('s1', 1);`);
  for (const [c, n, t] of ACCTS)
    raw.exec(
      `INSERT INTO accounts (id, store_id, code, name_en, type, is_system, is_active) VALUES ('a${c}', 's1', '${c}', '${n}', '${t}', 1, 1)`
    );
  const post = (lines: unknown[], key?: string) =>
    runMoneyOp(db, 's1', 'journalManual', { memo: 'Payout', lines }, key) as { id: string };
  const bal = (code: string) =>
    Number(
      raw
        .prepare(
          `SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?`
        )
        .get(code)!.b
    );
  return { post, bal, raw };
}

describe('buildPayoutLines', () => {
  const ids = { from: 'a1000', bank: 'a1030', fee: 'a5800' };

  it('a 1000.00 payout with a 25.50 fee: bank 974.50 + fees 25.50 against the gateway balance 1000.00', () => {
    expect(
      buildPayoutLines({
        fromAccountId: ids.from,
        bankAccountId: ids.bank,
        feeAccountId: ids.fee,
        grossMinor: 100000,
        feeMinor: 2550,
      })
    ).toEqual([
      expect.objectContaining({ accountId: 'a1030', debit: 97450, credit: 0 }),
      expect.objectContaining({ accountId: 'a5800', debit: 2550, credit: 0 }),
      expect.objectContaining({ accountId: 'a1000', debit: 0, credit: 100000 }),
    ]);
  });

  it('no fee: two lines; a fee at or above the gross, a fractional or non-positive amount is refused', () => {
    expect(
      buildPayoutLines({
        fromAccountId: ids.from,
        bankAccountId: ids.bank,
        feeAccountId: ids.fee,
        grossMinor: 500,
        feeMinor: 0,
      })
    ).toHaveLength(2);
    for (const [gross, fee] of [
      [500, 500],
      [500, 600],
      [0, 0],
      [10.5, 0],
      [500, -1],
      [500, 0.5],
    ])
      expect(() =>
        buildPayoutLines({
          fromAccountId: ids.from,
          bankAccountId: ids.bank,
          feeAccountId: ids.fee,
          grossMinor: gross,
          feeMinor: fee,
        })
      ).toThrow();
  });

  it('the same account on both sides is refused', () => {
    expect(() =>
      buildPayoutLines({
        fromAccountId: 'a1030',
        bankAccountId: 'a1030',
        feeAccountId: ids.fee,
        grossMinor: 500,
        feeMinor: 0,
      })
    ).toThrow();
  });
});

describe('payout through the real DO manual journal', () => {
  it('moves the gateway balance to the bank net of the fee, balanced, and a replay with the same key posts once', () => {
    const r = rig();
    // the sale had put 1000.00 on the gateway balance
    r.post([
      { accountId: 'a1000', debit: 100000, credit: 0 },
      { accountId: 'a1030', debit: 0, credit: 100000 },
    ]);
    const lines = buildPayoutLines({
      fromAccountId: 'a1000',
      bankAccountId: 'a1030',
      feeAccountId: 'a5800',
      grossMinor: 100000,
      feeMinor: 2550,
    });
    const first = r.post(lines, opKey('journal-manual:s1', 'k1'));
    const again = r.post(lines, opKey('journal-manual:s1', 'k1'));
    expect(again.id).toBe(first.id);
    expect(r.bal('1000')).toBe(0); // the gateway balance is cleared
    expect(r.bal('5800')).toBe(2550);
    expect(r.bal('1030')).toBe(-100000 + 97450); // bank now ties to the deposit it received
    const t = r.raw.prepare('SELECT SUM(debit) d, SUM(credit) c FROM journal_lines').get() as {
      d: number;
      c: number;
    };
    expect(t.d).toBe(t.c);
  });

  it('a COD remittance is the same entry from 1020 with no fee', () => {
    const r = rig();
    r.post(
      buildPayoutLines({
        fromAccountId: 'a1020',
        bankAccountId: 'a1030',
        feeAccountId: 'a5800',
        grossMinor: 45000,
        feeMinor: 0,
      })
    );
    expect(r.bal('1020')).toBe(-45000);
    expect(r.bal('1030')).toBe(45000);
  });

  it('a refused entry writes nothing', () => {
    const r = rig();
    expect(() =>
      r.post([
        { accountId: 'a1000', debit: 100, credit: 0 },
        { accountId: 'nope', debit: 0, credit: 100 },
      ])
    ).toThrow(MoneyError);
    expect(
      Number((r.raw.prepare('SELECT count(*) n FROM journal_entries').get() as { n: number }).n)
    ).toBe(0);
  });
});
