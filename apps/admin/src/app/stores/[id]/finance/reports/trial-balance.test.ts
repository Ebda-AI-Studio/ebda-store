import { describe, it, expect } from 'vitest';
import { toTrialBalanceRows, sumTrialBalance } from './trial-balance';
import { minorToMajor } from '@/lib/format';

// Shape the API really returns (reports.service.ts TrialBalanceRow): a COD sale 4850 then a 1000 refund + its reversal mirror.
const api = [
  {
    code: '1000',
    nameEn: 'Cash',
    nameAr: 'نقدية',
    debitTotal: 485000,
    creditTotal: 100000,
    balance: 385000,
  },
  {
    code: '4000',
    nameEn: 'Sales',
    nameAr: null,
    debitTotal: 100000,
    creditTotal: 485000,
    balance: -385000,
  },
];

describe('trial balance mapping (STORE-QA-65)', () => {
  it('maps debitTotal/creditTotal to finite debit/credit (was NaN.NaN)', () => {
    const rows = toTrialBalanceRows(api);
    expect(minorToMajor(rows[0].debit)).toBe('4850.00');
    expect(minorToMajor(rows[0].credit)).toBe('1000.00');
    for (const r of rows)
      for (const v of [r.debit, r.credit, r.balance]) expect(minorToMajor(v)).not.toContain('NaN');
  });
  it('sums in integer minor units and balances exactly incl. the refund reversal', () => {
    const t = sumTrialBalance(toTrialBalanceRows(api));
    expect(t.debit).toBe(585000);
    expect(t.credit).toBe(585000);
  });
  it('fails loudly on a malformed row instead of printing NaN', () => {
    expect(() => toTrialBalanceRows([{ ...api[0], debitTotal: undefined as never }])).toThrow(
      /debitTotal/
    );
  });
});
