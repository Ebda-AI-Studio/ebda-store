'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { toCsv } from '@/lib/csv';
import { useT } from '@/i18n/useT';
import { apiGet, apiFetch } from '@/lib/api';
import { filsToKwd } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

type TabKey = 'trialBalance' | 'pnl' | 'balanceSheet' | 'taxReport';

interface TrialBalanceRow {
  code: string;
  nameEn: string;
  nameAr: string | null;
  debit: number;
  credit: number;
  balance: number;
}

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
  accounts: { code: string; nameEn: string; balance: number }[];
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
    totalTaxableSales: number;
    totalTaxCollected: number;
    byRate: TaxRateSummary[];
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const kwd = filsToKwd;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth(): string {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
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

function TrialBalanceTab({ storeId }: { storeId: string }) {
  const t = useT('finance.reports');
  const tb = useT('finance.reports.trialBalance');
  const [asOf, setAsOf] = useState(todayIso());
  const [rows, setRows] = useState<TrialBalanceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);

  const fetch = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet<TrialBalanceRow[]>(
      `/api/v1/stores/${storeId}/finance/reports/trial-balance?asOf=${asOf}`
    )
      .then(({ data, error: apiError }) => {
        if (apiError) setError(apiError.message);
        else setRows(data ?? []);
      })
      .catch(() => setError('Failed to load trial balance'))
      .finally(() => setLoading(false));
  }, [storeId, asOf]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const totals = (rows ?? []).reduce(
    (acc, r) => ({ debit: acc.debit + r.debit, credit: acc.credit + r.credit }),
    { debit: 0, credit: 0 }
  );
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
      kwd(r.debit),
      kwd(r.credit),
      kwd(r.balance),
    ]);
    downloadCsv(`trial-balance-${asOf}.csv`, [header, ...dataRows]);
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
            className="block border border-border rounded px-3 py-2 text-base sm:text-sm"
          />
        </label>
        <div className="flex gap-2 ms-auto">
          <button
            type="button"
            onClick={exportCsv}
            disabled={!rows || rows.length === 0}
            className="px-3 py-2 border border-border rounded text-sm disabled:opacity-40"
          >
            {t('exportCsv')}
          </button>
          <button
            type="button"
            disabled={!rows || rows.length === 0 || exportingXlsx}
            onClick={async () => {
              setExportingXlsx(true);
              try {
                await downloadXlsx(
                  `/api/v1/stores/${storeId}/finance/reports/trial-balance.xlsx?asOf=${asOf}`,
                  `trial-balance-${asOf}.xlsx`
                );
              } finally {
                setExportingXlsx(false);
              }
            }}
            className="px-3 py-2 border border-border rounded text-sm disabled:opacity-40"
          >
            {exportingXlsx ? t('exporting') : t('exportXlsx')}
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {rows && !loading && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-start px-3 py-2 w-20 font-medium text-muted-foreground">
                    {tb('accountCode')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                    {tb('accountName')}
                  </th>
                  <th className="text-end px-3 py-2 w-28 font-medium text-muted-foreground">
                    {tb('debit')} (KWD)
                  </th>
                  <th className="text-end px-3 py-2 w-28 font-medium text-muted-foreground">
                    {tb('credit')} (KWD)
                  </th>
                  <th className="text-end px-3 py-2 w-28 font-medium text-muted-foreground">
                    {tb('balance')} (KWD)
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-border/40">
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.code}</td>
                    <td className="px-3 py-2">
                      {r.nameEn}
                      {r.nameAr && (
                        <span className="text-muted-foreground ms-2 text-xs" dir="rtl">
                          — {r.nameAr}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-end font-mono">{kwd(r.debit)}</td>
                    <td className="px-3 py-2 text-end font-mono">{kwd(r.credit)}</td>
                    <td className="px-3 py-2 text-end font-mono">{kwd(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/20 border-t border-border">
                <tr>
                  <td className="px-3 py-2 font-semibold" colSpan={2}>
                    {tb('totals')}
                  </td>
                  <td className="px-3 py-2 text-end font-mono font-semibold">
                    {kwd(totals.debit)}
                  </td>
                  <td className="px-3 py-2 text-end font-mono font-semibold">
                    {kwd(totals.credit)}
                  </td>
                  <td className="px-3 py-2 text-end text-xs">
                    {balanced && <span className="text-green-700">{tb('balanced')}</span>}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function PnlTab({ storeId }: { storeId: string }) {
  const t = useT('finance.reports');
  const tp = useT('finance.reports.pnl');
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayIso());
  const [data, setData] = useState<PnlData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);

  const fetch = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet<PnlData>(`/api/v1/stores/${storeId}/finance/reports/pnl?from=${from}&to=${to}`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) setError(apiError.message);
        else setData(d ?? null);
      })
      .catch(() => setError('Failed to load P&L'))
      .finally(() => setLoading(false));
  }, [storeId, from, to]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  function exportCsv() {
    if (!data) return;
    const rows: string[][] = [];
    rows.push([tp('revenue'), '', '']);
    data.revenue.accounts.forEach(a => rows.push([a.code, a.nameEn, kwd(a.balance)]));
    rows.push([tp('totalRevenue'), '', kwd(data.revenue.total)]);
    rows.push([]);
    rows.push([tp('expenses'), '', '']);
    data.expenses.accounts.forEach(a => rows.push([a.code, a.nameEn, kwd(a.balance)]));
    rows.push([tp('totalExpenses'), '', kwd(data.expenses.total)]);
    rows.push([]);
    rows.push([tp('netIncome'), '', kwd(data.netIncome)]);
    downloadCsv(`pnl-${from}-to-${to}.csv`, rows);
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
            className="block border border-border rounded px-3 py-2 text-base sm:text-sm"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('to')}</span>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            className="block border border-border rounded px-3 py-2 text-base sm:text-sm"
          />
        </label>
        <div className="flex gap-2 ms-auto">
          <button
            type="button"
            onClick={exportCsv}
            disabled={!data}
            className="px-3 py-2 border border-border rounded text-sm disabled:opacity-40"
          >
            {t('exportCsv')}
          </button>
          <button
            type="button"
            disabled={!data || exportingXlsx}
            onClick={async () => {
              setExportingXlsx(true);
              try {
                await downloadXlsx(
                  `/api/v1/stores/${storeId}/finance/reports/pnl.xlsx?from=${from}&to=${to}`,
                  `pnl-${from}-to-${to}.xlsx`
                );
              } finally {
                setExportingXlsx(false);
              }
            }}
            className="px-3 py-2 border border-border rounded text-sm disabled:opacity-40"
          >
            {exportingXlsx ? t('exporting') : t('exportXlsx')}
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {data && !loading && (
        <div className="space-y-6 max-w-2xl">
          {/* Revenue */}
          <section>
            <h3 className="text-sm font-semibold mb-2">{tp('revenue')}</h3>
            <div className="rounded-xl border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.revenue.accounts.map((a, i) => (
                    <tr key={i} className="border-b border-border/40 last:border-0">
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground w-16">
                        {a.code}
                      </td>
                      <td className="px-3 py-2">{a.nameEn}</td>
                      <td className="px-3 py-2 text-end font-mono">{kwd(a.balance)} KWD</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-muted/20 border-t border-border">
                  <tr>
                    <td className="px-3 py-2 font-semibold" colSpan={2}>
                      {tp('totalRevenue')}
                    </td>
                    <td className="px-3 py-2 text-end font-mono font-semibold text-green-700">
                      {kwd(data.revenue.total)} KWD
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* Expenses */}
          <section>
            <h3 className="text-sm font-semibold mb-2">{tp('expenses')}</h3>
            <div className="rounded-xl border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.expenses.accounts.map((a, i) => (
                    <tr key={i} className="border-b border-border/40 last:border-0">
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground w-16">
                        {a.code}
                      </td>
                      <td className="px-3 py-2">{a.nameEn}</td>
                      <td className="px-3 py-2 text-end font-mono">{kwd(a.balance)} KWD</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-muted/20 border-t border-border">
                  <tr>
                    <td className="px-3 py-2 font-semibold" colSpan={2}>
                      {tp('totalExpenses')}
                    </td>
                    <td className="px-3 py-2 text-end font-mono font-semibold text-red-600">
                      {kwd(data.expenses.total)} KWD
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* Net Income */}
          <div className="rounded-xl border border-border p-4 flex justify-between items-center">
            <span className="font-semibold">{tp('netIncome')}</span>
            <span
              className={`text-xl font-semibold font-mono ${
                data.netIncome >= 0 ? 'text-green-700' : 'text-red-600'
              }`}
            >
              {data.netIncome < 0 ? '−' : ''}
              {kwd(Math.abs(data.netIncome))} KWD
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function BalanceSheetTab({ storeId }: { storeId: string }) {
  const t = useT('finance.reports');
  const tbs = useT('finance.reports.balanceSheet');
  const [asOf, setAsOf] = useState(todayIso());
  const [data, setData] = useState<BalanceSheetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);

  const fetch = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet<BalanceSheetData>(`/api/v1/stores/${storeId}/finance/reports/balance-sheet?asOf=${asOf}`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) setError(apiError.message);
        else setData(d ?? null);
      })
      .catch(() => setError('Failed to load balance sheet'))
      .finally(() => setLoading(false));
  }, [storeId, asOf]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const balanced =
    data && Math.abs(data.assets.total - (data.liabilities.total + data.equity.total)) < 1;

  function exportCsv() {
    if (!data) return;
    const rows: string[][] = [];
    rows.push([tbs('assets'), '', '']);
    data.assets.accounts.forEach(a => rows.push([a.code, a.nameEn, kwd(a.balance)]));
    rows.push([tbs('totalAssets'), '', kwd(data.assets.total)]);
    rows.push([]);
    rows.push([tbs('liabilities'), '', '']);
    data.liabilities.accounts.forEach(a => rows.push([a.code, a.nameEn, kwd(a.balance)]));
    rows.push([tbs('totalLiabilities'), '', kwd(data.liabilities.total)]);
    rows.push([]);
    rows.push([tbs('equity'), '', '']);
    data.equity.accounts.forEach(a => rows.push([a.code, a.nameEn, kwd(a.balance)]));
    rows.push([tbs('totalEquity'), '', kwd(data.equity.total)]);
    downloadCsv(`balance-sheet-${asOf}.csv`, rows);
  }

  function renderSection(label: string, section: BalanceSheetSection, totalLabel: string) {
    return (
      <section>
        <h3 className="text-sm font-semibold mb-2">{label}</h3>
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {section.accounts.map((a, i) => (
                <tr key={i} className="border-b border-border/40 last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground w-16">
                    {a.code}
                  </td>
                  <td className="px-3 py-2">{a.nameEn}</td>
                  <td className="px-3 py-2 text-end font-mono">{kwd(a.balance)} KWD</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-muted/20 border-t border-border">
              <tr>
                <td className="px-3 py-2 font-semibold" colSpan={2}>
                  {totalLabel}
                </td>
                <td className="px-3 py-2 text-end font-mono font-semibold">
                  {kwd(section.total)} KWD
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
            className="block border border-border rounded px-3 py-2 text-base sm:text-sm"
          />
        </label>
        <div className="flex gap-2 ms-auto">
          <button
            type="button"
            onClick={exportCsv}
            disabled={!data}
            className="px-3 py-2 border border-border rounded text-sm disabled:opacity-40"
          >
            {t('exportCsv')}
          </button>
          <button
            type="button"
            disabled={!data || exportingXlsx}
            onClick={async () => {
              setExportingXlsx(true);
              try {
                await downloadXlsx(
                  `/api/v1/stores/${storeId}/finance/reports/balance-sheet.xlsx?asOf=${asOf}`,
                  `balance-sheet-${asOf}.xlsx`
                );
              } finally {
                setExportingXlsx(false);
              }
            }}
            className="px-3 py-2 border border-border rounded text-sm disabled:opacity-40"
          >
            {exportingXlsx ? t('exporting') : t('exportXlsx')}
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {data && !loading && (
        <div className="space-y-6 max-w-2xl">
          {renderSection(tbs('assets'), data.assets, tbs('totalAssets'))}
          {renderSection(tbs('liabilities'), data.liabilities, tbs('totalLiabilities'))}
          {renderSection(tbs('equity'), data.equity, tbs('totalEquity'))}
          {balanced && <p className="text-sm text-green-700">{tbs('balanced')}</p>}
        </div>
      )}
    </div>
  );
}

function TaxReportTab({ storeId }: { storeId: string }) {
  const t = useT('finance.reports');
  const tt = useT('finance.reports.taxReport');
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayIso());
  const [data, setData] = useState<TaxReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);

  const fetchReport = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet<TaxReportData>(
      `/api/v1/stores/${storeId}/finance/reports/tax-report?from=${from}&to=${to}`
    )
      .then(({ data: d, error: apiError }) => {
        if (apiError) setError(apiError.message);
        else setData(d ?? null);
      })
      .catch(() => setError('Failed to load tax report'))
      .finally(() => setLoading(false));
  }, [storeId, from, to]);

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
      kwd(r.subtotal),
      `${r.taxRate}%`,
      kwd(r.taxCollected),
      r.total === null ? '' : kwd(r.total),
    ]);
    downloadCsv(`tax-report-${from}-to-${to}.csv`, [header, ...rows]);
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
            className="block border border-border rounded px-3 py-2 text-base sm:text-sm"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('to')}</span>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            className="block border border-border rounded px-3 py-2 text-base sm:text-sm"
          />
        </label>
        <div className="flex gap-2 ms-auto">
          <button
            type="button"
            onClick={exportCsv}
            disabled={!data || data.rows.length === 0}
            className="px-3 py-2 border border-border rounded text-sm disabled:opacity-40"
          >
            {t('exportCsv')}
          </button>
          <button
            type="button"
            disabled={!data || data.rows.length === 0 || exportingXlsx}
            onClick={async () => {
              setExportingXlsx(true);
              try {
                await downloadXlsx(
                  `/api/v1/stores/${storeId}/finance/reports/tax-report.xlsx?from=${from}&to=${to}`,
                  `tax-report-${from}-to-${to}.xlsx`
                );
              } finally {
                setExportingXlsx(false);
              }
            }}
            className="px-3 py-2 border border-border rounded text-sm disabled:opacity-40"
          >
            {exportingXlsx ? t('exporting') : t('exportXlsx')}
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {data && !loading && (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-xl border border-border p-4">
              <p className="text-xs text-muted-foreground mb-1">{tt('transactionCount')}</p>
              <p className="text-2xl font-semibold font-mono">{data.summary.transactionCount}</p>
            </div>
            <div className="rounded-xl border border-border p-4">
              <p className="text-xs text-muted-foreground mb-1">{tt('totalTaxableSales')}</p>
              <p className="text-2xl font-semibold font-mono">
                {kwd(data.summary.totalTaxableSales)} KWD
              </p>
            </div>
            <div className="rounded-xl border border-border p-4 bg-amber-50 border-amber-200">
              <p className="text-xs text-muted-foreground mb-1">{tt('totalTaxCollected')}</p>
              <p className="text-2xl font-semibold font-mono text-amber-800">
                {kwd(data.summary.totalTaxCollected)} KWD
              </p>
            </div>
          </div>

          {/* By-rate breakdown */}
          {data.summary.byRate.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2">{tt('byRateBreakdown')}</h3>
              <div className="rounded-xl border border-border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                        {tt('taxRate')}
                      </th>
                      <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                        {tt('transactions')}
                      </th>
                      <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                        {tt('taxableBase')} (KWD)
                      </th>
                      <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                        {tt('taxCollected')} (KWD)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.summary.byRate.map((r, i) => (
                      <tr key={i} className="border-t border-border/40">
                        <td className="px-3 py-2 font-mono">{r.taxRate}%</td>
                        <td className="px-3 py-2 text-end font-mono">{r.transactionCount}</td>
                        <td className="px-3 py-2 text-end font-mono">{kwd(r.totalSubtotal)}</td>
                        <td className="px-3 py-2 text-end font-mono font-semibold text-amber-800">
                          {kwd(r.totalTaxCollected)}
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
              <div className="rounded-xl border border-border overflow-hidden">
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
                          {tt('taxableBase')} (KWD)
                        </th>
                        <th className="text-end px-3 py-2 font-medium text-muted-foreground w-20">
                          {tt('taxRate')}
                        </th>
                        <th className="text-end px-3 py-2 font-medium text-muted-foreground w-28">
                          {tt('taxCollected')} (KWD)
                        </th>
                        <th className="text-end px-3 py-2 font-medium text-muted-foreground w-28">
                          {tt('orderTotal')} (KWD)
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row, i) => (
                        <tr key={i} className="border-t border-border/40">
                          <td className="px-3 py-2 text-xs">
                            {row.kind === 'sale' ? tt('kindSale') : tt('kindReversal')}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">{row.date}</td>
                          <td className="px-3 py-2 font-mono text-xs">{row.orderNumber}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {row.customerName ?? <span className="italic">{tt('guest')}</span>}
                          </td>
                          <td className="px-3 py-2 text-end font-mono">{kwd(row.subtotal)}</td>
                          <td className="px-3 py-2 text-end font-mono">{row.taxRate}%</td>
                          <td className="px-3 py-2 text-end font-mono font-semibold text-amber-800">
                            {kwd(row.taxCollected)}
                          </td>
                          <td className="px-3 py-2 text-end font-mono">
                            {row.total === null ? '—' : kwd(row.total)}
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
                          {kwd(data.summary.totalTaxableSales)}
                        </td>
                        <td />
                        <td className="px-3 py-2 text-end font-mono font-semibold text-amber-800">
                          {kwd(data.summary.totalTaxCollected)}
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
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {storeId && (
          <>
            {tab === 'trialBalance' && <TrialBalanceTab storeId={storeId} />}
            {tab === 'pnl' && <PnlTab storeId={storeId} />}
            {tab === 'balanceSheet' && <BalanceSheetTab storeId={storeId} />}
            {tab === 'taxReport' && <TaxReportTab storeId={storeId} />}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
