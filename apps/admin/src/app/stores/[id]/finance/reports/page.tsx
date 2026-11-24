'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { toCsv } from '@/lib/csv';
import { useT } from '@/i18n/useT';
import { DataTable } from '@/components/mobile/DataTable';
import { apiGet, apiFetch } from '@/lib/api';
import { minorToMajor, formatPrice } from '@/lib/format';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { useCurrentStore } from '@/hooks/useCurrentStore';
import { resolveStoreTimeZone, zonedIsoDay, zonedMonthStartDay } from '@ebda/shared';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
// ─── Types ────────────────────────────────────────────────────────────────────

import {
  toTrialBalanceRows,
  sumTrialBalance,
  type ApiTrialBalanceRow,
  type TrialBalanceRow,
} from './trial-balance';

type TabKey = 'trialBalance' | 'pnl' | 'balanceSheet' | 'taxReport';

interface PnlSection {
  accounts: { code: string; nameEn: string; balance: number }[];
  total: number;
}

interface PnlData {
  revenue: PnlSection;
  expenses: PnlSection;
  netIncome: number;
}

interface BalanceSheetSection {
  accounts: {
    code: string;
    nameEn: string;
    balance: number;
    /** The computed retained + current earnings row — not a COA account. */
    kind?: 'current_earnings';
  }[];
  total: number;
}

interface BalanceSheetData {
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
}

interface TaxReportRow {
  /** `sale` = the order's sale entry; `reversal` = a refund/return entry for it (#1253). */
  kind: 'sale' | 'reversal';
  date: string;
  orderNumber: string;
  customerName: string | null;
  subtotal: number;
  taxRate: string;
  taxCollected: number;
  /** Order total on the sale row only; null on a reversal row. */
  total: number | null;
}

interface TaxRateSummary {
  taxRate: string;
  transactionCount: number;
  totalSubtotal: number;
  totalTaxCollected: number;
}

