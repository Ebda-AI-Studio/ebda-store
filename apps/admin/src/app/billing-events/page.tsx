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
 * Two more tabs live here: "Subscriptions" (who is on trial / due / overdue /
 * paused, with a manual-payment action) and "Payment claims" (the InstaPay
 * "I paid" queue, confirmed or rejected by hand).
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's requireRole).
 */

import { formatDate } from '@/lib/format';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { formatMoney, withNumerals } from '@ebda/shared';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { DataTable, type DataTableColumn } from '../../components/mobile/DataTable';
import { apiGet, apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { useConfirm } from '@/hooks/useConfirm';
import { useLatestRequest } from '../../hooks/useLatestRequest';
import { ClaimsPanel } from './_components/ClaimsPanel';
import { ManualPaymentForm, type ManualPaymentPrefill } from './_components/ManualPaymentForm';
import { ManualRefundForm, type ManualRefundTarget } from './_components/ManualRefundForm';
import { GrantsPanel } from './_components/GrantsPanel';
import { SubscriptionsPanel } from './_components/SubscriptionsPanel';

interface LedgerRow {
  id: string;
  storeId: string;
  storeName: string;
  type: 'checkout' | 'renewal' | 'upgrade' | 'refund' | 'card_setup' | 'manual_payment';
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
  /** Ebda VAT inside amountMinor (0 = none) + snapshot with Ebda's TRN. */
  vatMinor?: number;
  vat?: { rateBps: number; trn: string | null } | null;
  /** FOLD-VAT: D1 tax / ETA columns; null for a row read off the old store. All empty while Ebda VAT is off. */
  tax?: {
    netMinor: number;
    grossMinor: number;
    vatRateBp: number;
    buyerTaxId: string | null;
    etaStatus: 'not_submitted' | 'submitted' | 'accepted' | 'rejected';
    etaSubmittedAt: string | null;
    etaRejectionReason: string | null;
  } | null;
}

const STATUS_FILTERS = ['', 'pending', 'succeeded', 'failed', 'refunded'] as const;
const TYPE_FILTERS = [
  '',
  'checkout',
  'renewal',
  'upgrade',
  'refund',
  'card_setup',
  'manual_payment',
] as const;
const TABS = ['ledger', 'subscriptions', 'claims', 'grants'] as const;

function statusVariant(s: string): 'success' | 'warning' | 'destructive' | 'default' {
  if (s === 'succeeded') return 'success';
  if (s === 'failed') return 'destructive';
  if (s === 'pending') return 'warning';
  return 'default';
}

function LedgerPanel({
  refreshSignal,
  onRecordRefund,
}: {
  refreshSignal: number;
  onRecordRefund: (target: ManualRefundTarget) => void;
}) {
  const t = useT('billingEvents');
  const askConfirm = useConfirm();
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
  }, [fetchRows, refreshKey, refreshSignal]);

  async function refund(row: LedgerRow, keepAccess = false) {
    const amount = formatMoney(row.amountMinor, locale, { fixedDecimals: true });
    const ok = await askConfirm({
      object: t('refundObject', { amount }),
      consequence: t(keepAccess ? 'confirmRefundKeepAccess' : 'confirmRefund', { amount }),
      confirmLabel: t('refundAction'),
    });
    if (!ok) return;
    setBusy(row.id);
    setMessage(null);
    const res = await apiPost(
      `/api/v1/admin/billing/events/${row.id}/refund`,
      keepAccess ? { keepAccess: true } : {}
    );
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
        <span className="text-muted-foreground">
          {new Date(r.createdAt).toLocaleString(undefined, withNumerals())}
        </span>
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
          {formatMoney(r.amountMinor, locale, { fixedDecimals: true })}
          {r.vat && (r.vatMinor ?? 0) > 0 && (
            <span className="block text-xs text-muted-foreground">
              {t('vatLine', {
                rate: r.vat.rateBps / 100,
                vat: formatMoney(r.vatMinor ?? 0, locale, { fixedDecimals: true }),
                trn: r.vat.trn ?? '',
              })}
            </span>
          )}
          {r.tax && r.vat && (r.vatMinor ?? 0) > 0 && (
            <span className="block text-xs text-muted-foreground">
              {t('vatBreakdown', {
                net: formatMoney(r.tax.netMinor, locale, { fixedDecimals: true }),
                vat: formatMoney(r.vatMinor ?? 0, locale, { fixedDecimals: true }),
                gross: formatMoney(r.tax.grossMinor, locale, { fixedDecimals: true }),
              })}
              {r.tax.buyerTaxId ? ` · ${t('buyerTaxId', { id: r.tax.buyerTaxId })}` : ''}
            </span>
          )}
        </span>
      ),
    },
    {
      header: t('columns.eta'),
      hideOnMobile: true,
      cell: r => {
        // Empty while Ebda VAT is off: nothing is submitted, so nothing to show.
        if (!r.tax || (r.tax.etaStatus === 'not_submitted' && (r.vatMinor ?? 0) === 0)) return '';
        return (
          <span className="block max-w-[200px] text-xs">
            <Badge
              variant={
                r.tax.etaStatus === 'accepted'
                  ? 'success'
                  : r.tax.etaStatus === 'rejected'
                    ? 'destructive'
                    : r.tax.etaStatus === 'submitted'
                      ? 'warning'
                      : 'default'
              }
            >
              {t(`etaStatuses.${r.tax.etaStatus}`)}
            </Badge>
            {r.tax.etaSubmittedAt && (
              <span className="block text-muted-foreground">
                {t('etaSubmittedAt', {
                  date: formatDate(r.tax.etaSubmittedAt),
                })}
              </span>
            )}
            {r.tax.etaRejectionReason && (
              <span className="block text-destructive-ink" title={r.tax.etaRejectionReason}>
                {t('etaRejected', { reason: r.tax.etaRejectionReason })}
              </span>
            )}
          </span>
        );
      },
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
        r.status === 'succeeded' && r.type === 'manual_payment' ? (
          // Money recorded by hand went back by hand too: record it, never call a gateway.
          <Button
            variant="outline"
            size="sm"
            className="max-md:min-h-11 max-md:px-4"
            onClick={() => onRecordRefund({ eventId: r.id, storeName: r.storeName })}
          >
            {t('recordRefund')}
          </Button>
        ) : r.status === 'succeeded' && r.type !== 'refund' && r.providerRef ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="max-md:min-h-11 max-md:px-4"
              disabled={busy === r.id}
              onClick={() => refund(r)}
            >
              {t('refund')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="max-md:min-h-11 max-md:px-4"
              disabled={busy === r.id}
              onClick={() => refund(r, true)}
            >
              {t('refundKeepAccess')}
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div>
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
            <Button
              variant={current === o ? 'soft' : 'ghost'}
              size="sm"
              key={o || 'all'}
              onClick={() => set(o)}
            >
              {o ? t(`${ns}.${o}`) : t('all')}
            </Button>
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
  );
}

