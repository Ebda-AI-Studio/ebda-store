import { prisma } from '@ebda/database';
import { storeMoney } from '../../lib/repo-factory';

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  type: string;
  debitTotal: number;
  creditTotal: number;
  /** debits - credits (positive for asset/expense; negative for liability/revenue/equity natural balance) */
  balance: number;
  /**
   * Set only on the computed "retained + current earnings" equity row the
   * balance sheet adds (see `balanceSheet`). It is not an account in the chart
   * of accounts, so it has no real `accountId` and no journal lines.
   */
  kind?: 'current_earnings';
}

/**
 * Entry statuses that count toward a balance.
 *
 * `reversed` MUST be included, alongside `posted`: `reverseEntry` does not
 * delete or zero the original — it flips the original to `reversed` and posts
 * a mirror entry as `posted`. Counting only `posted` keeps the mirror and
 * drops the original, so every refund would be subtracted twice (the same
 * defect the analytics cashflow chart had). The pair nets to zero only when
 * both halves are summed. `draft` never counts.
 */
export const COUNTED_STATUSES_SQL = `e.status IN ('posted', 'reversed')`;

/**
 * Per-account debit/credit totals over journal entries whose `posted_at`
 * falls in [from, to] (either bound optional).
 *
 * The entry predicate (status + date window) is applied to the LINES through
 * an INNER join inside the per-account subquery. The previous form put that
 * predicate in the ON clause of a `LEFT JOIN journal_entries` while summing
 * lines from an unconditional `LEFT JOIN journal_lines` — the predicate then
 * only decided whether `e.*` was NULL, never which lines were summed, so every
 * call returned all-time totals regardless of `asOf`, and every
 * `profitAndLoss` (closing − opening) came out 0.
 *
 * Every account of the store is returned (zero totals when it has no lines),
 * which is what the report UIs render.
 *
 * Uses $queryRawUnsafe with explicit parameter binding because Prisma's tagged-
 * template $queryRaw does not support conditional SQL fragments.
 * Schema-qualified table names (public.*) are required for pgbouncer
 * transaction-mode compatibility.
 */
async function accountTotals(
  storeId: string,
  window: { from?: Date; to?: Date }
): Promise<TrialBalanceRow[]> {
  // A store on its Durable Object answers from its own ledger (Ruling CF-JOBS-4): the same totals, one statement in the DO.
  const money = await storeMoney(storeId);
  if (money) {
    const { rows } = await money.accountTotals({
      ...(window.from ? { fromMs: window.from.getTime() } : {}),
      ...(window.to ? { toMs: window.to.getTime() } : {}),
    });
    return rows.map(r => ({
      accountId: r.id,
      code: r.code,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      type: r.type,
      debitTotal: r.debit,
      creditTotal: r.credit,
      balance: r.debit - r.credit,
    }));
  }
  // Prisma 6.19 $queryRawUnsafe rejects JS Date objects ("Could not convert
  // from JSON date object to PrismaValue"), so pass an ISO string. A bound
  // string binds as `text`, and `posted_at` is `timestamp without time zone`
  // (Prisma's default DateTime mapping) — there is no `timestamp >= text`
  // operator, so the SQL casts each param explicitly with `::timestamp`.
  // `.toISOString()` is UTC wall-clock; `'...Z'::timestamp` drops the Z to the
  // same naive UTC value Prisma stores, so the comparison is unchanged.
  const params: unknown[] = [storeId];
  const entryFilters: string[] = [COUNTED_STATUSES_SQL];
  if (window.from) {
    params.push(window.from.toISOString());
    entryFilters.push(`e.posted_at >= $${params.length}::timestamp`);
  }
  if (window.to) {
    params.push(window.to.toISOString());
    entryFilters.push(`e.posted_at <= $${params.length}::timestamp`);
  }

  const sql = `
    SELECT
      a.id,
      a.code,
      a.name_en,
      a.name_ar,
      a.type::text,
      COALESCE(t.debit_total, 0)  AS debit_total,
      COALESCE(t.credit_total, 0) AS credit_total
    FROM public.accounts a
    LEFT JOIN (
      SELECT l.account_id,
             SUM(l.debit)  AS debit_total,
             SUM(l.credit) AS credit_total
      FROM public.journal_lines l
      JOIN public.journal_entries e ON e.id = l.entry_id
      WHERE e.store_id = $1
        AND ${entryFilters.join('\n        AND ')}
      GROUP BY l.account_id
    ) t ON t.account_id = a.id
    WHERE a.store_id = $1
    ORDER BY a.code ASC
  `;

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      code: string;
      name_en: string;
      name_ar: string | null;
      type: string;
      debit_total: bigint | number;
      credit_total: bigint | number;
    }>
  >(sql, ...params);

  return rows.map(r => ({
    accountId: r.id,
    code: r.code,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    type: r.type,
    debitTotal: Number(r.debit_total),
    creditTotal: Number(r.credit_total),
    balance: Number(r.debit_total) - Number(r.credit_total),
  }));
}

