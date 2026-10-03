'use client';

/**
 * Super-admin Billing ledger — /billing-events (SP5 task 3).
 *
 * `billing_events` is the append-only record of every money attempt on
 * Ebda's own subscription billing: checkouts, renewals (incl. dunning
 * retries), upgrades and refunds, with the gateway reference and failure
 * reason. A charge whose outcome is unknown (pending for over an hour) is
 * flagged so an operator can reconcile it with the gateway; a succeeded charge
 * can be refunded (full or partial) from here.
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's requireRole).
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Button } from '@force/ui';
import { formatMoney } from '@force/shared';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { DataTable, type DataTableColumn } from '../../components/mobile/DataTable';
import { apiGet, apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { useLatestRequest } from '../../hooks/useLatestRequest';

interface LedgerRow {
  id: string;
  storeId: string;
  storeName: string;
  type: 'checkout' | 'renewal' | 'upgrade' | 'refund';
  planCode: string | null;
  billingInterval: string | null;
  amountMinor: number;
  provider: string;
  providerRef: string | null;
  idempotencyKey: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  failureReason: string | null;
  attempt: number;
  createdAt: string;
  stuck: boolean;
}

const STATUS_FILTERS = ['', 'pending', 'succeeded', 'failed', 'refunded'] as const;
const TYPE_FILTERS = ['', 'checkout', 'renewal', 'upgrade', 'refund'] as const;

function statusVariant(s: string): 'success' | 'warning' | 'destructive' | 'default' {
  if (s === 'succeeded') return 'success';
  if (s === 'failed') return 'destructive';
  if (s === 'pending') return 'warning';
  return 'default';
}

function BillingEventsInner() {
  const t = useT('billingEvents');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const beginRequest = useLatestRequest();

  const fetchRows = useCallback(async () => {
    const isLatest = beginRequest();
    setLoading(true);
    const qs = new URLSearchParams({ limit: '100' });
    if (status) qs.set('status', status);
    if (type) qs.set('type', type);
    const { data, error } = await apiGet<{ events: LedgerRow[] }>(
      `/api/v1/admin/billing/events?${qs.toString()}`
    );
    if (!isLatest()) return;
    setLoadError(!!error);
    setRows(data?.events ?? []);
    setLoading(false);
  }, [status, type, beginRequest]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows, refreshKey]);

  async function refund(row: LedgerRow) {
    if (!window.confirm(t('confirmRefund', { amount: formatMoney(row.amountMinor, locale) }))) {
      return;
    }
    setBusy(row.id);
    setMessage(null);
    const res = await apiPost(`/api/v1/admin/billing/events/${row.id}/refund`, {});
    setBusy(null);
    if (res.error) {
      setMessage(t('refundFailed', { message: res.error.message || 'error' }));
      return;
    }
    setMessage(t('refundDone'));
    setRefreshKey(k => k + 1);
  }

  const columns: DataTableColumn<LedgerRow>[] = [
    {
      header: t('columns.date'),
      cell: r => (
        <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
      ),
    },
    {
      header: t('columns.store'),
      primaryOnMobile: true,
      cell: r => <span className="font-medium text-foreground">{r.storeName}</span>,
    },
    {
      header: t('columns.type'),
      cell: r => (
        <span>
          {t(`types.${r.type}`)}
          {r.type === 'renewal' && r.attempt > 0 ? ` · ${t('retry', { n: r.attempt })}` : ''}
        </span>
      ),
    },
    {
      header: t('columns.plan'),
      hideOnMobile: true,
      cell: r => (
        <span className="text-muted-foreground">
          {r.planCode ?? '—'}
          {r.billingInterval ? ` · ${t(`interval.${r.billingInterval}`)}` : ''}
        </span>
      ),
    },
    {
      header: t('columns.amount'),
      cell: r => (
        <span className="tabular-nums">
          {r.type === 'refund' ? '−' : ''}
          {formatMoney(r.amountMinor, locale)}
        </span>
      ),
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: r => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={statusVariant(r.status)}>{t(`statuses.${r.status}`)}</Badge>
          {r.stuck && <Badge variant="warning">{t('stuck')}</Badge>}
        </span>
      ),
    },
    {
      header: t('columns.reference'),
      hideOnMobile: true,
      cell: r => (
        <span
          className="block max-w-[200px] truncate text-muted-foreground"
          title={r.idempotencyKey}
        >
          {r.provider} · {r.providerRef ?? '—'}
        </span>
      ),
    },
    {
      header: t('columns.failure'),
      hideOnMobile: true,
      cell: r => (
        <span
          className="block max-w-[220px] truncate text-destructive-ink"
          title={r.failureReason ?? ''}
        >
          {r.failureReason ?? '—'}
        </span>
      ),
    },
    {
      header: t('columns.action'),
      mobileActions: true,
      cell: r =>
        r.status === 'succeeded' && r.type !== 'refund' && r.providerRef ? (
          <Button
            variant="outline"
            size="sm"
            className="max-md:min-h-11 max-md:px-4"
            disabled={busy === r.id}
            onClick={() => refund(r)}
          >
            {t('refund')}
          </Button>
        ) : null,
    },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="p-4 sm:p-6">
        <div className="mb-4 flex items-center justify-end">
          <Button variant="outline" size="sm" onClick={() => setRefreshKey(k => k + 1)}>
            {t('refresh')}
          </Button>
        </div>

        {(
          [
            ['statusFilter', STATUS_FILTERS, status, setStatus, 'statuses'],
            ['typeFilter', TYPE_FILTERS, type, setType, 'types'],
          ] as const
        ).map(([label, options, current, set, ns]) => (
          <div key={label} className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t(label)}</span>
            {options.map(o => (
              <button
                key={o || 'all'}
                onClick={() => set(o)}
                className={`rounded-full px-3 py-1 text-sm ${
                  current === o ? 'bg-foreground text-background' : 'bg-muted text-foreground'
                }`}
              >
                {o ? t(`${ns}.${o}`) : t('all')}
              </button>
            ))}
          </div>
        ))}

        {message && (
          <div className="mb-3 rounded-md bg-primary/10 px-3 py-2 text-sm text-primary-ink">
            {message}
          </div>
        )}

        {loading ? (
          <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
            {t('loading')}
          </div>
        ) : (
          <DataTable<LedgerRow>
            ariaLabel={t('title')}
            columns={columns}
            rows={rows}
            rowKey={r => r.id}
            emptyState={
              loadError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-6 text-center text-destructive-ink"
                >
                  {t('failedToLoad')}
                </div>
              ) : (
                <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
                  {t('empty')}
                </div>
              )
            }
          />
        )}
      </div>
    </AdminLayout>
  );
}

export default function BillingEventsPage() {
  return (
    <RequireSuperAdmin>
      <BillingEventsInner />
    </RequireSuperAdmin>
  );
}
