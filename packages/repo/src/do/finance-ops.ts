// Finance admin operations on the StoreDO (Ruling NZ-FEAT-1): the manual journal entry (a GL write, so a named op and never the
// generic `mutate`), and two read-only aggregates the Postgres twin computes with raw SQL (the bank reconciliation ledger side,
// the stock value of the finance dashboard). Pure synchronous functions over `SyncSql`; every query is scoped by `store_id`.
import { MoneyError, type SyncSql } from './sync-sql';
import { nextJournalNumber } from './ledger';

const FX_SCALE = 100_000_000; // journal_lines.fx_rate is numeric(16,8) stored as an integer of 1e-8

type Args = Record<string, unknown>;
const bad = (what: string): never => {
  throw new MoneyError('BAD_ARGS', what, 400);
};
const int = (v: unknown, what: string): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : bad(what);
const optStr = (v: unknown, what: string, max = 2000): string | null => {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && v.length <= max ? v : bad(what);
};

interface ManualLine {
  accountId: string;
  debit: number;
  credit: number;
  lineMemo: string | null;
  lineMemoAr: string | null;
  currency: string;
  fxRate: number | null;
  originalAmount: number;
}

/**
 * A manual adjusting entry (the twin of `postEntry` with `source: 'manual'`, no source id: manual entries are never coalesced).
 * Invariants, all inside ONE `transactionSync` section so a refusal leaves nothing behind:
 *   - at least two lines, each with exactly one of debit / credit positive (the table's own CHECK, reported as a 400 not a 500);
 *   - total debits = total credits, in piastres (the accounting invariant is always in the base currency);
 *   - every account exists in THIS store (404 `ACCOUNT_NOT_FOUND`, never naming whether another store has it) and is active
 *     (409 `ACCOUNT_INACTIVE`: a disabled account is not a posting target);
 *   - a foreign-currency line carries its rate and original amount (the caller has already converted debit / credit to base).
 * Not enforced, like the Postgres twin: that the account is a leaf (a system parent such as 1200 is a valid target).
 */
export function journalManualOp(
  db: SyncSql,
  storeId: string,
  a: Args
): { id: string; entryNumber: string } {
  const lines = a.lines;
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 200) bad('lines');
  const parsed: ManualLine[] = (lines as Args[]).map((l, i) => {
    if (!l || typeof l !== 'object') bad(`lines[${i}]`);
    const accountId =
      typeof l.accountId === 'string' && l.accountId ? l.accountId : bad('accountId');
    const debit = int(l.debit, 'debit');
    const credit = int(l.credit, 'credit');
    if (debit > 0 === credit > 0)
      throw new MoneyError(
        'JOURNAL_BAD_LINE',
        'each journal line needs exactly one of debit or credit above zero',
        400
      );
    const currency =
      typeof l.currency === 'string' && /^[A-Z]{3}$/.test(l.currency) ? l.currency : 'EGP';
    const fx = l.fxRate === undefined || l.fxRate === null ? null : Number(l.fxRate);
    if (fx !== null && !(Number.isFinite(fx) && fx > 0)) bad('fxRate');
    return {
      accountId: accountId as string,
      debit,
      credit,
      lineMemo: optStr(l.lineMemo, 'lineMemo'),
      lineMemoAr: optStr(l.lineMemoAr, 'lineMemoAr'),
      currency,
      fxRate: fx,
      originalAmount:
        l.originalAmount === undefined ? debit || credit : int(l.originalAmount, 'originalAmount'),
    };
  });
  const dr = parsed.reduce((s, l) => s + l.debit, 0);
  const cr = parsed.reduce((s, l) => s + l.credit, 0);
  if (dr !== cr)
    throw new MoneyError('JOURNAL_UNBALANCED', `Journal lines unbalanced: DR=${dr} CR=${cr}`, 400);
  const postedAt = a.postedAtMs === undefined || a.postedAtMs === null ? Date.now() : a.postedAtMs;
  if (typeof postedAt !== 'number' || !Number.isFinite(postedAt)) bad('postedAtMs');
  const memo = optStr(a.memo, 'memo');
  const memoAr = optStr(a.memoAr, 'memoAr');
  const postedBy = optStr(a.postedBy, 'postedBy', 128);

  return db.transactionSync(() => {
    const ids = [...new Set(parsed.map(l => l.accountId))];
    const found = db.all(
      `SELECT id, is_active FROM accounts WHERE store_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      [storeId, ...ids]
    );
    if (found.length !== ids.length)
      throw new MoneyError('ACCOUNT_NOT_FOUND', 'One or more accounts were not found', 404);
    if (found.some(r => !r.is_active))
      throw new MoneyError('ACCOUNT_INACTIVE', 'A disabled account cannot be posted to', 409);

    const now = Date.now();
    const id = crypto.randomUUID();
    const entryNumber = nextJournalNumber(db, storeId, now);
    db.run(
      `INSERT INTO journal_entries (id, store_id, entry_number, posted_at, source, source_id, memo, memo_ar, status, posted_by, created_at)
       VALUES (?, ?, ?, ?, 'manual', NULL, ?, ?, 'posted', ?, ?)`,
      [id, storeId, entryNumber, postedAt, memo, memoAr, postedBy, now]
    );
    for (const l of parsed) {
      const foreign = l.currency !== 'EGP';
      db.run(
        `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, currency, fx_rate, original_amount, line_memo, line_memo_ar, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          id,
          l.accountId,
          l.debit,
          l.credit,
          l.currency,
          foreign ? Math.round((l.fxRate ?? 1) * FX_SCALE) : FX_SCALE,
          foreign ? l.originalAmount : 0,
          l.lineMemo,
          l.lineMemoAr,
          now,
        ]
      );
    }
    return { id, entryNumber };
  });
}