/**
 * Aggregates all counted journal lines by account with `posted_at <= asOf`
 * (or all time when `asOf` is omitted). An entry posted after `asOf` does not
 * contribute — that is what makes a historical trial balance / balance sheet /
 * opening balance mean anything.
 */
export async function trialBalance(storeId: string, asOf?: Date): Promise<TrialBalanceRow[]> {
  return accountTotals(storeId, { to: asOf });
}

/** Net income (revenue − expenses) from a set of account totals. */
function netIncomeOf(rows: TrialBalanceRow[]) {
  // Revenue accounts are credit-natural: net revenue = credit - debit
  const totalRevenue = rows
    .filter(r => r.type === 'revenue')
    .reduce((s, r) => s + r.creditTotal - r.debitTotal, 0);
  // Expense accounts are debit-natural: total expenses = debit - credit
  const totalExpenses = rows
    .filter(r => r.type === 'expense')
    .reduce((s, r) => s + r.debitTotal - r.creditTotal, 0);
  return { totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses };
}

/**
 * Profit & loss for entries posted in [from, to] (both bounds inclusive).
 * One windowed aggregation — only the period's own activity is summed.
 */
export async function profitAndLoss(storeId: string, from: Date, to: Date) {
  const periodRows = await accountTotals(storeId, { from, to });

  const revenue = periodRows.filter(r => r.type === 'revenue');
  const expenses = periodRows.filter(r => r.type === 'expense');
  const { totalRevenue, totalExpenses, netIncome } = netIncomeOf(periodRows);

  return { from, to, revenue, expenses, totalRevenue, totalExpenses, netIncome };
}

/**
 * Balance-sheet snapshot as of `asOf`.
 * Buckets accounts by type: asset / liability / equity.
 * totalLiabilities + totalEquity sign-flipped (credit-natural accounts).
 *
 * The ledger has no period-closing entries (revenue and expense accounts are
 * never closed into equity), so the cumulative net income up to `asOf` still
 * sits in the revenue/expense accounts. Without it, Assets ≠ Liabilities +
 * Equity by exactly that amount. It is shown as ONE computed equity row —
 * "retained + current earnings" — derived from the same `asOf` totals, never
 * written to the ledger.
 */
export async function balanceSheet(storeId: string, asOf: Date) {
  const tb = await trialBalance(storeId, asOf);

  const assets = tb.filter(r => r.type === 'asset');
  const liabilities = tb.filter(r => r.type === 'liability');
  const { netIncome: earnings } = netIncomeOf(tb);
  const earningsRow: TrialBalanceRow = {
    accountId: 'current-earnings',
    code: '',
    nameEn: 'Retained & current earnings',
    nameAr: 'الأرباح المحتجزة والحالية',
    type: 'equity',
    debitTotal: earnings < 0 ? -earnings : 0,
    creditTotal: earnings > 0 ? earnings : 0,
    // Credit-natural like every equity row: a profit is a negative balance.
    balance: -earnings,
    kind: 'current_earnings',
  };
  const equity = [...tb.filter(r => r.type === 'equity'), earningsRow];

  // Assets are debit-natural: positive balance means value
  const totalAssets = assets.reduce((s, r) => s + r.balance, 0);
  // Liabilities + equity are credit-natural: negate balance for natural sign
  const totalLiabilities = liabilities.reduce((s, r) => s + -r.balance, 0);
  const totalEquity = equity.reduce((s, r) => s + -r.balance, 0);

  return {
    asOf,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    currentEarnings: earnings,
    /** Assets − (Liabilities + Equity), in piastres. 0 when the books balance. */
    difference: totalAssets - (totalLiabilities + totalEquity),
  };
}
