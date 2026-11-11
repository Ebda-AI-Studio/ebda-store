'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@ebda/shared';
import { DataTable, type DataTableColumn } from '../../../components/mobile/DataTable';
import { apiGet } from '../../../lib/api';
import { useT } from '../../../i18n/useT';
import { useLatestRequest } from '../../../hooks/useLatestRequest';
import { fmtDate } from '../../../components/billing/format';
import type { ManualPaymentPrefill } from './ManualPaymentForm';

export interface SubscriptionRow {
  storeId: string;
  storeName: string;
  storeSlug: string;
  storeStatus: string;
  planCode: string;
  chosenPlanCode: string | null;
  billingInterval: 'monthly' | 'yearly';
  status: string;
  trialEndsAt: string | null;
  card: { last4: string | null; brand: string | null; savedAt: string | null } | null;
  provider: string;
  billingMethod: 'card' | 'instapay' | null;
  paymentReference: string | null;
  suspendedReason: 'unpaid' | 'over_store_limit' | null;
  dunningAttempts: number;
  nextRetryAt: string | null;
  currentPeriodEnd: string | null;
  nextCharge: { at: string; planCode: string; amountMinor: number | null } | null;
}

const VIEWS = ['', 'due', 'overdue', 'suspended'] as const;

function statusVariant(s: string): 'success' | 'warning' | 'destructive' | 'info' | 'default' {
  if (s === 'active') return 'success';
  if (s === 'past_due') return 'destructive';
  if (s === 'trialing' || s === 'comped') return 'info';
  return 'default';
}

/** Super-admin "Subscriptions" view: who is on trial, due, overdue or paused for non-payment. */
export function SubscriptionsPanel({
  refreshKey,
  onRecordPayment,
}: {
  refreshKey: number;
  onRecordPayment: (prefill: ManualPaymentPrefill) => void;
}) {
  const t = useT('billingEvents.subscriptions');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [view, setView] = useState<(typeof VIEWS)[number]>('');
  const [rows, setRows] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const beginRequest = useLatestRequest();

  const fetchRows = useCallback(async () => {
    const isLatest = beginRequest();
    setLoading(true);
    const { data, error } = await apiGet<{ subscriptions: SubscriptionRow[] }>(
      `/api/v1/admin/billing/subscriptions${view ? `?view=${view}` : ''}`
    );
    if (!isLatest()) return;
    setLoadError(!!error);
    setRows(data?.subscriptions ?? []);
    setLoading(false);
  }, [view, beginRequest]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows, refreshKey]);

  const columns: DataTableColumn<SubscriptionRow>[] = [
    {
      header: t('columns.store'),
      primaryOnMobile: true,
      cell: r => (
        <span>
          <span className="font-medium text-foreground">{r.storeName}</span>
          <span dir="ltr" className="block text-xs text-muted-foreground">
            {r.storeSlug}
          </span>
        </span>
      ),
    },
    {
      header: t('columns.plan'),
      cell: r => <span>{r.planCode}</span>,
    },
    {
      header: t('columns.chosenPlan'),
      cell: r => (
        <span className="text-muted-foreground">
          {r.chosenPlanCode ?? '—'} · {t(`interval.${r.billingInterval}`)}
        </span>
      ),
    },
    {
      header: t('columns.method'),
      cell: r => (
        <span className="text-muted-foreground">
          {r.billingMethod ? t(`methods.${r.billingMethod}`) : '—'}
          {r.paymentReference ? (
            <span dir="ltr" className="block text-xs">
              {r.paymentReference}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: r => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={statusVariant(r.status)}>{t(`statuses.${r.status}`)}</Badge>
          {r.suspendedReason && (
            <Badge variant="destructive">{t(`suspended.${r.suspendedReason}`)}</Badge>
          )}
        </span>
      ),
    },
    {
      header: t('columns.trialEnds'),
      hideOnMobile: true,
      cell: r => (
        <span className="text-muted-foreground">{fmtDate(r.trialEndsAt, locale) || '—'}</span>
      ),
    },
    {
      header: t('columns.card'),
      hideOnMobile: true,
      cell: r => (
        <span dir="ltr" className="text-muted-foreground">
          {r.card?.last4 ? `•••• ${r.card.last4}` : '—'}
        </span>
      ),
    },
    {
      header: t('columns.nextCharge'),
      cell: r =>
        r.nextCharge ? (
          <span className="tabular-nums">
            {fmtDate(r.nextCharge.at, locale)}
            {r.nextCharge.amountMinor !== null
              ? ` · ${formatMoney(r.nextCharge.amountMinor, locale, { fixedDecimals: true })}`
              : ''}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      header: t('columns.action'),
      mobileActions: true,
      cell: r => (
        <Button
          variant="outline"
          size="sm"
          className="max-md:min-h-11 max-md:px-4"
          onClick={() =>
            onRecordPayment({
              storeId: r.storeId,
              storeName: r.storeName,
              planCode: r.chosenPlanCode ?? r.planCode,
              interval: r.billingInterval,
              amountMinor: r.nextCharge?.amountMinor ?? null,
              method: r.billingMethod === 'instapay' ? 'instapay' : 'bank',
              reference: '',
            })
          }
        >
          {t('record')}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('viewFilter')}</span>
        {VIEWS.map(v => (
          <Button
            variant={view === v ? 'soft' : 'ghost'}
            size="sm"
            key={v || 'all'}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {t(`views.${v || 'all'}`)}
          </Button>
        ))}
      </div>
      {loading ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
          {t('loading')}
        </div>
      ) : (
        <DataTable<SubscriptionRow>
          ariaLabel={t('title')}
          columns={columns}
          rows={rows}
          rowKey={r => r.storeId}
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
