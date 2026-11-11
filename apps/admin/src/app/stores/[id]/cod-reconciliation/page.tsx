'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@ebda/ui';
import { useLocale } from 'next-intl';
import { AdminLayout } from '../../../../components/AdminLayout';
import { OrderStatusBadge } from '../../../../components/OrderStatusBadge';
import { apiGet, apiPost } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { ShippingTabs } from '../shipping/_components/ShippingTabs';
import { formatMoney } from '../orders/[orderId]/_components/format';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';

type ReconStatus = 'awaiting' | 'partial' | 'settled' | 'over_remitted' | 'mismatch';

interface ReconRow {
  shipmentId: string;
  orderNumber: string;
  carrier: string;
  carrierName: string | null;
  trackingNumber: string | null;
  shipmentStatus: string;
  lines: Array<{
    id: string;
    grossAmount: number;
    feeAmount: number;
    netAmount: number;
    remittedAt: string;
    batchId: string | null;
  }>;
  result: {
    status: ReconStatus;
    owed: number;
    gross: number;
    fees: number;
    net: number;
    outstanding: number;
    over: number;
    flagged: boolean;
  };
}

interface Report {
  summary: {
    shipments: number;
    owed: number;
    gross: number;
    fees: number;
    net: number;
    outstanding: number;
    over: number;
    unmatchedGross: number;
    unmatchedLines: number;
    flaggedShipments: number;
  };
  rows: ReconRow[];
  total: number;
  unmatched: Array<{
    id: string;
    carrier: string;
    trackingNumber: string;
    grossAmount: number;
    feeAmount: number;
    netAmount: number;
    remittedAt: string;
  }>;
}

interface ImportResult {
  inserted: number;
  duplicates: number;
  unmatched: number;
  rejected: Array<{ line: number; reason: string }>;
}

const CARRIERS = ['bosta', 'shipblu', 'mylerz', 'aramex', 'manual'];
const STATUS_COLORS = {
  awaiting: { className: 'bg-muted text-foreground' },
  partial: { className: 'bg-warning/10 text-warning-ink' },
  settled: { className: 'bg-success/10 text-success-ink' },
  over_remitted: { className: 'bg-destructive/10 text-destructive-ink' },
  mismatch: { className: 'bg-destructive/10 text-destructive-ink' },
} as const;
const PAGE_SIZE = 25;

/**
 * COD reconciliation: what each carrier should have collected for the store's COD shipments
 * against what its settlement statements say it collected, kept as fees and remitted, all in
 * piastres. A statement is uploaded as a CSV (every carrier's portal can export one); partial
 * remittances add up, mismatches are flagged, and the totals bar reconciles to the piastre:
 * owed - collected = outstanding - over-remitted.
 */
