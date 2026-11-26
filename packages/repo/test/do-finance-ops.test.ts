// Ruling NZ-FEAT-1: the finance admin operations on the DO schema (node:sqlite): the manual journal entry, the bank
// reconciliation ledger side, the dashboard stock value, and the generic read / write shapes the finance routes rely on
// (journal include with the self relation, bank `_count`, createMany, cascade delete, relation-filtered journal lines).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { nodeSqlRunner } from './node-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';
import { MoneyError } from '../src/do/sync-sql';
import { createPrismaLite } from '../src/prisma-lite/client';
import { runWrites, ensureIdempotencySchema, DO_WRITABLE_MODELS } from '../src/rpc/writes';
import { META } from './diff-harness';

const S = 's1';
function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  for (const [code, name, type, active] of [
    ['1000', 'Cash', 'asset', 1],
    ['1030', 'Bank', 'asset', 1],
    ['3000', 'Equity', 'equity', 1],
    ['4000', 'Sales', 'revenue', 1],
    ['9999', 'Disabled', 'expense', 0],
  ] as const)
    raw.exec(
      `INSERT INTO accounts (id, store_id, code, name_en, type, is_system, is_active) VALUES ('a${code}', 's1', '${code}', '${name}', '${type}', 1, ${active})`
    );
  raw.exec(
    `INSERT INTO accounts (id, store_id, code, name_en, type, is_system, is_active) VALUES ('other', 's2', '1000', 'Foreign', 'asset', 1, 1)`
  );
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, S, name, args, key) as any;
  const code = (name: string, args: Record<string, unknown>): string => {
    try {
      op(name, args);
    } catch (e) {
      return `${(e as MoneyError).code}/${(e as MoneyError).status}`;
    }
    return 'no error';
  };
  const sql = nodeSqlRunner(raw);
  ensureIdempotencySchema(sql);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: S }) as never as any;
  const write = (model: string, opName: string, args: unknown) =>
    runWrites(lite, sql, { ops: [{ model, op: opName as never, args }] } as never, () => 1);
  const batch = (ops: unknown[]) => runWrites(lite, sql, { ops } as never, () => 1);
  return { raw, db, q, op, code, lite, write, batch };
}
const line = (accountId: string, debit: number, credit: number, extra = {}) => ({
  accountId,
  debit,
  credit,
  ...extra,
});

