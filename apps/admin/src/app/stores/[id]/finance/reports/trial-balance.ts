/**
 * STORE-QA-65: `GET /finance/reports/trial-balance` answers `debitTotal` / `creditTotal` (integer minor units, see
 * TrialBalanceRow in apps/api/src/services/accounting/reports.service.ts). The page read `debit` / `credit`, which do not exist, so
 * every cell was `minorToMajor(undefined)` = "NaN.NaN" in the table AND the CSV. One mapper at the edge, integer sums, and a row
 * that is not finite integers fails loudly instead of printing NaN.
 */
export interface ApiTrialBalanceRow {
  code: string;
  nameEn: string;
  nameAr: string | null;
  debitTotal: number;
  creditTotal: number;
  balance: number;
}

export interface TrialBalanceRow {
  code: string;
  nameEn: string;
  nameAr: string | null;
  debit: number;
  credit: number;
  balance: number;
}

const minor = (v: unknown, field: string, code: string): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isFinite(n))
    throw new Error(`trial balance: ${field} of account ${code} is not a number`);
  return Math.round(n);
};

export function toTrialBalanceRows(api: ApiTrialBalanceRow[]): TrialBalanceRow[] {
  return api.map(r => ({
    code: r.code,
    nameEn: r.nameEn,
    nameAr: r.nameAr,
    debit: minor(r.debitTotal, 'debitTotal', r.code),
    credit: minor(r.creditTotal, 'creditTotal', r.code),
    balance: minor(r.balance, 'balance', r.code),
  }));
}

/** Column totals in integer minor units (never floats), so debit === credit is an exact comparison. */
export function sumTrialBalance(rows: TrialBalanceRow[]): { debit: number; credit: number } {
  return rows.reduce((acc, r) => ({ debit: acc.debit + r.debit, credit: acc.credit + r.credit }), {
    debit: 0,
    credit: 0,
  });
}