function BillingEventsInner() {
  const t = useT('billingEvents');
  const [tab, setTab] = useState<(typeof TABS)[number]>('ledger');
  const [refreshKey, setRefreshKey] = useState(0);
  const [form, setForm] = useState<ManualPaymentPrefill | null>(null);
  const [refundTarget, setRefundTarget] = useState<ManualRefundTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="p-4 sm:p-6">
        <div role="tablist" aria-label={t('title')} className="mb-4 flex flex-wrap gap-2">
          {TABS.map(k => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`rounded-full px-4 py-1.5 text-sm max-md:min-h-11 ${
                tab === k ? 'bg-foreground text-background' : 'bg-muted text-foreground'
              }`}
            >
              {t(`tabs.${k}`)}
            </button>
          ))}
        </div>

        {message && (
          <div
            role="status"
            className="mb-3 rounded-md bg-primary/10 px-3 py-2 text-sm text-primary-ink"
          >
            {message}
          </div>
        )}

        {tab === 'ledger' && (
          <LedgerPanel refreshSignal={refreshKey} onRecordRefund={setRefundTarget} />
        )}
        {tab === 'subscriptions' && (
          <SubscriptionsPanel refreshKey={refreshKey} onRecordPayment={setForm} />
        )}
        {tab === 'grants' && <GrantsPanel refreshKey={refreshKey} />}
        {tab === 'claims' && (
          <ClaimsPanel
            refreshKey={refreshKey}
            onConfirm={setForm}
            onChanged={m => {
              setMessage(m);
              setRefreshKey(k => k + 1);
            }}
          />
        )}

        {refundTarget && (
          <ManualRefundForm
            target={refundTarget}
            onClose={() => setRefundTarget(null)}
            onDone={(outcome, voidedEventId) => {
              setRefundTarget(null);
              setMessage(
                voidedEventId
                  ? t('manualRefund.voidedFreed', { id: voidedEventId })
                  : t(outcome === 'duplicate' ? 'manualRefund.duplicate' : 'manualRefund.done')
              );
              setRefreshKey(k => k + 1);
            }}
          />
        )}

        {form && (
          <ManualPaymentForm
            prefill={form}
            onClose={() => setForm(null)}
            onDone={outcome => {
              setForm(null);
              setMessage(t(outcome === 'duplicate' ? 'manual.duplicate' : 'manual.recorded'));
              setRefreshKey(k => k + 1);
            }}
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