interface TaxReportData {
  from: string;
  to: string;
  rows: TaxReportRow[];
  summary: {
    transactionCount: number;
    orderCount: number;
    totalTaxableSales: number;
    totalTaxCollected: number;
    totalInputTax?: number;
    netTaxPayable?: number;
    byRate: TaxRateSummary[];
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const major = minorToMajor;

// Default pickers name the STORE's today / month start — the days the API
// resolves `YYYY-MM-DD` in (Ruling FRT-1). `toISOString()` gave the UTC day,
// so before 03:00 Egypt time "today" was still yesterday.
function todayIso(timeZone: string): string {
  return zonedIsoDay(new Date(), timeZone);
}

function firstOfMonth(timeZone: string): string {
  return zonedMonthStartDay(new Date(), timeZone);
}

function downloadCsv(filename: string, rows: string[][]): void {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function downloadXlsx(endpoint: string, filename: string): Promise<void> {
  const response = await apiFetch(endpoint);
  if (!response.ok) return;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Sub-views ───────────────────────────────────────────────────────────────

function TrialBalanceTab({ storeId, timeZone }: { storeId: string; timeZone: string }) {
  const t = useT('finance.reports');
  const tb = useT('finance.reports.trialBalance');
  const tc = useT('common');
  const [asOf, setAsOf] = useState(() => todayIso(timeZone));
  const [rows, setRows] = useState<TrialBalanceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);

  // Latest-request-wins: a slower response for the PREVIOUS dates must not
  // land after the current one and repaint the old period under the new dates.
  const beginRequest = useLatestRequest();
  const fetch = useCallback(() => {
    const isLatest = beginRequest();
    setLoading(true);
    setError(null);
    apiGet<ApiTrialBalanceRow[]>(
      `/api/v1/stores/${storeId}/finance/reports/trial-balance?asOf=${asOf}`
    )
      .then(({ data, error: apiError }) => {
        if (!isLatest()) return;
        if (apiError) {
          // Never leave the previous period's figures on screen under an error.
          setRows(null);
          setError(apiError.message);
        } else setRows(toTrialBalanceRows(data ?? []));
      })
      .catch(() => {
        if (!isLatest()) return;
        setRows(null);
        setError(t('loadTrialFailed'));
      })
      .finally(() => {
        if (isLatest()) setLoading(false);
      });
  }, [storeId, asOf, beginRequest]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const totals = sumTrialBalance(rows ?? []);
  const balanced = rows && rows.length > 0 && totals.debit === totals.credit;

  function exportCsv() {
    if (!rows) return;
    const header = [
      tb('accountCode'),
      tb('accountName'),
      'Account (AR)',
      tb('debit'),
      tb('credit'),
      tb('balance'),
    ];
    const dataRows = rows.map(r => [
      r.code,
      r.nameEn,
      r.nameAr ?? '',
      major(r.debit),
      major(r.credit),
      major(r.balance),
    ]);
    downloadCsv(`trial-balance-as-of-${asOf}.csv`, [
      [`Filters: As of = ${asOf}`],
      header,
      ...dataRows,
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('asOf')}</span>
          <input
            type="date"
            value={asOf}
            onChange={e => setAsOf(e.target.value)}
            className={`${FIELD_CLASSES} block`}
          />
        </label>
        <div className="flex gap-2 ms-auto">
          <Button
            type="button"
            onClick={exportCsv}
            disabled={loading || !rows || rows.length === 0}
            variant="outline"
          >
            {t('exportCsv')}
          </Button>
          <Button
            type="button"
            disabled={loading || !rows || rows.length === 0 || exportingXlsx}
            onClick={async () => {
              setExportingXlsx(true);
              try {
                await downloadXlsx(
                  `/api/v1/stores/${storeId}/finance/reports/trial-balance.xlsx?asOf=${asOf}`,
                  `trial-balance-as-of-${asOf}.xlsx`
                );
              } finally {
                setExportingXlsx(false);
              }
            }}
            variant="outline"
          >
            {exportingXlsx ? t('exporting') : t('exportXlsx')}
          </Button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">{tc('loading')}</p>}
      {error && <p className="text-sm text-destructive-ink">{error}</p>}

      {rows && !loading && (
        <div className="space-y-3">
          <DataTable<(typeof rows)[number]>
            ariaLabel={tb('accountName')}
            columns={[
              {
                header: tb('accountCode'),
                cell: r => (
                  <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
                ),
              },
              {
                header: tb('accountName'),
                primaryOnMobile: true,
                cell: r => (
                  <span>
                    {r.nameEn}
                    {r.nameAr && (
                      <span className="text-muted-foreground ms-2 text-xs" dir="rtl">
                        — {r.nameAr}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                header: `${tb('debit')} ${tc('egpParen')}`,
                alignEnd: true,
                cell: r => <span className="font-mono">{major(r.debit)}</span>,
              },
              {
                header: `${tb('credit')} ${tc('egpParen')}`,
                alignEnd: true,
                cell: r => <span className="font-mono">{major(r.credit)}</span>,
              },
              {
                header: `${tb('balance')} ${tc('egpParen')}`,
                alignEnd: true,
                cell: r => <span className="font-mono">{major(r.balance)}</span>,
              },
            ]}
            rows={rows}
            rowKey={r => r.code}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm font-semibold">
            <span>{tb('totals')}</span>
            <span className="font-mono">
              {major(totals.debit)} / {major(totals.credit)}
            </span>
            {balanced && <span className="text-xs text-success-ink">{tb('balanced')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function PnlTab({ storeId, timeZone }: { storeId: string; timeZone: string }) {
  const t = useT('finance.reports');
  const tp = useT('finance.reports.pnl');
  const tc = useT('common');
  const [from, setFrom] = useState(() => firstOfMonth(timeZone));
  const [to, setTo] = useState(() => todayIso(timeZone));
  const [data, setData] = useState<PnlData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);

  // Latest-request-wins: a slower response for the PREVIOUS dates must not
  // land after the current one and repaint the old period under the new dates.
  const beginRequest = useLatestRequest();
  const fetch = useCallback(() => {
    const isLatest = beginRequest();
    setLoading(true);
    setError(null);
    apiGet<PnlData>(`/api/v1/stores/${storeId}/finance/reports/pnl?from=${from}&to=${to}`)
      .then(({ data: d, error: apiError }) => {
        if (!isLatest()) return;
        if (apiError) {
          // Never leave the previous period's figures on screen under an error.
          setData(null);
          setError(apiError.message);
        } else setData(d ?? null);
      })
      .catch(() => {
        if (!isLatest()) return;
        setData(null);
        setError(t('loadPnlFailed'));
      })
      .finally(() => {
        if (isLatest()) setLoading(false);
      });
  }, [storeId, from, to, beginRequest]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  function exportCsv() {
    if (!data) return;
    const rows: string[][] = [];
    rows.push([tp('revenue'), '', '']);
    data.revenue.accounts.forEach(a => rows.push([a.code, a.nameEn, major(a.balance)]));
    rows.push([tp('totalRevenue'), '', major(data.revenue.total)]);
    rows.push([]);
    rows.push([tp('expenses'), '', '']);
    data.expenses.accounts.forEach(a => rows.push([a.code, a.nameEn, major(a.balance)]));
    rows.push([tp('totalExpenses'), '', major(data.expenses.total)]);
    rows.push([]);
    rows.push([tp('netIncome'), '', major(data.netIncome)]);
    downloadCsv(`pnl-${from}_to_${to}.csv`, [[`Filters: Date range = ${from} to ${to}`], ...rows]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('from')}</span>
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            className={`${FIELD_CLASSES} block`}
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('to')}</span>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            className={`${FIELD_CLASSES} block`}
          />
        </label>
        <div className="flex gap-2 ms-auto">
          <Button type="button" onClick={exportCsv} disabled={loading || !data} variant="outline">
            {t('exportCsv')}
          </Button>
          <Button
            type="button"
            disabled={loading || !data || exportingXlsx}
            onClick={async () => {
              setExportingXlsx(true);
              try {
                await downloadXlsx(
                  `/api/v1/stores/${storeId}/finance/reports/pnl.xlsx?from=${from}&to=${to}`,
                  `pnl-${from}_to_${to}.xlsx`
                );
              } finally {
                setExportingXlsx(false);
              }
            }}
            variant="outline"
          >
            {exportingXlsx ? t('exporting') : t('exportXlsx')}
          </Button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">{tc('loading')}</p>}
      {error && <p className="text-sm text-destructive-ink">{error}</p>}

      {data && !loading && (
        <div className="space-y-6 max-w-2xl">
          {/* Revenue */}
          <section>
            <h3 className="text-sm font-semibold mb-2">{tp('revenue')}</h3>
            <div className="rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.revenue.accounts.map((a, i) => (
                    <tr key={i} className="border-b border-border/40 last:border-0">
                      <td className="px-3 py-2 font-mono text-sm text-muted-foreground w-16">
                        {a.code}
                      </td>
                      <td className="px-3 py-2">{a.nameEn}</td>
                      <td className="px-3 py-2 text-end font-mono">{formatPrice(a.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-muted/20 border-t border-border">
                  <tr>
                    <td className="px-3 py-2 font-semibold" colSpan={2}>
                      {tp('totalRevenue')}
                    </td>
                    <td className="px-3 py-2 text-end font-mono font-semibold text-success-ink">
                      {formatPrice(data.revenue.total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* Expenses */}
          <section>
            <h3 className="text-sm font-semibold mb-2">{tp('expenses')}</h3>
            <div className="rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.expenses.accounts.map((a, i) => (
                    <tr key={i} className="border-b border-border/40 last:border-0">
                      <td className="px-3 py-2 font-mono text-sm text-muted-foreground w-16">
                        {a.code}
                      </td>
                      <td className="px-3 py-2">{a.nameEn}</td>
                      <td className="px-3 py-2 text-end font-mono">{formatPrice(a.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-muted/20 border-t border-border">
                  <tr>
                    <td className="px-3 py-2 font-semibold" colSpan={2}>
                      {tp('totalExpenses')}
                    </td>
                    <td className="px-3 py-2 text-end font-mono font-semibold text-destructive-ink">
                      {formatPrice(data.expenses.total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* Net Income */}
          <div className="rounded-md border border-border p-4 flex justify-between items-center">
            <span className="font-semibold">{tp('netIncome')}</span>
            <span
              className={`text-xl font-semibold font-mono ${
                data.netIncome >= 0 ? 'text-success-ink' : 'text-destructive-ink'
              }`}
            >
              {data.netIncome < 0 ? '−' : ''}
              {formatPrice(Math.abs(data.netIncome))}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function BalanceSheetTab({ storeId, timeZone }: { storeId: string; timeZone: string }) {
  const t = useT('finance.reports');
  const tbs = useT('finance.reports.balanceSheet');
  const tc = useT('common');
  const [asOf, setAsOf] = useState(() => todayIso(timeZone));
  const [data, setData] = useState<BalanceSheetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);

  // Latest-request-wins: a slower response for the PREVIOUS dates must not
  // land after the current one and repaint the old period under the new dates.
  const beginRequest = useLatestRequest();
  const fetch = useCallback(() => {
    const isLatest = beginRequest();
    setLoading(true);
    setError(null);
    apiGet<BalanceSheetData>(`/api/v1/stores/${storeId}/finance/reports/balance-sheet?asOf=${asOf}`)
      .then(({ data: d, error: apiError }) => {
        if (!isLatest()) return;
        if (apiError) {
          // Never leave the previous period's figures on screen under an error.
          setData(null);
          setError(apiError.message);
        } else setData(d ?? null);
      })
      .catch(() => {
        if (!isLatest()) return;
        setData(null);
        setError(t('loadBalanceFailed'));
      })
      .finally(() => {
        if (isLatest()) setLoading(false);
      });
  }, [storeId, asOf, beginRequest]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const balanced =
    data && Math.abs(data.assets.total - (data.liabilities.total + data.equity.total)) < 1;

  function exportCsv() {
    if (!data) return;
    const rows: string[][] = [];
    rows.push([tbs('assets'), '', '']);
    data.assets.accounts.forEach(a => rows.push([a.code, a.nameEn, major(a.balance)]));
    rows.push([tbs('totalAssets'), '', major(data.assets.total)]);
    rows.push([]);
    rows.push([tbs('liabilities'), '', '']);
    data.liabilities.accounts.forEach(a => rows.push([a.code, a.nameEn, major(a.balance)]));
    rows.push([tbs('totalLiabilities'), '', major(data.liabilities.total)]);
    rows.push([]);
    rows.push([tbs('equity'), '', '']);
    data.equity.accounts.forEach(a => rows.push([a.code, accountLabel(a), major(a.balance)]));
    rows.push([tbs('totalEquity'), '', major(data.equity.total)]);
    downloadCsv(`balance-sheet-as-of-${asOf}.csv`, [[`Filters: As of = ${asOf}`], ...rows]);
  }

  // The earnings row is computed (the ledger has no closing entries), so it
  // is labelled from i18n rather than from a COA account name.
  function accountLabel(a: BalanceSheetSection['accounts'][number]): string {
    return a.kind === 'current_earnings' ? tbs('currentEarnings') : a.nameEn;
  }

  const difference = data ? data.assets.total - (data.liabilities.total + data.equity.total) : 0;

  function renderSection(label: string, section: BalanceSheetSection, totalLabel: string) {
    return (
      <section>
        <h3 className="text-sm font-semibold mb-2">{label}</h3>
        <div className="rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {section.accounts.map((a, i) => (
                <tr key={i} className="border-b border-border/40 last:border-0">
                  <td className="px-3 py-2 font-mono text-sm text-muted-foreground w-16">
                    {a.code}
                  </td>
                  <td className="px-3 py-2">
                    {accountLabel(a)}
                    {a.kind === 'current_earnings' && (
                      <span className="block text-xs text-muted-foreground">
                        {tbs('currentEarningsHint')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-end font-mono">{formatPrice(a.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-muted/20 border-t border-border">
              <tr>
                <td className="px-3 py-2 font-semibold" colSpan={2}>
                  {totalLabel}
                </td>
                <td className="px-3 py-2 text-end font-mono font-semibold">
                  {formatPrice(section.total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('asOf')}</span>
          <input
            type="date"
            value={asOf}
            onChange={e => setAsOf(e.target.value)}
            className={`${FIELD_CLASSES} block`}
          />
        </label>
        <div className="flex gap-2 ms-auto">
          <Button type="button" onClick={exportCsv} disabled={loading || !data} variant="outline">
            {t('exportCsv')}
          </Button>
          <Button
            type="button"
            disabled={loading || !data || exportingXlsx}
            onClick={async () => {
              setExportingXlsx(true);
              try {
                await downloadXlsx(
                  `/api/v1/stores/${storeId}/finance/reports/balance-sheet.xlsx?asOf=${asOf}`,
                  `balance-sheet-as-of-${asOf}.xlsx`
                );
              } finally {
                setExportingXlsx(false);
              }
            }}
            variant="outline"
          >
            {exportingXlsx ? t('exporting') : t('exportXlsx')}
          </Button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">{tc('loading')}</p>}
      {error && <p className="text-sm text-destructive-ink">{error}</p>}

      {data && !loading && (
        <div className="space-y-6 max-w-2xl">
          {renderSection(tbs('assets'), data.assets, tbs('totalAssets'))}
          {renderSection(tbs('liabilities'), data.liabilities, tbs('totalLiabilities'))}
          {renderSection(tbs('equity'), data.equity, tbs('totalEquity'))}
          {balanced ? (
            <p className="text-sm text-success-ink">{tbs('balanced')}</p>
          ) : (
            <p className="text-sm text-destructive-ink">
              {tbs('unbalanced', { amount: major(Math.abs(difference)) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TaxReportTab({ storeId, timeZone }: { storeId: string; timeZone: string }) {
  const t = useT('finance.reports');
  const tt = useT('finance.reports.taxReport');
  const tc = useT('common');
  const [from, setFrom] = useState(() => firstOfMonth(timeZone));
  const [to, setTo] = useState(() => todayIso(timeZone));
  const [data, setData] = useState<TaxReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);

  // Latest-request-wins: a slower response for the PREVIOUS dates must not
  // land after the current one and repaint the old period under the new dates.
  const beginRequest = useLatestRequest();
  const fetchReport = useCallback(() => {
    const isLatest = beginRequest();
    setLoading(true);
    setError(null);
    apiGet<TaxReportData>(
      `/api/v1/stores/${storeId}/finance/reports/tax-report?from=${from}&to=${to}`
    )
      .then(({ data: d, error: apiError }) => {
        if (!isLatest()) return;
        if (apiError) {
          // Never leave the previous period's figures on screen under an error.
          setData(null);
          setError(apiError.message);
        } else setData(d ?? null);
      })
      .catch(() => {
        if (!isLatest()) return;
        setData(null);
        setError(t('loadTaxFailed'));
      })
      .finally(() => {
        if (isLatest()) setLoading(false);
      });
  }, [storeId, from, to, beginRequest]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  function exportCsv() {
    if (!data) return;
    const header = [
      tt('type'),
      tt('date'),
      tt('orderNumber'),
      tt('customer'),
      tt('taxableBase'),
      tt('taxRate'),
      tt('taxCollected'),
      tt('orderTotal'),
    ];
    const rows = data.rows.map(r => [
      r.kind === 'sale' ? tt('kindSale') : tt('kindReversal'),
      r.date,
      r.orderNumber,
      r.customerName ?? '',
      major(r.subtotal),
      `${r.taxRate}%`,
      major(r.taxCollected),
      r.total === null ? '' : major(r.total),
    ]);
    downloadCsv(`tax-report-${from}_to_${to}.csv`, [
      [`Filters: Date range = ${from} to ${to}`],
      header,
      ...rows,
    ]);
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('from')}</span>
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            className={`${FIELD_CLASSES} block`}
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('to')}</span>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            className={`${FIELD_CLASSES} block`}
          />
        </label>
        <div className="flex gap-2 ms-auto">
          <Button
            type="button"
            onClick={exportCsv}
            disabled={loading || !data || data.rows.length === 0}
            variant="outline"
          >
            {t('exportCsv')}
          </Button>
          <Button
            type="button"
            disabled={loading || !data || data.rows.length === 0 || exportingXlsx}
            onClick={async () => {
              setExportingXlsx(true);
              try {
                await downloadXlsx(
                  `/api/v1/stores/${storeId}/finance/reports/tax-report.xlsx?from=${from}&to=${to}`,
                  `tax-report-${from}_to_${to}.xlsx`
                );
              } finally {
                setExportingXlsx(false);
              }
            }}
            variant="outline"
          >
            {exportingXlsx ? t('exporting') : t('exportXlsx')}
          </Button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">{tc('loading')}</p>}
      {error && <p className="text-sm text-destructive-ink">{error}</p>}

      {data && !loading && (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-md border border-border p-4">
              <p className="text-xs text-muted-foreground mb-1">{tt('orderCount')}</p>
              <p className="text-2xl font-semibold font-mono">{data.summary.orderCount}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {tt('entryCount', { count: data.summary.transactionCount })}
              </p>
            </div>
            <div className="rounded-md border border-border p-4">
              <p className="text-xs text-muted-foreground mb-1">{tt('totalTaxableSales')}</p>
              <p className="text-2xl font-semibold font-mono">
                {formatPrice(data.summary.totalTaxableSales)}
              </p>
            </div>
            <div className="rounded-md border border-border p-4 bg-warning/10 border-warning/30">
              <p className="text-xs text-muted-foreground mb-1">{tt('totalTaxCollected')}</p>
              <p className="text-2xl font-semibold font-mono text-warning-ink">
                {formatPrice(data.summary.totalTaxCollected)}
              </p>
            </div>
          </div>

          {/* Input VAT and the net the return owes (ACCT-AUDIT-10) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-lg border border-border p-4">
              <p className="text-sm text-muted-foreground mb-1">{tt('totalInputTax')}</p>
              <p className="text-2xl font-semibold font-mono">
                {formatPrice(data.summary.totalInputTax ?? 0)}
              </p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-sm text-muted-foreground mb-1">{tt('netTaxPayable')}</p>
              <p className="text-2xl font-semibold font-mono">
                {formatPrice(data.summary.netTaxPayable ?? data.summary.totalTaxCollected)}
              </p>
              <p className="text-sm text-muted-foreground mt-1">{tt('netTaxPayableHint')}</p>
            </div>
          </div>

          {/* By-rate breakdown */}
          {data.summary.byRate.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2">{tt('byRateBreakdown')}</h3>
              <div className="rounded-md border border-border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                        {tt('taxRate')}
                      </th>
                      <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                        {tt('entries')}
                      </th>
                      <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                        {tt('taxableBase')} {tc('egpParen')}
                      </th>
                      <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                        {tt('taxCollected')} {tc('egpParen')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.summary.byRate.map((r, i) => (
                      <tr key={i} className="border-t border-border/40">
                        <td className="px-3 py-2 font-mono">{r.taxRate}%</td>
                        <td className="px-3 py-2 text-end font-mono">{r.transactionCount}</td>
                        <td className="px-3 py-2 text-end font-mono">{major(r.totalSubtotal)}</td>
                        <td className="px-3 py-2 text-end font-mono font-semibold text-warning-ink">
                          {major(r.totalTaxCollected)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Transaction table */}
          <section>
            <h3 className="text-sm font-semibold mb-2">{tt('transactions')}</h3>
            {data.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                {tt('noTransactions')}
              </p>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="text-start px-3 py-2 font-medium text-muted-foreground w-24">
                          {tt('type')}
                        </th>
                        <th className="text-start px-3 py-2 font-medium text-muted-foreground w-28">
                          {tt('date')}
                        </th>
                        <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                          {tt('orderNumber')}
                        </th>
                        <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                          {tt('customer')}
                        </th>
                        <th className="text-end px-3 py-2 font-medium text-muted-foreground w-28">
                          {tt('taxableBase')} {tc('egpParen')}
                        </th>
                        <th className="text-end px-3 py-2 font-medium text-muted-foreground w-20">
                          {tt('taxRate')}
                        </th>
                        <th className="text-end px-3 py-2 font-medium text-muted-foreground w-28">
                          {tt('taxCollected')} {tc('egpParen')}
                        </th>
                        <th className="text-end px-3 py-2 font-medium text-muted-foreground w-28">
                          {tt('orderTotal')} {tc('egpParen')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row, i) => (
                        <tr
                          key={i}
                          className={`border-t border-border/40${
                            row.kind === 'sale' ? '' : ' text-muted-foreground bg-muted/10'
                          }`}
                        >
                          <td className="px-3 py-2 text-sm">
                            {row.kind === 'sale' ? tt('kindSale') : tt('kindReversal')}
                          </td>
                          <td className="px-3 py-2 font-mono text-sm">{row.date}</td>
                          <td className="px-3 py-2 font-mono text-sm">{row.orderNumber}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {row.customerName ?? <span className="italic">{tt('guest')}</span>}
                          </td>
                          <td className="px-3 py-2 text-end font-mono">{major(row.subtotal)}</td>
                          <td className="px-3 py-2 text-end font-mono">{row.taxRate}%</td>
                          <td className="px-3 py-2 text-end font-mono font-semibold text-warning-ink">
                            {major(row.taxCollected)}
                          </td>
                          <td className="px-3 py-2 text-end font-mono">
                            {row.total === null ? '—' : major(row.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-muted/20 border-t border-border">
                      <tr>
                        <td className="px-3 py-2 font-semibold" colSpan={4}>
                          {tt('totals')}
                        </td>
                        <td className="px-3 py-2 text-end font-mono font-semibold">
                          {major(data.summary.totalTaxableSales)}
                        </td>
                        <td />
                        <td className="px-3 py-2 text-end font-mono font-semibold text-warning-ink">
                          {major(data.summary.totalTaxCollected)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function FinanceReportsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('finance.reports');
  // Report days are the store's calendar days; wait for its zone so the
  // default pickers do not start on the wrong day and then jump.
  const { store, isLoading: storeLoading } = useCurrentStore(storeId);
  const timeZone = resolveStoreTimeZone(store?.timezone);

  const [tab, setTab] = useState<TabKey>('trialBalance');

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'trialBalance', label: t('tabs.trialBalance') },
    { key: 'pnl', label: t('tabs.pnl') },
    { key: 'balanceSheet', label: t('tabs.balanceSheet') },
    { key: 'taxReport', label: t('tabs.taxReport') },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl space-y-6">
        {/* Tabs */}
        <div className="flex border-b border-border">
          {tabs.map(({ key, label }) => (
            <Button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              variant={tab === key ? 'soft' : 'ghost'}
            >
              {label}
            </Button>
          ))}
        </div>

        {/* Tab content */}
        {storeId && !storeLoading && (
          <>
            <p className="text-xs text-muted-foreground">{t('timeZoneNote', { timeZone })}</p>
            {tab === 'trialBalance' && <TrialBalanceTab storeId={storeId} timeZone={timeZone} />}
            {tab === 'pnl' && <PnlTab storeId={storeId} timeZone={timeZone} />}
            {tab === 'balanceSheet' && <BalanceSheetTab storeId={storeId} timeZone={timeZone} />}
            {tab === 'taxReport' && <TaxReportTab storeId={storeId} timeZone={timeZone} />}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