/**
 * The ledger half of a bank reconciliation difference (read only): the counted (posted + reversed) debit and credit totals of
 * one GL account up to `asOfMs`, and the lines in `[startMs?, asOfMs]` that no bank transaction OF THIS STATEMENT is matched to.
 * Twin of the two raw statements in `getReconciliationDifference`.
 */
export function bankLedgerSideOp(
  db: SyncSql,
  storeId: string,
  a: Args
): { debit: number; credit: number; unmatchedCount: number; unmatchedNet: number } {
  const accountId = typeof a.accountId === 'string' && a.accountId ? a.accountId : bad('accountId');
  const statementId =
    typeof a.statementId === 'string' && a.statementId ? a.statementId : bad('statementId');
  if (typeof a.asOfMs !== 'number' || !Number.isFinite(a.asOfMs)) bad('asOfMs');
  const startMs = a.startMs === undefined || a.startMs === null ? null : a.startMs;
  if (startMs !== null && (typeof startMs !== 'number' || !Number.isFinite(startMs)))
    bad('startMs');
  const t = db.all(
    `SELECT COALESCE(SUM(l.debit), 0) AS d, COALESCE(SUM(l.credit), 0) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND e.store_id = ? AND e.status IN ('posted', 'reversed') AND e.posted_at <= ?`,
    [accountId, storeId, a.asOfMs]
  )[0];
  const u = db.all(
    `SELECT COUNT(*) AS n, COALESCE(SUM(l.debit), 0) AS d, COALESCE(SUM(l.credit), 0) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ?1 AND e.store_id = ?2 AND e.status IN ('posted', 'reversed')
        AND (?4 IS NULL OR e.posted_at >= ?4) AND e.posted_at <= ?3
        AND NOT EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.matched_journal_entry_id = e.id AND bt.statement_id = ?5)`,
    [accountId, storeId, a.asOfMs, startMs, statementId]
  )[0];
  return {
    debit: Number(t?.d ?? 0),
    credit: Number(t?.c ?? 0),
    unmatchedCount: Number(u?.n ?? 0),
    unmatchedNet: Number(u?.d ?? 0) - Number(u?.c ?? 0),
  };
}

/**
 * Cost coverage of the stock figure (SQLite twin of `STOCK_COST_COVERAGE_SQL`, lib/effective-inventory-sql.ts): how many
 * products hold on-hand units, and how many of those have a unit with NO cost (variant cost, else the parent's). A stock
 * value built on such a unit is partial or unknown, never a true 0.
 */
export const STOCK_COST_COVERAGE_SQLITE = `
       COALESCE(SUM(CASE
         WHEN EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id)
         THEN EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active AND pv.inventory > 0)
         ELSE p.inventory > 0 END), 0) AS stocked,
       COALESCE(SUM(CASE
         WHEN EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id)
         THEN EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active AND pv.inventory > 0
                         AND COALESCE(pv.cost_price, p.cost_price) IS NULL)
         ELSE (p.inventory > 0 AND p.cost_price IS NULL) END), 0) AS uncosted`;

/**
 * On-hand stock value in piastres (read only), and the value held on DISABLED variants: the twin of `STOCK_VALUE_SQL` /
 * `DISABLED_VARIANT_STOCK_VALUE_SQL` (lib/effective-inventory-sql.ts). A variant product is valued per ACTIVE variant at the
 * variant's own cost, falling back to the parent's.
 */
export function stockValueOp(
  db: SyncSql,
  storeId: string
): { value: number; disabledValue: number; stockedProducts: number; uncostedProducts: number } {
  const r = db.all(
    `SELECT
       COALESCE(SUM(CASE
         WHEN EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id)
         THEN COALESCE((SELECT SUM(pv.inventory * COALESCE(pv.cost_price, p.cost_price, 0))
                          FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active), 0)
         ELSE p.inventory * COALESCE(p.cost_price, 0)
       END), 0) AS v,
       COALESCE(SUM(COALESCE((SELECT SUM(pv.inventory * COALESCE(pv.cost_price, p.cost_price, 0))
                                FROM product_variants pv
                               WHERE pv.product_id = p.id AND NOT pv.is_active AND pv.inventory > 0), 0)), 0) AS dv,
       ${STOCK_COST_COVERAGE_SQLITE}
     FROM products p WHERE p.store_id = ? AND p.deleted_at IS NULL`,
    [storeId]
  )[0];
  return {
    value: Number(r?.v ?? 0),
    disabledValue: Number(r?.dv ?? 0),
    stockedProducts: Number(r?.stocked ?? 0),
    uncostedProducts: Number(r?.uncosted ?? 0),
  };
}