describe('finance operations on the DO (Ruling NZ-FEAT-1)', () => {
  it('are registered, and the finance models are writable while the ledger is not', () => {
    expect(MONEY_OP_NAMES).toEqual(
      expect.arrayContaining(['journalManual', 'bankLedgerSide', 'stockValue'])
    );
    for (const m of ['Account', 'FxRateEntry', 'BankStatement', 'BankTransaction'])
      expect(DO_WRITABLE_MODELS.has(m)).toBe(true);
    for (const m of ['JournalEntry', 'JournalLine']) expect(DO_WRITABLE_MODELS.has(m)).toBe(false);
  });

  describe('journalManual', () => {
    it('posts a balanced entry atomically: entry + lines, a JE number, source manual, posted_by', () => {
      const r = rig();
      const out = r.op('journalManual', {
        memo: 'adjust',
        postedBy: 'u1',
        lines: [line('a1000', 500, 0), line('a3000', 0, 500, { lineMemo: 'x' })],
      });
      expect(out.entryNumber).toMatch(/^JE-\d{4}-000001$/);
      const e = r.q('SELECT * FROM journal_entries');
      expect(e).toHaveLength(1);
      expect(e[0]).toMatchObject({
        source: 'manual',
        source_id: null,
        status: 'posted',
        posted_by: 'u1',
      });
      const l = r.q(
        'SELECT debit, credit, currency, fx_rate FROM journal_lines ORDER BY debit DESC'
      );
      expect(l.map(x => [x.debit, x.credit, x.currency])).toEqual([
        [500, 0, 'EGP'],
        [0, 500, 'EGP'],
      ]);
      expect(l[0].fx_rate).toBe(100_000_000);
    });

    it('stores the FX context of a foreign line (rate x 1e8, original amount)', () => {
      const r = rig();
      r.op('journalManual', {
        lines: [
          line('a1000', 4850, 0, { currency: 'USD', fxRate: 48.5, originalAmount: 100 }),
          line('a3000', 0, 4850),
        ],
      });
      const l = r.q(
        "SELECT currency, fx_rate, original_amount FROM journal_lines WHERE currency = 'USD'"
      );
      expect(l).toEqual([{ currency: 'USD', fx_rate: 4_850_000_000, original_amount: 100 }]);
    });

    it('refuses an unbalanced entry, a bad line, and fewer than two lines, writing nothing', () => {
      const r = rig();
      expect(
        r.code('journalManual', { lines: [line('a1000', 500, 0), line('a3000', 0, 400)] })
      ).toBe('JOURNAL_UNBALANCED/400');
      expect(
        r.code('journalManual', { lines: [line('a1000', 500, 500), line('a3000', 0, 0)] })
      ).toBe('JOURNAL_BAD_LINE/400');
      expect(r.code('journalManual', { lines: [line('a1000', 500, 0)] })).toBe('BAD_ARGS/400');
      expect(
        r.code('journalManual', { lines: [line('a1000', 5.5, 0), line('a3000', 0, 5.5)] })
      ).toBe('BAD_ARGS/400');
      expect(r.q('SELECT * FROM journal_entries')).toHaveLength(0);
      expect(r.q("SELECT * FROM sequences WHERE kind = 'journal'")).toHaveLength(0);
    });

    it('posts only to accounts of THIS store, and only active ones', () => {
      const r = rig();
      expect(r.code('journalManual', { lines: [line('other', 5, 0), line('a3000', 0, 5)] })).toBe(
        'ACCOUNT_NOT_FOUND/404'
      );
      expect(r.code('journalManual', { lines: [line('nope', 5, 0), line('a3000', 0, 5)] })).toBe(
        'ACCOUNT_NOT_FOUND/404'
      );
      expect(r.code('journalManual', { lines: [line('a9999', 5, 0), line('a3000', 0, 5)] })).toBe(
        'ACCOUNT_INACTIVE/409'
      );
      expect(r.q('SELECT * FROM journal_entries')).toHaveLength(0);
    });

    it('a keyed replay posts once; two keyless calls post two entries (manual entries are never coalesced)', () => {
      const r = rig();
      const a = { lines: [line('a1000', 5, 0), line('a3000', 0, 5)] };
      const first = r.op('journalManual', a, 'key-manual-0001');
      expect(r.op('journalManual', a, 'key-manual-0001')).toEqual(first);
      expect(r.q('SELECT * FROM journal_entries')).toHaveLength(1);
      r.op('journalManual', a);
      r.op('journalManual', a);
      expect(r.q('SELECT * FROM journal_entries')).toHaveLength(3);
    });
  });

  describe('bankLedgerSide', () => {
    it('sums counted lines up to as-of and lists the unmatched ones of the period only', () => {
      const r = rig();
      const day = 86_400_000;
      const post = (at: number, debit: number, credit: number, status = 'posted') => {
        const id = `e${at}-${debit}-${credit}`;
        r.raw.exec(
          `INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, status) VALUES ('${id}', 's1', '${id}', ${at}, 'manual', '${status}')`
        );
        r.raw.exec(
          `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit) VALUES ('l${id}', '${id}', 'a1030', ${debit}, ${credit})`
        );
        return id;
      };
      const old = post(1 * day, 1000, 0);
      const inPeriod = post(10 * day, 0, 300);
      const matched = post(11 * day, 200, 0);
      post(12 * day, 50, 0, 'draft'); // never counts
      post(20 * day, 9999, 0); // after as-of
      r.raw.exec(
        `INSERT INTO bank_statements (id, store_id, gl_account_id, file_name) VALUES ('st', 's1', 'a1030', 'f')`
      );
      r.raw.exec(
        `INSERT INTO bank_transactions (id, statement_id, store_id, date, description, amount_fils, direction, row_hash, matched_journal_entry_id, match_status) VALUES ('bt', 'st', 's1', ${11 * day}, 'd', 200, 'debit', 'h', '${matched}', 'manual_matched')`
      );
      const out = r.op('bankLedgerSide', {
        accountId: 'a1030',
        statementId: 'st',
        asOfMs: 15 * day,
        startMs: 5 * day,
      });
      expect(out).toEqual({ debit: 1200, credit: 300, unmatchedCount: 1, unmatchedNet: -300 });
      // no period start: the old entry is unmatched too
      const all = r.op('bankLedgerSide', {
        accountId: 'a1030',
        statementId: 'st',
        asOfMs: 15 * day,
      });
      expect(all).toEqual({ debit: 1200, credit: 300, unmatchedCount: 2, unmatchedNet: 700 });
      void old;
      void inPeriod;
      // another store's ledger is invisible
      expect(
        runMoneyOp(rig().db, 's9', 'bankLedgerSide', {
          accountId: 'a1030',
          statementId: 'st',
          asOfMs: 99 * day,
        })
      ).toMatchObject({ debit: 0, credit: 0, unmatchedCount: 0 });
    });
  });

  describe('stockValue', () => {
    it('values simple products and ACTIVE variants (own cost, else parent), and reports disabled-variant value apart', () => {
      const r = rig();
      r.raw.exec(`
        INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES
          ('p1', 's1', 'Plain', 'plain', 100, 10, 'active', 40),
          ('p2', 's1', 'Var', 'var', 100, 0, 'active', 30),
          ('p3', 's1', 'Gone', 'gone', 100, 5, 'active', 10),
          ('p4', 's2', 'Other store', 'o', 100, 5, 'active', 10);
        UPDATE products SET deleted_at = 1 WHERE id = 'p3';
        INSERT INTO product_variants (id, product_id, title, sku, price, inventory, cost_price, is_active) VALUES
          ('v1', 'p2', 't', 'a', 100, 4, 50, 1),
          ('v2', 'p2', 't', 'b', 100, 2, NULL, 1),
          ('v3', 'p2', 't', 'c', 100, 3, 20, 0);`);
      // p1: 10*40 = 400; p2: 4*50 + 2*30 = 260 (v3 disabled: 3*20 = 60); p3 deleted; p4 other store
      // stocked: p1 + p2 (p3 deleted, p4 other store); every stocked unit has a cost -> uncosted 0
      expect(r.op('stockValue', {})).toEqual({
        value: 660,
        disabledValue: 60,
        stockedProducts: 2,
        uncostedProducts: 0,
      });
    });

    it('counts stocked products with no cost instead of letting them value to a silent 0 (QA N2)', () => {
      const r = rig();
      r.raw.exec(`
        INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES
          ('p1', 's1', 'NoCost', 'nc', 100, 10, 'active', NULL),
          ('p2', 's1', 'Costed', 'c', 100, 2, 'active', 40),
          ('p3', 's1', 'VarNoCost', 'vn', 100, 0, 'active', NULL),
          ('p5', 's1', 'Empty', 'e', 100, 0, 'active', NULL);
        INSERT INTO product_variants (id, product_id, title, sku, price, inventory, cost_price, is_active) VALUES
          ('v1', 'p3', 't', 'a', 100, 3, NULL, 1);`);
      expect(r.op('stockValue', {})).toMatchObject({
        value: 80,
        stockedProducts: 3,
        uncostedProducts: 2,
      });
    });
  });

  describe('the generic shapes the finance routes use, on the DO schema', () => {
    it('chart rows: create a child, deactivate it, tree order by code', async () => {
      const r = rig();
      const out: any = await r.write('Account', 'create', {
        data: {
          storeId: S,
          parentId: 'a1000',
          code: '1001',
          nameEn: 'Till',
          type: 'asset',
          isSystem: false,
          isActive: true,
        },
      });
      expect(out.ok).toBe(true);
      await r.write('Account', 'update', {
        where: { id: 'a1000', storeId: S },
        data: { isActive: false },
      });
      const rows = await r.lite.account.findMany({
        where: { storeId: S },
        orderBy: { code: 'asc' },
      });
      expect(rows.map((x: any) => [x.code, x.isActive])).toEqual([
        ['1000', false],
        ['1001', true],
        ['1030', true],
        ['3000', true],
        ['4000', true],
        ['9999', false],
      ]);
    });

    it('fx rate: a Decimal(16,8) rate and a date round-trip', async () => {
      const r = rig();
      const out: any = await r.write('FxRateEntry', 'create', {
        data: { storeId: S, currency: 'USD', rate: 48.5123, rateDate: new Date('2026-06-15') },
        select: { id: true, currency: true, rate: true, rateDate: true, createdAt: true },
      });
      expect(out.ok).toBe(true);
      const rows = await r.lite.fxRateEntry.findMany({
        where: { storeId: S, rateDate: { gte: new Date('2026-06-01') } },
        orderBy: { rateDate: 'desc' },
        take: 200,
        select: { id: true, currency: true, rate: true, rateDate: true, createdAt: true },
      });
      expect(String(rows[0].rate)).toBe('48.5123');
      expect(rows[0].rateDate.toISOString().slice(0, 10)).toBe('2026-06-15');
    });

    it('journal list/detail shapes: lines with account select, reversedBy / reverses, count', async () => {
      const r = rig();
      const a = r.op('journalManual', { lines: [line('a1000', 5, 0), line('a3000', 0, 5)] });
      const list = await r.lite.journalEntry.findMany({
        where: { storeId: S },
        include: {
          lines: { include: { account: { select: { code: true, nameEn: true, nameAr: true } } } },
        },
        orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 50,
      });
      expect(list).toHaveLength(1);
      expect(list[0].lines.map((l: any) => l.account.code).sort()).toEqual(['1000', '3000']);
      const one = await r.lite.journalEntry.findFirst({
        where: { id: a.id, storeId: S },
        include: { lines: { include: { account: true } }, reversedBy: true, reverses: true },
      });
      expect(one.reversedBy).toBeNull();
      expect(one.reverses).toBeNull();
      expect(await r.lite.journalEntry.count({ where: { storeId: S } })).toBe(1);
      expect(await r.lite.journalEntry.findFirst({ where: { id: 'nope', storeId: S } })).toBeNull();
    });

    it('bank statement: create + createMany in one batch, _count + glAccount select, cascade delete', async () => {
      const r = rig();
      const out: any = await r.batch([
        {
          model: 'BankStatement',
          op: 'create',
          args: {
            data: {
              id: 'st1',
              storeId: S,
              glAccountId: 'a1030',
              fileName: 'f.csv',
              status: 'pending',
            },
            select: { id: true },
          },
        },
        {
          model: 'BankTransaction',
          op: 'createMany',
          args: {
            data: [1, 2, 3].map(i => ({
              statementId: 'st1',
              storeId: S,
              date: new Date(i * 86_400_000),
              description: `d${i}`,
              amountFils: i * 100,
              direction: 'debit',
              rowHash: `h${i}`,
              matchStatus: 'unmatched',
              confidence: 0,
            })),
          },
        },
      ]);
      expect(out, JSON.stringify(out)).toMatchObject({ ok: true });
      const list = await r.lite.bankStatement.findMany({
        where: { storeId: S },
        select: {
          id: true,
          status: true,
          glAccount: { select: { code: true } },
          _count: { select: { transactions: true } },
        },
        orderBy: [{ importedAt: 'desc' }, { id: 'desc' }],
      });
      expect(list[0]).toMatchObject({
        id: 'st1',
        glAccount: { code: '1030' },
        _count: { transactions: 3 },
      });
      // the auto-match read: relation-filtered journal lines
      r.op('journalManual', { lines: [line('a1030', 200, 0), line('a3000', 0, 200)] });
      const lines = await r.lite.journalLine.findMany({
        where: {
          account: { storeId: S },
          debit: { gte: 195, lte: 205 },
          entry: {
            storeId: S,
            status: { in: ['posted', 'reversed'] },
            postedAt: { gte: new Date(0) },
            id: { notIn: ['x'] },
          },
        },
        select: { entryId: true, debit: true, credit: true },
      });
      expect(lines).toHaveLength(1);
      // delete cascades to the rows
      const del: any = await r.write('BankStatement', 'delete', {
        where: { id: 'st1', storeId: S },
      });
      expect(del.ok).toBe(true);
      expect(r.q('SELECT * FROM bank_transactions')).toHaveLength(0);
    });
  });
});
