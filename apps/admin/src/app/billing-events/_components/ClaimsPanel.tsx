'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Button, Input, Modal } from '@force/ui';
import { formatMoney } from '@force/shared';
import { DataTable, type DataTableColumn } from '../../../components/mobile/DataTable';
import { apiGet, apiPost } from '../../../lib/api';
import { useT } from '../../../i18n/useT';
import { useLatestRequest } from '../../../hooks/useLatestRequest';
import { fmtDate } from '../../../components/billing/format';
import type { ManualPaymentPrefill } from './ManualPaymentForm';

export interface ClaimRow {
  id: string;
  storeId: string;
  storeName: string;
  storeSlug: string;
  storeStatus: string;
  planCode: string;
  billingInterval: 'monthly' | 'yearly';
  amountMinor: number;
  method: string;
  paymentReference: string | null;
  payerReference: string;
  proofUrl: string | null;
  status: 'pending' | 'confirmed' | 'rejected';
  createdAt: string;
}

const STATUSES = ['pending', 'confirmed', 'rejected'] as const;

/** Super-admin "Payment claims" queue: "I paid by InstaPay" notes waiting for a human to confirm. */
export function ClaimsPanel({
  refreshKey,
  onConfirm,
  onChanged,
}: {
  refreshKey: number;
  /** Opens the manual-payment form prefilled from the claim. */
  onConfirm: (prefill: ManualPaymentPrefill) => void;
  onChanged: (message: string) => void;
}) {
  const t = useT('billingEvents.claims');
  const tCommon = useT('common');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('pending');
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [rejecting, setRejecting] = useState<ClaimRow | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [busy, setBusy] = useState(false);
  const beginRequest = useLatestRequest();

  const fetchRows = useCallback(async () => {
    const isLatest = beginRequest();
    setLoading(true);
    const { data, error } = await apiGet<{ claims: ClaimRow[] }>(
      `/api/v1/admin/billing/claims?status=${status}`
    );
    if (!isLatest()) return;
    setLoadError(!!error);
    setRows(data?.claims ?? []);
    setLoading(false);
  }, [status, beginRequest]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows, refreshKey]);

  function confirm(r: ClaimRow) {
    onConfirm({
      storeId: r.storeId,
      storeName: r.storeName,
      planCode: r.planCode,
      interval: r.billingInterval,
      amountMinor: r.amountMinor,
      method: 'instapay',
      reference: r.payerReference,
      claimId: r.id,
    });
  }

  async function reject() {
    if (!rejecting) return;
    if (!note.trim()) {
      setNoteError(t('noteRequired'));
      return;
    }
    setBusy(true);
    const { error } = await apiPost(`/api/v1/admin/billing/claims/${rejecting.id}/reject`, {
      storeId: rejecting.storeId,
      note: note.trim(),
    });
    setBusy(false);
    if (error) {
      setNoteError(t('rejectFailed'));
      return;
    }
    setRejecting(null);
    setNote('');
    setNoteError('');
    onChanged(t('rejected'));
    void fetchRows();
  }

  const columns: DataTableColumn<ClaimRow>[] = [
    {
      header: t('columns.date'),
      cell: r => <span className="text-muted-foreground">{fmtDate(r.createdAt, locale)}</span>,
    },
    {
      header: t('columns.store'),
      primaryOnMobile: true,
      cell: r => <span className="font-medium text-foreground">{r.storeName}</span>,
    },
    {
      header: t('columns.plan'),
      cell: r => (
        <span className="text-muted-foreground">
          {r.planCode} · {t(`interval.${r.billingInterval}`)}
        </span>
      ),
    },
    {
      header: t('columns.amount'),
      cell: r => <span className="tabular-nums">{formatMoney(r.amountMinor, locale)}</span>,
    },
    {
      header: t('columns.payerReference'),
      cell: r => (
        <span dir="ltr" className="break-all">
          {r.payerReference}
          {r.proofUrl && (
            <a
              href={r.proofUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="ms-2 text-primary-ink underline"
            >
              {t('proof')}
            </a>
          )}
        </span>
      ),
    },
    {
      header: t('columns.reference'),
      hideOnMobile: true,
      cell: r => (
        <span dir="ltr" className="text-muted-foreground">
          {r.paymentReference ?? '—'}
        </span>
      ),
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: r => (
        <Badge
          variant={
            r.status === 'confirmed'
              ? 'success'
              : r.status === 'rejected'
                ? 'destructive'
                : 'warning'
          }
        >
          {t(`statuses.${r.status}`)}
        </Badge>
      ),
    },
    {
      header: t('columns.action'),
      mobileActions: true,
      cell: r =>
        r.status === 'pending' ? (
          <span className="flex flex-wrap gap-2">
            <Button size="sm" className="max-md:min-h-11 max-md:px-4" onClick={() => confirm(r)}>
              {t('confirm')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="max-md:min-h-11 max-md:px-4"
              onClick={() => {
                setRejecting(r);
                setNote('');
                setNoteError('');
              }}
            >
              {t('reject')}
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('statusFilter')}</span>
        {STATUSES.map(s => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-sm ${
              status === s ? 'bg-foreground text-background' : 'bg-muted text-foreground'
            }`}
          >
            {t(`statuses.${s}`)}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
          {t('loading')}
        </div>
      ) : (
        <DataTable<ClaimRow>
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
      {rejecting && (
        <Modal
          isOpen
          onClose={() => setRejecting(null)}
          title={t('rejectTitle', { store: rejecting.storeName })}
        >
          <form
            className="space-y-3 p-4 sm:p-6"
            noValidate
            onSubmit={e => {
              e.preventDefault();
              void reject();
            }}
          >
            <Input
              id="reject-note"
              label={t('note')}
              value={note}
              onChange={e => setNote(e.target.value)}
              error={noteError || undefined}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRejecting(null)}>
                {tCommon('cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {t('rejectSubmit')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
