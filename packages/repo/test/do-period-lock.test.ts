// ACCT-AUDIT-4 and ACCT-AUDIT-9: the period lock and the merchant-reversible manual entry on the real DO schema (node:sqlite).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
const OCT28 = Date.UTC(2026, 9, 28, 9, 0, 0);
const NOV1 = Date.UTC(2026, 10, 1, 0, 0, 0); // the first instant of the open period
function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  raw.exec(`INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES ('s1', 1);`);
  for (const [code, name, type] of [
    ['1000', 'Cash', 'asset'],
    ['3000', 'Equity', 'equity'],
    ['5200', 'Rent', 'expense'],
  ])
    raw.exec(
      `INSERT INTO accounts (id, store_id, code, name_en, type, is_system, is_active) VALUES ('a${code}', 's1', '${code}', '${name}', '${type}', 1, 1)`
    );
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  const op = (name: string, args: Record<string, unknown>) => runMoneyOp(db, S, name, args) as any;
  const code = (name: string, args: Record<string, unknown>): string => {
    try {
      op(name, args);
    } catch (e) {
      return `${(e as MoneyError).code}/${(e as MoneyError).status}`;
    }
    return 'no error';
  };
  const lock = (untilMs: number | null) =>
    raw.exec(
      `UPDATE store_config SET settings = '${JSON.stringify(
        untilMs === null ? {} : { accountingLock: { through: '2026-10-31', untilMs } }
      )}' WHERE store_id = 's1'`
    );
  return { raw, q, op, code, lock };
}
const manual = (postedAtMs?: number, extra: Record<string, unknown> = {}) => ({
  memo: 'capital',
  postedAtMs,
  lines: [
    { accountId: 'a1000', debit: 1000, credit: 0 },
    { accountId: 'a3000', debit: 0, credit: 1000 },
  ],
  ...extra,
});

describe('period lock (ACCT-AUDIT-4)', () => {
  it('a manual entry dated inside a closed month is refused 409 PERIOD_LOCKED and writes nothing', () => {
    const r = rig();
    r.lock(NOV1);
    expect(r.code('journalManual', manual(OCT28))).toBe('PERIOD_LOCKED/409');
    expect(r.q('SELECT count(*) n FROM journal_entries')[0].n).toBe(0);
  });

  it('a manual entry in the open month, and one with no date, post', () => {
    const r = rig();
    r.lock(NOV1);
    expect(r.code('journalManual', manual(NOV1 + 5000))).toBe('no error');
    expect(r.code('journalManual', manual(undefined))).toBe('no error');
  });

  it('before any lock is set nothing is refused', () => {
    const r = rig();
    expect(r.code('journalManual', manual(OCT28))).toBe('no error');
  });

  it('a system journal dated in a closed month is posted on the first open instant instead of failing the job', () => {
    const r = rig();
    r.lock(NOV1);
    r.raw.exec(
      `INSERT INTO expenses (id, store_id, expense_number, expense_account_id, paid_from_account_id, amount, total, expense_date, status) VALUES ('e1', 's1', 'EXP-1', 'a5200', 'a1000', 500, 500, ${OCT28}, 'posted')`
    );
    expect(r.op('journalExpense', { expenseId: 'e1' })).toEqual({ posted: true });
    expect(Number(r.q('SELECT posted_at p FROM journal_entries')[0].p)).toBe(NOV1);
  });

  it('closed-month entries stay put: the totals of October do not change after the lock', () => {
    const r = rig();
    r.op('journalManual', manual(OCT28));
    r.lock(NOV1);
    r.raw.exec(
      `INSERT INTO expenses (id, store_id, expense_number, expense_account_id, paid_from_account_id, amount, total, expense_date, status) VALUES ('e1', 's1', 'EXP-1', 'a5200', 'a1000', 500, 500, ${OCT28}, 'posted')`
    );
    r.op('journalExpense', { expenseId: 'e1' });
    const oct = r.q(
      'SELECT COALESCE(SUM(l.debit),0) d FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.posted_at < ?',
      NOV1
    )[0].d;
    expect(Number(oct)).toBe(1000);
  });
});

describe('merchant-reversible manual entry (ACCT-AUDIT-9)', () => {
  it('reverses a manual entry: a mirror entry with the reason and the actor, the original marked reversed', () => {
    const r = rig();
    const { id } = r.op('journalManual', manual(OCT28));
    const out = r.op('journalReverseManual', { entryId: id, reason: 'wrong account', actor: 'u1' });
    expect(out.reversalId).toBeTruthy();
    const rows = r.q(
      'SELECT id, status, memo, posted_by, reversed_by_id FROM journal_entries ORDER BY created_at'
    );
    expect(rows[0]).toMatchObject({ status: 'reversed', reversed_by_id: out.reversalId });
    expect(rows[1]).toMatchObject({ posted_by: 'u1' });
    expect(rows[1].memo).toContain('wrong account');
    const t = r.q('SELECT SUM(debit) d, SUM(credit) c FROM journal_lines')[0];
    expect(t.d).toBe(t.c);
    const net = r.q(
      `SELECT SUM(l.debit - l.credit) n FROM journal_lines l WHERE l.account_id = 'a1000'`
    )[0].n;
    expect(Number(net)).toBe(0);
  });

  it('reverses once only, refuses a system entry and an unknown id', () => {
    const r = rig();
    const { id } = r.op('journalManual', manual(OCT28));
    r.op('journalReverseManual', { entryId: id, reason: 'oops', actor: 'u1' });
    expect(r.code('journalReverseManual', { entryId: id, reason: 'again', actor: 'u1' })).toBe(
      'JOURNAL_ALREADY_REVERSED/409'
    );
    r.raw.exec(
      `INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, source_id, status, created_at) VALUES ('sys', 's1', 'JE-9', 1, 'order', 'o1', 'posted', 1)`
    );
    expect(r.code('journalReverseManual', { entryId: 'sys', reason: 'abc', actor: 'u1' })).toBe(
      'JOURNAL_NOT_MANUAL/409'
    );
    expect(r.code('journalReverseManual', { entryId: 'nope', reason: 'abc', actor: 'u1' })).toBe(
      'JOURNAL_NOT_FOUND/404'
    );
  });

  it('a reversal of an entry in a closed month posts today, in the open period', () => {
    const r = rig();
    const { id } = r.op('journalManual', manual(OCT28));
    r.lock(NOV1);
    expect(r.code('journalReverseManual', { entryId: id, reason: 'late fix', actor: 'u1' })).toBe(
      'no error'
    );
    expect(
      Number(
        r.q(
          'SELECT posted_at p FROM journal_entries WHERE source = ? ORDER BY posted_at DESC',
          'manual'
        )[0].p
      )
    ).toBeGreaterThanOrEqual(NOV1);
  });
});
