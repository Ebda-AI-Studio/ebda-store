import { prisma } from '@force/database';

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
}

/**
 * Aggregates all posted journal lines by account up to `asOf` (or all time).
 * Uses $queryRawUnsafe with explicit parameter binding because Prisma's tagged-
 * template $queryRaw does not support conditional SQL fragments.
 * Schema-qualified table names (public.*) are required for pgbouncer
 * transaction-mode compatibility.
 */
export async function trialBalance(storeId: string, asOf?: Date): Promise<TrialBalanceRow[]> {
  const baseSql = `
    SELECT
      a.id,
      a.code,
      a.name_en,
      a.name_ar,
      a.type::text,
      COALESCE(SUM(l.debit), 0)  AS debit_total,
      COALESCE(SUM(l.credit), 0) AS credit_total
    FROM public.accounts a
    LEFT JOIN public.journal_lines l ON l.account_id = a.id
    LEFT JOIN public.journal_entries e
      ON e.id = l.entry_id
      AND e.status = 'posted'${asOf ? ' AND e.posted_at <= $2::timestamp' : ''}
    WHERE a.store_id = $1
    GROUP BY a.id, a.code, a.name_en, a.name_ar, a.type
    ORDER BY a.code ASC
  `;
  // Prisma 6.19 $queryRawUnsafe rejects JS Date objects ("Could not convert
  // from JSON date object to PrismaValue"), so pass an ISO string. A bound
  // string binds as `text`, and `posted_at` is `timestamp without time zone`
  // (Prisma's default DateTime mapping) — there is no `timestamp >= text`
  // operator, so the SQL casts the param explicitly with `$2::timestamp`.
  // `.toISOString()` is UTC wall-clock; `'...Z'::timestamp` drops the Z to the
  // same naive UTC value Prisma stores, so the comparison is unchanged.
  const params: unknown[] = asOf ? [storeId, asOf.toISOString()] : [storeId];

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      code: string;
      name_en: string;
      name_ar: string | null;
      type: string;
      debit_total: bigint;
      credit_total: bigint;
    }>
  >(baseSql, ...params);

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
 * Computes period-delta P&L between `from` and `to` dates.
 * Runs two trialBalance calls and subtracts opening balances from closing
 * so only the period's activity is reflected.
 */
export async function profitAndLoss(storeId: string, from: Date, to: Date) {
  const [closingRows, openingRows] = await Promise.all([
    trialBalance(storeId, to),
    trialBalance(storeId, from),
  ]);

  const openingByCode = new Map(openingRows.map(r => [r.code, r]));

  const periodRows = closingRows.map(r => {
    const opening = openingByCode.get(r.code);
    const periodDebit = r.debitTotal - (opening?.debitTotal ?? 0);
    const periodCredit = r.creditTotal - (opening?.creditTotal ?? 0);
    return {
      ...r,
      debitTotal: periodDebit,
      creditTotal: periodCredit,
      balance: periodDebit - periodCredit,
    };
  });

  const revenue = periodRows.filter(r => r.type === 'revenue');
  const expenses = periodRows.filter(r => r.type === 'expense');

  // Revenue accounts are credit-natural: net revenue = credit - debit
  const totalRevenue = revenue.reduce((s, r) => s + r.creditTotal - r.debitTotal, 0);
  // Expense accounts are debit-natural: total expenses = debit - credit
  const totalExpenses = expenses.reduce((s, r) => s + r.debitTotal - r.creditTotal, 0);
  const netIncome = totalRevenue - totalExpenses;

  return { from, to, revenue, expenses, totalRevenue, totalExpenses, netIncome };
}

/**
 * Balance-sheet snapshot as of `asOf`.
 * Buckets accounts by type: asset / liability / equity.
 * totalLiabilities + totalEquity sign-flipped (credit-natural accounts).
 */
export async function balanceSheet(storeId: string, asOf: Date) {
  const tb = await trialBalance(storeId, asOf);

  const assets = tb.filter(r => r.type === 'asset');
  const liabilities = tb.filter(r => r.type === 'liability');
  const equity = tb.filter(r => r.type === 'equity');

  // Assets are debit-natural: positive balance means value
  const totalAssets = assets.reduce((s, r) => s + r.balance, 0);
  // Liabilities + equity are credit-natural: negate balance for natural sign
  const totalLiabilities = liabilities.reduce((s, r) => s + -r.balance, 0);
  const totalEquity = equity.reduce((s, r) => s + -r.balance, 0);

  return { asOf, assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity };
}