export default function CodReconciliationPage() {
  const { gate } = useRequireFeature('shipping_carriers');
  const params = useParams();
  const storeId = params.id as string;
  const t = useT('codReconciliation');
  const tHub = useT('shippingHub');
  const tStatus = useT('shipping.carriers.shipments');
  const locale = useLocale();
  const { success: toastSuccess, error: toastError } = useToast();

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [carrierFilter, setCarrierFilter] = useState('');
  const [page, setPage] = useState(1);
  const [importCarrier, setImportCarrier] = useState('bosta');
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (status) qs.set('status', status);
    if (carrierFilter) qs.set('carrier', carrierFilter);
    const { data } = await apiGet<Report>(`/api/v1/stores/${storeId}/cod-reconciliation?${qs}`);
    if (data) setReport(data);
    setLoading(false);
  }, [storeId, page, status, carrierFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const onFile = async (file: File | undefined) => {
    if (file) setCsv(await file.text());
  };

  const doImport = async () => {
    setImporting(true);
    setResult(null);
    try {
      const { data, error } = await apiPost<ImportResult>(
        `/api/v1/stores/${storeId}/cod-reconciliation/import`,
        { carrier: importCarrier, csv }
      );
      if (error || !data) {
        toastError(t('errorTitle'), error?.message || t('importFailed'));
        return;
      }
      setResult(data);
      toastSuccess(t('imported', { count: data.inserted }), '');
      setCsv('');
      await load();
    } finally {
      setImporting(false);
    }
  };

  if (gate) return gate;

  const s = report?.summary;
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { numberingSystem: 'latn' });
  const carrierName = (row: { carrier: string; carrierName?: string | null }) =>
    row.carrier === 'manual' && row.carrierName
      ? row.carrierName
      : tStatus(`carrierNames.${row.carrier}`);
  const pages = Math.max(1, Math.ceil((report?.total ?? 0) / PAGE_SIZE));

  const stat = (label: string, value: number, tone?: 'warn' | 'bad') => (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold ${
          tone === 'bad'
            ? 'text-destructive-ink'
            : tone === 'warn'
              ? 'text-warning-ink'
              : 'text-foreground'
        }`}
      >
        {formatMoney(value)}
      </p>
    </div>
  );

  return (
    <AdminLayout title={tHub('title')} subtitle={t('subtitle')}>
      <ShippingTabs />
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : (
        <div className="space-y-6">
          {s && (
            <section aria-label={t('totals')}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {stat(t('owed'), s.owed)}
                {stat(t('collected'), s.gross)}
                {stat(t('fees'), s.fees)}
                {stat(t('net'), s.net)}
                {stat(t('outstanding'), s.outstanding, s.outstanding > 0 ? 'warn' : undefined)}
                {stat(t('over'), s.over, s.over > 0 ? 'bad' : undefined)}
                {stat(t('unmatched'), s.unmatchedGross, s.unmatchedGross > 0 ? 'warn' : undefined)}
                <div className="rounded-xl border border-border bg-card p-4">
                  <p className="text-xs text-muted-foreground">{t('flagged')}</p>
                  <p className="mt-1 text-lg font-semibold text-foreground">{s.flaggedShipments}</p>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t('identity')}</p>
            </section>
          )}

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-base font-semibold text-foreground">{t('importTitle')}</h2>
            <p className="text-sm text-muted-foreground mt-1">{t('importHelp')}</p>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="text-sm">
                <span className="text-muted-foreground">{t('carrier')}</span>
                <select
                  value={importCarrier}
                  onChange={e => setImportCarrier(e.target.value)}
                  className={`${FIELD_CLASSES} mt-1`}
                >
                  {CARRIERS.map(c => (
                    <option key={c} value={c}>
                      {tStatus(`carrierNames.${c}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm md:col-span-2">
                <span className="text-muted-foreground">{t('file')}</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={e => void onFile(e.target.files?.[0])}
                  className="mt-1 block w-full text-sm"
                />
              </label>
            </div>
            <textarea
              value={csv}
              onChange={e => setCsv(e.target.value)}
              rows={4}
              placeholder={t('pastePlaceholder')}
              aria-label={t('paste')}
              className={`${TEXTAREA_CLASSES} mt-3 font-mono`}
            />
            <Button
              variant="default"
              size="md"
              className="mt-3"
              type="button"
              onClick={doImport}
              disabled={importing || !csv.trim()}
            >
              {t('import')}
            </Button>
            {result && (
              <div className="mt-3 text-sm text-foreground" role="status">
                <p>
                  {t('importResult', {
                    inserted: result.inserted,
                    duplicates: result.duplicates,
                    unmatched: result.unmatched,
                  })}
                </p>
                {result.rejected.length > 0 && (
                  <ul className="mt-1 text-destructive-ink list-disc ps-5">
                    {result.rejected.map(r => (
                      <li key={`${r.line}-${r.reason}`}>
                        {t('rejectedLine', { line: r.line, reason: r.reason })}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <select
                value={status}
                onChange={e => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                aria-label={t('filterStatus')}
                className={FIELD_CLASSES}
              >
                <option value="">{t('allStatuses')}</option>
                <option value="flagged">{t('statuses.flagged')}</option>
                {(['awaiting', 'partial', 'settled', 'over_remitted', 'mismatch'] as const).map(
                  k => (
                    <option key={k} value={k}>
                      {t(`statuses.${k}`)}
                    </option>
                  )
                )}
              </select>
              <select
                value={carrierFilter}
                onChange={e => {
                  setCarrierFilter(e.target.value);
                  setPage(1);
                }}
                aria-label={t('filterCarrier')}
                className={FIELD_CLASSES}
              >
                <option value="">{t('allCarriers')}</option>
                {CARRIERS.map(c => (
                  <option key={c} value={c}>
                    {tStatus(`carrierNames.${c}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <caption className="sr-only">{t('tableLabel')}</caption>
                <thead className="text-xs text-muted-foreground">
                  <tr className="text-start">
                    {[
                      'order',
                      'carrier',
                      'tracking',
                      'owed',
                      'collected',
                      'fees',
                      'net',
                      'open',
                      'status',
                    ].map(h => (
                      <th key={h} scope="col" className="px-3 py-2 text-start font-medium">
                        {t(`columns.${h}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report?.rows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                        {t('empty')}
                      </td>
                    </tr>
                  )}
                  {report?.rows.map(r => (
                    <tr key={r.shipmentId} className="border-t border-border align-top">
                      <td className="px-3 py-2 font-medium">{r.orderNumber}</td>
                      <td className="px-3 py-2">{carrierName(r)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.trackingNumber ?? '—'}</td>
                      <td className="px-3 py-2">{formatMoney(r.result.owed)}</td>
                      <td className="px-3 py-2">
                        {formatMoney(r.result.gross)}
                        {r.lines.length > 1 && (
                          <span className="block text-xs text-muted-foreground">
                            {t('lines', { count: r.lines.length })}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{formatMoney(r.result.fees)}</td>
                      <td className="px-3 py-2">{formatMoney(r.result.net)}</td>
                      <td className="px-3 py-2">
                        {r.result.over > 0
                          ? `+${formatMoney(r.result.over)}`
                          : formatMoney(r.result.outstanding)}
                      </td>
                      <td className="px-3 py-2">
                        <OrderStatusBadge
                          status={r.result.status}
                          namespace="codReconciliation.statuses"
                          colorMap={STATUS_COLORS}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pages > 1 && (
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('page', { page, pages })}</span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    {t('previous')}
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => setPage(p => Math.min(pages, p + 1))}
                    disabled={page === pages}
                  >
                    {t('next')}
                  </Button>
                </div>
              </div>
            )}
          </section>

          {report && report.unmatched.length > 0 && (
            <section>
              <h2 className="text-base font-semibold text-foreground">{t('unmatchedTitle')}</h2>
              <p className="text-sm text-muted-foreground mt-1">{t('unmatchedHelp')}</p>
              <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-sm">
                  <caption className="sr-only">{t('unmatchedTitle')}</caption>
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      {['carrier', 'tracking', 'collected', 'fees', 'net', 'date'].map(h => (
                        <th key={h} scope="col" className="px-3 py-2 text-start font-medium">
                          {t(`columns.${h}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.unmatched.map(u => (
                      <tr key={u.id} className="border-t border-border">
                        <td className="px-3 py-2">{tStatus(`carrierNames.${u.carrier}`)}</td>
                        <td className="px-3 py-2 font-mono text-xs">{u.trackingNumber}</td>
                        <td className="px-3 py-2">{formatMoney(u.grossAmount)}</td>
                        <td className="px-3 py-2">{formatMoney(u.feeAmount)}</td>
                        <td className="px-3 py-2">{formatMoney(u.netAmount)}</td>
                        <td className="px-3 py-2">{fmtDate(u.remittedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </AdminLayout>
  );
}
